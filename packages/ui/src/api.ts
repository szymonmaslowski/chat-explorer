import type {
  Comment,
  CommentChanges,
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
  listExplorations: () => call<ExplorationListItem[]>('/api/explorations'),
  snapshot: (explorationId: string) => call<Snapshot>(`/api/explorations/${explorationId}`),
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
