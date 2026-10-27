import type {
  Comment,
  Exploration,
  ExplorationEvent,
  Fork,
  Message,
  QueuedSubmission,
  SessionStatus,
  Snapshot,
} from '@shared/types';
import { reactive } from 'vue';
import { api, ApiError } from '../api';

export interface ExplorationState {
  explorationId: string;
  status: 'loading' | 'ready' | 'missing' | 'deleted' | 'error';
  exploration: Exploration | null;
  forks: Map<string, Fork>;
  messages: Map<string, Message>;
  comments: Map<string, Comment>;
  queuedSubmissions: Map<string, QueuedSubmission>;
  sessionStatus: SessionStatus;
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
  'exploration.updated',
  'exploration.deleted',
  'session.status',
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
    case 'exploration.updated':
      state.exploration = event.exploration;
      break;
    case 'exploration.deleted':
      state.status = 'deleted';
      break;
    case 'session.status':
      state.sessionStatus = event.status;
      break;
    case 'session.attached':
      break;
  }
}

function applySnapshot(state: ExplorationState, snapshot: Snapshot) {
  state.exploration = snapshot.exploration;
  state.forks = byId(snapshot.forks);
  state.messages = byId(snapshot.messages);
  state.comments = byId(snapshot.comments);
  state.queuedSubmissions = byId(snapshot.queuedSubmissions);
  state.sessionStatus = snapshot.sessionStatus;
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
    sessionStatus: 'detached',
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
  const source = new EventSource(`/api/explorations/${explorationId}/events`);
  source.addEventListener('ready', () => {
    state.connected = true;
    void load();
  });
  source.addEventListener('error', () => {
    state.connected = false;
  });
  for (const type of eventTypes) {
    source.addEventListener(type, (message) => {
      applyEvent(state, JSON.parse((message as MessageEvent<string>).data));
    });
  }

  return { state, close: () => source.close() };
}

let active: ReturnType<typeof createExplorationStore> | null = null;

export function openExploration(explorationId: string) {
  if (active?.state.explorationId === explorationId) return active.state;
  active?.close();
  active = createExplorationStore(explorationId);
  return active.state;
}
