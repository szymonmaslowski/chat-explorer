import type { ClaudeModel } from './models.js';

export type Role = 'user' | 'assistant';
export type MessageSource = 'import' | 'live';
export type ForkKind = 'soft' | 'hard';
export type CommentType = 'inline' | 'fork' | 'note';
export type CommentStatus = 'draft' | 'queued' | 'submitted';
export type SessionStatus = 'starting' | 'listening' | 'answering' | 'attached' | 'detached';

export interface Exploration {
  id: string;
  title: string;
  summary: string;
  model: ClaudeModel;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  deletedAt: number | null;
}

export type ExplorationView = 'active' | 'archived' | 'deleted';

export interface ExplorationListItem extends Exploration {
  forkCount: number;
  sessionStatus: SessionStatus;
}

export interface Fork {
  id: string;
  explorationId: string;
  parentForkId: string | null;
  baseMessageId: string | null;
  originCommentId: string | null;
  tipMessageId: string | null;
  kind: ForkKind;
  summary: string;
  createdAt: number;
  updatedAt: number;
  // Set on the fork the reader archived; the forks below it count as archived too.
  archivedAt: number | null;
}

export interface Message {
  id: string;
  explorationId: string;
  forkId: string;
  parentId: string | null;
  role: Role;
  content: string;
  source: MessageSource;
  createdAt: number;
}

export interface Comment {
  id: string;
  explorationId: string;
  messageId: string;
  viewForkId: string;
  quote: string;
  startOffset: number;
  endOffset: number;
  body: string;
  // Text in an open editor, saved as it is typed; null when no editor is open. A comment that
  // was never saved has an empty body.
  editBody: string | null;
  type: CommentType;
  status: CommentStatus;
  submissionId: string | null;
  replyMessageId: string | null;
  createdForkId: string | null;
  // A note comment becomes a note in this group on Submit; null makes a new group then.
  noteGroupId: string | null;
  createdNoteId: string | null;
  // Fork comments in the same group start one fork together; null for a comment on its own.
  forkGroupId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type NoteAuthor = 'user' | 'claude';

export interface NoteGroup {
  id: string;
  explorationId: string;
  name: string;
  checklist: boolean;
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface Note {
  id: string;
  explorationId: string;
  groupId: string;
  // Null until Claude writes one for a note that has only a description.
  topic: string | null;
  description: string;
  checked: boolean;
  position: number;
  sourceForkId: string | null;
  sourceMessageId: string | null;
  sourceQuote: string | null;
  sourceCommentId: string | null;
  createdBy: NoteAuthor;
  deletionRequestedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface QueuedSubmission {
  id: string;
  explorationId: string;
  forkId: string;
  globalMessage: string;
  newFork: boolean;
  createdAt: number;
}

export type FileKind = 'image' | 'pdf' | 'text';

export interface MessageFile {
  id: string;
  name: string;
  kind: FileKind;
  mediaType: string;
  size: number;
  submissionId: string | null;
  messageId: string | null;
  createdAt: number;
}

export interface ReplyDraft {
  forkId: string;
  text: string;
  newFork: boolean;
  files: MessageFile[];
  updatedAt: number;
}

export interface Snapshot {
  exploration: Exploration;
  forks: Fork[];
  messages: Message[];
  comments: Comment[];
  queuedSubmissions: QueuedSubmission[];
  files: MessageFile[];
  replyDrafts: ReplyDraft[];
  noteGroups: NoteGroup[];
  notes: Note[];
  sessionStatus: SessionStatus;
  sessionError: string | null;
}

export type ExplorationEvent =
  | { type: 'message.added'; message: Message; fork: Fork }
  | { type: 'fork.created'; fork: Fork }
  | { type: 'fork.updated'; fork: Fork }
  | { type: 'comment.created'; comment: Comment }
  | { type: 'comment.updated'; comment: Comment }
  | { type: 'comment.deleted'; commentId: string }
  | { type: 'submission.queued'; submission: QueuedSubmission }
  | { type: 'submission.cancelled'; submissionId: string }
  | { type: 'submission.delivered'; submissionId: string }
  | { type: 'note-group.created'; group: NoteGroup }
  | { type: 'note-group.updated'; group: NoteGroup }
  | { type: 'note-group.deleted'; groupId: string }
  | { type: 'note.created'; note: Note }
  | { type: 'note.updated'; note: Note }
  | { type: 'note.deleted'; noteId: string }
  | { type: 'notes.reordered'; groupId: string; noteIds: string[] }
  | { type: 'note.group-changed'; note: Note; noteIds: string[] }
  | { type: 'files.updated'; files: MessageFile[] }
  | { type: 'files.released'; fileIds: string[] }
  | { type: 'exploration.updated'; exploration: Exploration }
  | { type: 'exploration.deleted'; explorationId: string }
  | { type: 'session.attached'; shimId: string }
  | { type: 'session.status'; status: SessionStatus }
  | { type: 'session.error'; message: string | null };

export interface NewComment {
  // Made by the page when it queues the comment, so a repeated request creates it only once.
  id?: string;
  messageId: string;
  viewForkId: string;
  quote: string;
  startOffset: number;
  endOffset: number;
  body: string;
  editBody?: string;
  type?: CommentType;
  noteGroupId?: string | null;
}

export interface CommentChanges {
  body?: string;
  editBody?: string | null;
  type?: CommentType;
  noteGroupId?: string | null;
}

export interface NewNoteGroup {
  id?: string;
  // Empty takes the next default name.
  name?: string;
  checklist?: boolean;
}

export interface NoteGroupChanges {
  name?: string;
  checklist?: boolean;
}

export interface NewNote {
  id?: string;
  groupId: string;
  topic?: string;
  description?: string;
}

export interface NoteChanges {
  topic?: string;
  description?: string;
  checked?: boolean;
}

export type SpeechBlock =
  | { kind: 'text'; text: string }
  | { kind: 'code'; language: string; lines: number }
  | { kind: 'diagram' }
  | { kind: 'table'; columns: number; rows: number }
  | { kind: 'image'; description: string };
