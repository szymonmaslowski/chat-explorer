import type { ClaudeModel } from '@shared/models';
import type {
  Bookmark,
  Comment,
  CommentChanges,
  Exploration,
  ExplorationListItem,
  Fork,
  ForkAwareness,
  MessageFile,
  NewBookmark,
  NewComment,
  NewNote,
  NewNoteGroup,
  Note,
  NoteChanges,
  NoteGroup,
  NoteGroupChanges,
  QueuedSubmission,
  ReadChange,
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

// Text that is not a message: a draft or a note.
export type SpeechSource = { messageId: string } | { text: string };

export const api = {
  settings: () =>
    call<{ defaultModel: ClaudeModel; dictation: boolean; speech: boolean }>('/api/settings'),
  speech: async (source: SpeechSource, block: SpeechBlock) =>
    (await send('/api/speech', { json: { ...source, block } })).blob(),
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
  createExploration: (input: {
    message: string;
    model: ClaudeModel;
    fileIds: string[];
    archived: boolean;
  }) => call<{ explorationId: string }>('/api/explorations', { json: input }),
  uploadFile: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return call<MessageFile>('/api/files', { form });
  },
  deleteFile: (fileId: string) => call<{ ok: true }>(`/api/files/${fileId}`, { method: 'DELETE' }),
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
  stopFork: (forkId: string) =>
    call<{ stopping: boolean }>(`/api/forks/${forkId}/stop`, { json: {} }),
  setForkAwareness: (forkId: string, awareness: ForkAwareness) =>
    call<Fork>(`/api/forks/${forkId}/awareness`, { method: 'PATCH', json: { awareness } }),
  retryFork: (forkId: string) => call<{ ok: true }>(`/api/forks/${forkId}/retry`, { json: {} }),
  forkAtAnswer: (messageId: string, forkId: string, keepalive = false) =>
    call<Fork>(`/api/messages/${messageId}/fork`, { json: { forkId }, keepalive }),
  forkFromNote: (
    noteId: string,
    ids: { submissionId: string; forkId: string },
    message: string,
    keepalive = false,
  ) =>
    call<QueuedSubmission>(`/api/notes/${noteId}/fork`, {
      json: { id: ids.submissionId, forkId: ids.forkId, message },
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
  markRead: (explorationId: string, messageIds: string[]) =>
    call<ReadChange>(`/api/explorations/${explorationId}/read`, { json: { messageIds } }),
  markUnreadFrom: (messageId: string, viewForkId: string) =>
    call<ReadChange>(`/api/messages/${messageId}/unread`, { json: { viewForkId } }),
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
  joinForkGroup: (
    commentId: string,
    group: { memberIds: string[]; groupId: string },
    keepalive = false,
  ) =>
    call<Comment[]>(`/api/comments/${commentId}/fork-group`, {
      method: 'PUT',
      json: group,
      keepalive,
    }),
  leaveForkGroup: (commentId: string, keepalive = false) =>
    call<Comment[]>(`/api/comments/${commentId}/fork-group`, { method: 'DELETE', keepalive }),
  ungroupForkGroup: (groupId: string, keepalive = false) =>
    call<Comment[]>(`/api/fork-groups/${groupId}`, { method: 'DELETE', keepalive }),
  createBookmark: (explorationId: string, bookmark: NewBookmark, keepalive = false) =>
    call<Bookmark>(`/api/explorations/${explorationId}/bookmarks`, { json: bookmark, keepalive }),
  deleteBookmark: (bookmarkId: string, keepalive = false) =>
    call<{ ok: true }>(`/api/bookmarks/${bookmarkId}`, { method: 'DELETE', keepalive }),
  createNoteGroup: (explorationId: string, group: NewNoteGroup, keepalive = false) =>
    call<NoteGroup>(`/api/explorations/${explorationId}/note-groups`, { json: group, keepalive }),
  updateNoteGroup: (groupId: string, changes: NoteGroupChanges, keepalive = false) =>
    call<NoteGroup>(`/api/note-groups/${groupId}`, { method: 'PATCH', json: changes, keepalive }),
  deleteNoteGroup: (groupId: string, keepalive = false) =>
    call<{ ok: true }>(`/api/note-groups/${groupId}`, { method: 'DELETE', keepalive }),
  createNote: (explorationId: string, note: NewNote, keepalive = false) =>
    call<Note>(`/api/explorations/${explorationId}/notes`, { json: note, keepalive }),
  updateNote: (noteId: string, changes: NoteChanges, keepalive = false) =>
    call<Note>(`/api/notes/${noteId}`, { method: 'PATCH', json: changes, keepalive }),
  deleteNote: (noteId: string, keepalive = false) =>
    call<{ ok: true }>(`/api/notes/${noteId}`, { method: 'DELETE', keepalive }),
  keepNote: (noteId: string, keepalive = false) =>
    call<Note>(`/api/notes/${noteId}/keep`, { method: 'POST', keepalive }),
  reorderNote: (noteId: string, afterNoteId: string | null, keepalive = false) =>
    call<{ groupId: string; noteIds: string[] }>(`/api/notes/${noteId}/reorder`, {
      json: { afterNoteId },
      keepalive,
    }),
  changeNoteGroup: (noteId: string, groupId: string, keepalive = false) =>
    call<{ note: Note; noteIds: string[] }>(`/api/notes/${noteId}/group`, {
      method: 'PUT',
      json: { groupId },
      keepalive,
    }),
};
