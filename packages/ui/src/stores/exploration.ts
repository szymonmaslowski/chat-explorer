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

const firstRetryMs = 1_000;
const maxRetryMs = 30_000;

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
    next.addEventListener('ready', () => {
      retryMs = firstRetryMs;
      state.connected = true;
      void load();
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
        applyEvent(state, JSON.parse((message as MessageEvent<string>).data));
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

export function openExploration(explorationId: string) {
  if (active?.state.explorationId === explorationId) return active.state;
  active?.close();
  active = createExplorationStore(explorationId);
  return active.state;
}
