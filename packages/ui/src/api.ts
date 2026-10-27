import type { ClaudeModel } from '@shared/models';
import type {
  Comment,
  CommentChanges,
  Exploration,
  ExplorationListItem,
  NewComment,
  QueuedSubmission,
  Snapshot,
} from '@shared/types';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<Result>(path: string, init: { method?: string; json?: object } = {}) {
  const response = await fetch(path, {
    method: init.method ?? (init.json ? 'POST' : 'GET'),
    headers: init.json ? { 'content-type': 'application/json' } : {},
    body: init.json ? JSON.stringify(init.json) : null,
  });
  const body = await response.json();
  if (!response.ok) throw new ApiError(body.error ?? 'error', body.message ?? response.statusText);
  return body as Result;
}

export const api = {
  settings: () => call<{ defaultModel: ClaudeModel }>('/api/settings'),
  listExplorations: () => call<ExplorationListItem[]>('/api/explorations'),
  snapshot: (explorationId: string) => call<Snapshot>(`/api/explorations/${explorationId}`),
  createExploration: (message: string, model: ClaudeModel) =>
    call<{ explorationId: string }>('/api/explorations', { json: { message, model } }),
  setModel: (explorationId: string, model: ClaudeModel) =>
    call<Exploration>(`/api/explorations/${explorationId}`, { method: 'PATCH', json: { model } }),
  startSession: (explorationId: string) =>
    call<{ ok: true }>(`/api/explorations/${explorationId}/session`, { method: 'POST' }),
  submit: (explorationId: string, forkId: string, globalMessage: string) =>
    call<QueuedSubmission>(`/api/explorations/${explorationId}/submit`, {
      json: { forkId, globalMessage },
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
