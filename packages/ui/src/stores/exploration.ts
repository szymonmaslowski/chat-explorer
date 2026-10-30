import type {
  Comment,
  Exploration,
  ExplorationEvent,
  Fork,
  Message,
  MessageFile,
  QueuedSubmission,
  ReplyDraft,
  SessionStatus,
  Snapshot,
} from '@shared/types';
import { nextTick, reactive, watch } from 'vue';
import { api, ApiError } from '../api';
import { outbox, type Change } from './outbox';

export interface ExplorationState {
  explorationId: string;
  status: 'loading' | 'ready' | 'missing' | 'deleted' | 'error';
  exploration: Exploration | null;
  forks: Map<string, Fork>;
  messages: Map<string, Message>;
  comments: Map<string, Comment>;
  queuedSubmissions: Map<string, QueuedSubmission>;
  files: Map<string, MessageFile>;
  // As loaded; the reply box takes over from there and saves its own changes.
  replyDrafts: Map<string, ReplyDraft>;
  sessionStatus: SessionStatus;
  sessionError: string | null;
  connected: boolean;
}

const eventTypes: ExplorationEvent['type'][] = [
  'message.added',
  'fork.created',
  'fork.updated',
  'comment.created',
  'comment.updated',
  'comment.deleted',
  'submission.queued',
  'submission.cancelled',
  'submission.delivered',
  'files.updated',
  'files.released',
  'exploration.updated',
  'exploration.deleted',
  'session.status',
  'session.error',
];

const byId = <Item extends { id: string }>(items: Item[]) =>
  new Map(items.map((item) => [item.id, item]));

export function applyEvent(state: ExplorationState, event: ExplorationEvent) {
  switch (event.type) {
    case 'message.added':
      state.messages.set(event.message.id, event.message);
      state.forks.set(event.fork.id, event.fork);
      break;
    case 'fork.created':
    case 'fork.updated':
      state.forks.set(event.fork.id, event.fork);
      break;
    case 'comment.created':
    case 'comment.updated':
      state.comments.set(event.comment.id, event.comment);
      break;
    case 'comment.deleted':
      state.comments.delete(event.commentId);
      break;
    case 'submission.queued':
      state.queuedSubmissions.set(event.submission.id, event.submission);
      break;
    case 'submission.cancelled':
    case 'submission.delivered':
      state.queuedSubmissions.delete(event.submissionId);
      break;
    case 'files.updated':
      for (const file of event.files) state.files.set(file.id, file);
      break;
    case 'files.released':
      for (const fileId of event.fileIds) state.files.delete(fileId);
      break;
    case 'exploration.updated':
      state.exploration = event.exploration;
      break;
    case 'exploration.deleted':
      state.status = 'deleted';
      break;
    case 'session.status':
      state.sessionStatus = event.status;
      break;
    case 'session.error':
      state.sessionError = event.message;
      break;
    case 'session.attached':
      break;
  }
}

const changesComment = (change: Change, commentId: string) =>
  change.type === 'comment.create'
    ? change.comment.id === commentId
    : (change.type === 'comment.update' || change.type === 'comment.delete') &&
      change.commentId === commentId;

// The daemon's notice about a comment can arrive after a later change to it was made here, such
// as "created, being written" after Save. The changes it has not confirmed yet go on top again,
// so the notice cannot undo them.
export function applyServerEvent(state: ExplorationState, event: ExplorationEvent) {
  applyEvent(state, event);
  if (event.type !== 'comment.created' && event.type !== 'comment.updated') return;
  for (const change of outbox.changes.value) {
    if (changesComment(change, event.comment.id)) applyChange(state, change);
  }
}

const firstRetryMs = 1_000;
const maxRetryMs = 30_000;

// Shows a change before the daemon has it, as the daemon will once it does.
export function applyChange(state: ExplorationState, change: Change) {
  if (change.explorationId !== state.explorationId) return;
  const now = Date.now();
  switch (change.type) {
    case 'comment.create': {
      const { id, editBody, type, ...comment } = change.comment;
      const existing = state.comments.get(id);
      state.comments.set(id, {
        ...comment,
        id,
        explorationId: state.explorationId,
        editBody: editBody ?? null,
        type: type ?? 'inline',
        status: existing?.status ?? 'draft',
        submissionId: existing?.submissionId ?? null,
        replyMessageId: null,
        createdForkId: null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      break;
    }
    case 'comment.update': {
      const comment = state.comments.get(change.commentId);
      const { body, editBody, type } = change.changes;
      if (!comment) break;
      state.comments.set(comment.id, {
        ...comment,
        body: body ?? comment.body,
        editBody: editBody === undefined ? comment.editBody : editBody,
        type: type ?? comment.type,
        updatedAt: now,
      });
      break;
    }
    case 'comment.delete':
      state.comments.delete(change.commentId);
      break;
    case 'reply-draft.save':
      break;
    case 'submit': {
      const { id, forkId, globalMessage, newFork, files } = change.submission;
      state.queuedSubmissions.set(id, {
        id,
        explorationId: state.explorationId,
        forkId,
        globalMessage: globalMessage.trim(),
        newFork,
        createdAt: now,
      });
      for (const comment of state.comments.values()) {
        if (comment.viewForkId === forkId && comment.status === 'draft') {
          state.comments.set(comment.id, { ...comment, status: 'queued', submissionId: id });
        }
      }
      for (const file of files) state.files.set(file.id, { ...file, submissionId: id });
      break;
    }
    case 'fork-now': {
      const { submissionId: id, forkId, commentId } = change;
      state.queuedSubmissions.set(id, {
        id,
        explorationId: state.explorationId,
        forkId,
        globalMessage: '',
        newFork: false,
        createdAt: now,
      });
      const comment = state.comments.get(commentId);
      if (comment)
        state.comments.set(commentId, { ...comment, status: 'queued', submissionId: id });
      break;
    }
    case 'submission.cancel':
      state.queuedSubmissions.delete(change.submissionId);
      for (const comment of state.comments.values()) {
        if (comment.submissionId === change.submissionId) {
          state.comments.set(comment.id, { ...comment, status: 'draft', submissionId: null });
        }
      }
      for (const file of state.files.values()) {
        if (file.submissionId === change.submissionId) state.files.delete(file.id);
      }
      break;
  }
}

function applySnapshot(state: ExplorationState, snapshot: Snapshot) {
  state.exploration = snapshot.exploration;
  state.forks = byId(snapshot.forks);
  state.messages = byId(snapshot.messages);
  state.comments = byId(snapshot.comments);
  state.queuedSubmissions = byId(snapshot.queuedSubmissions);
  state.files = byId(snapshot.files);
  state.replyDrafts = new Map(snapshot.replyDrafts.map((draft) => [draft.forkId, draft]));
  state.sessionStatus = snapshot.sessionStatus;
  state.sessionError = snapshot.sessionError;
  state.status = 'ready';
  for (const change of outbox.changes.value) applyChange(state, change);
}

function createExplorationStore(explorationId: string) {
  const state = reactive<ExplorationState>({
    explorationId,
    status: 'loading',
    exploration: null,
    forks: new Map(),
    messages: new Map(),
    comments: new Map(),
    queuedSubmissions: new Map(),
    files: new Map(),
    replyDrafts: new Map(),
    sessionStatus: 'detached',
    sessionError: null,
    connected: false,
  });

  const load = async () => {
    try {
      applySnapshot(state, await api.snapshot(explorationId));
    } catch (error) {
      state.status = error instanceof ApiError && error.code === 'not_found' ? 'missing' : 'error';
    }
  };

  // Every (re)connect reloads the snapshot, so events missed while disconnected are never replayed.
  let source: EventSource;
  let retryMs = firstRetryMs;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  // EventSource retries a dropped connection by itself, but gives up for good when an answer is
  // not an event stream, such as the proxy's 502 while the daemon restarts. Then a new one is opened.
  const reconnect = () => {
    clearTimeout(retryTimer);
    if (closed || source.readyState !== EventSource.CLOSED) return;
    source = connect();
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') reconnect();
  };
  document.addEventListener('visibilitychange', onVisible);

  function connect() {
    const next = new EventSource(`/api/explorations/${explorationId}/events`);
    // Changes made while offline go first, so the reloaded chat already has them.
    next.addEventListener('ready', async () => {
      retryMs = firstRetryMs;
      state.connected = true;
      await outbox.flush();
      await load();
    });
    // EventSource reports the 404 of a missing exploration only as an error.
    next.addEventListener('error', () => {
      state.connected = false;
      if (state.status === 'loading') {
        void load().then(() => {
          if (state.status === 'missing') close();
        });
      }
      if (next.readyState !== EventSource.CLOSED) return;
      retryTimer = setTimeout(reconnect, retryMs);
      retryMs = Math.min(retryMs * 2, maxRetryMs);
    });
    for (const type of eventTypes) {
      next.addEventListener(type, (message) => {
        applyServerEvent(state, JSON.parse((message as MessageEvent<string>).data));
      });
    }
    return next;
  }

  function close() {
    closed = true;
    clearTimeout(retryTimer);
    document.removeEventListener('visibilitychange', onVisible);
    source.close();
  }

  source = connect();
  return { state, close };
}

let active: ReturnType<typeof createExplorationStore> | null = null;

export function whenActiveExplorationLoaded() {
  return new Promise<void>((resolve) => {
    if (!active || active.state.status !== 'loading') return resolve();
    const stop = watch(
      () => active?.state.status,
      (status) => {
        if (status === 'loading') return;
        stop();
        void nextTick(resolve);
      },
    );
  });
}

outbox.onChange((change) => {
  if (active) applyChange(active.state, change);
});

// A change the daemon refused leaves the page showing it, so the chat is loaded again.
outbox.onFailure(async (explorationId) => {
  if (active?.state.explorationId !== explorationId) return;
  const state = active.state;
  const snapshot = await api.snapshot(explorationId).catch(() => null);
  if (snapshot) applySnapshot(state, snapshot);
});

export function openExploration(explorationId: string) {
  if (active?.state.explorationId === explorationId) return active.state;
  active?.close();
  active = createExplorationStore(explorationId);
  return active.state;
}
