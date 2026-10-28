import type { ClaudeModel } from '@shared/models';
import type {
  Comment,
  CommentChanges,
  Exploration,
  ExplorationListItem,
  NewComment,
  QueuedSubmission,
  Snapshot,
  SpeechBlock,
} from '@shared/types';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: string;
  json?: object;
  form?: FormData;
  signal?: AbortSignal;
}

async function send(path: string, init: RequestOptions) {
  const response = await fetch(path, {
    method: init.method ?? (init.json || init.form ? 'POST' : 'GET'),
    headers: init.json ? { 'content-type': 'application/json' } : {},
    body: init.json ? JSON.stringify(init.json) : (init.form ?? null),
    signal: init.signal,
  });
  if (!response.ok) {
    const body = await response.json();
    throw new ApiError(body.error ?? 'error', body.message ?? response.statusText);
  }
  return response;
}

async function call<Result>(path: string, init: RequestOptions = {}) {
  return (await (await send(path, init)).json()) as Result;
}

export const api = {
  settings: () =>
    call<{ defaultModel: ClaudeModel; dictation: boolean; speech: boolean }>('/api/settings'),
  speech: async (messageId: string, block: SpeechBlock) =>
    (await send('/api/speech', { json: { messageId, block } })).blob(),
  transcribe: (wav: Blob, hint: string, signal: AbortSignal) => {
    const form = new FormData();
    form.append('audio', wav, 'recording.wav');
    form.append('hint', hint);
    return call<{ text: string }>('/api/transcriptions', { form, signal });
  },
  listExplorations: (archived = false) =>
    call<ExplorationListItem[]>(`/api/explorations${archived ? '?archived=true' : ''}`),
  archive: (explorationId: string) =>
    call<Exploration>(`/api/explorations/${explorationId}/archive`, { method: 'POST' }),
  unarchive: (explorationId: string) =>
    call<Exploration>(`/api/explorations/${explorationId}/unarchive`, { method: 'POST' }),
  deleteExploration: (explorationId: string) =>
    call<{ ok: true }>(`/api/explorations/${explorationId}`, { method: 'DELETE' }),
  snapshot: (explorationId: string) => call<Snapshot>(`/api/explorations/${explorationId}`),
  createExploration: (message: string, model: ClaudeModel) =>
    call<{ explorationId: string }>('/api/explorations', { json: { message, model } }),
  setModel: (explorationId: string, model: ClaudeModel) =>
    call<Exploration>(`/api/explorations/${explorationId}`, { method: 'PATCH', json: { model } }),
  startSession: (explorationId: string) =>
    call<{ ok: true }>(`/api/explorations/${explorationId}/session`, { method: 'POST' }),
  submit: (explorationId: string, forkId: string, globalMessage: string, newFork: boolean) =>
    call<QueuedSubmission>(`/api/explorations/${explorationId}/submit`, {
      json: { forkId, globalMessage, newFork },
    }),
  cancelSubmission: (submissionId: string) =>
    call<{ globalMessage: string }>(`/api/submissions/${submissionId}`, { method: 'DELETE' }),
  createComment: (explorationId: string, comment: NewComment) =>
    call<Comment>(`/api/explorations/${explorationId}/comments`, { json: comment }),
  updateComment: (commentId: string, changes: CommentChanges) =>
    call<Comment>(`/api/comments/${commentId}`, { method: 'PATCH', json: changes }),
  deleteComment: (commentId: string) =>
    call<{ ok: true }>(`/api/comments/${commentId}`, { method: 'DELETE' }),
  toggleForkAll: (explorationId: string, forkId: string) =>
    call<Comment[]>(`/api/explorations/${explorationId}/comments/fork-all`, { json: { forkId } }),
};
