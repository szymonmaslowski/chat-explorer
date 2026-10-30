import type { ClaudeModel } from '@shared/models';
import type {
  Comment,
  CommentChanges,
  Exploration,
  ExplorationListItem,
  Fork,
  MessageFile,
  NewComment,
  QueuedSubmission,
  ReplyDraft,
  Snapshot,
  SpeechBlock,
} from '@shared/types';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: string;
  json?: object;
  form?: FormData;
  signal?: AbortSignal;
  // Lets a save sent while the page closes reach the daemon.
  keepalive?: boolean;
}

async function send(path: string, init: RequestOptions) {
  const response = await fetch(path, {
    method: init.method ?? (init.json || init.form ? 'POST' : 'GET'),
    headers: init.json ? { 'content-type': 'application/json' } : {},
    body: init.json ? JSON.stringify(init.json) : (init.form ?? null),
    signal: init.signal,
    keepalive: init.keepalive,
  });
  if (!response.ok) {
    // A proxy in front of a stopped daemon answers with an HTML page.
    const body: { error?: string; message?: string } = await response.json().catch(() => ({}));
    throw new ApiError(body.error ?? 'error', body.message ?? response.statusText, response.status);
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
  createExploration: (message: string, model: ClaudeModel, fileIds: string[]) =>
    call<{ explorationId: string }>('/api/explorations', { json: { message, model, fileIds } }),
  uploadFile: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return call<MessageFile>('/api/files', { form });
  },
  deleteFile: (fileId: string) => call<{ ok: true }>(`/api/files/${fileId}`, { method: 'DELETE' }),
  setModel: (explorationId: string, model: ClaudeModel) =>
    call<Exploration>(`/api/explorations/${explorationId}`, { method: 'PATCH', json: { model } }),
  startSession: (explorationId: string) =>
    call<{ ok: true }>(`/api/explorations/${explorationId}/session`, { method: 'POST' }),
  submit: (
    explorationId: string,
    forkId: string,
    globalMessage: string,
    options: { id: string; newFork: boolean; fileIds: string[] },
    keepalive = false,
  ) =>
    call<QueuedSubmission>(`/api/explorations/${explorationId}/submit`, {
      json: { forkId, globalMessage, ...options },
      keepalive,
    }),
  forkNow: (commentId: string, submissionId: string, keepalive = false) =>
    call<QueuedSubmission>(`/api/comments/${commentId}/fork-now`, {
      json: { id: submissionId },
      keepalive,
    }),
  cancelSubmission: (submissionId: string, keepalive = false) =>
    call<{ globalMessage: string; newFork: boolean; files: MessageFile[] }>(
      `/api/submissions/${submissionId}`,
      { method: 'DELETE', keepalive },
    ),
  createComment: (explorationId: string, comment: NewComment, keepalive = false) =>
    call<Comment>(`/api/explorations/${explorationId}/comments`, { json: comment, keepalive }),
  updateComment: (commentId: string, changes: CommentChanges, keepalive = false) =>
    call<Comment>(`/api/comments/${commentId}`, { method: 'PATCH', json: changes, keepalive }),
  archiveFork: (forkId: string) => call<Fork>(`/api/forks/${forkId}/archive`, { method: 'POST' }),
  unarchiveFork: (forkId: string) =>
    call<Fork>(`/api/forks/${forkId}/unarchive`, { method: 'POST' }),
  replyDraft: (forkId: string) => call<ReplyDraft>(`/api/forks/${forkId}/reply-draft`),
  saveReplyDraft: (
    forkId: string,
    draft: { text: string; newFork: boolean; fileIds: string[] },
    keepalive = false,
  ) =>
    call<ReplyDraft>(`/api/forks/${forkId}/reply-draft`, {
      method: 'PUT',
      json: draft,
      keepalive,
    }),
  deleteComment: (commentId: string, keepalive = false) =>
    call<{ ok: true }>(`/api/comments/${commentId}`, { method: 'DELETE', keepalive }),
  toggleForkAll: (explorationId: string, forkId: string) =>
    call<Comment[]>(`/api/explorations/${explorationId}/comments/fork-all`, { json: { forkId } }),
};
