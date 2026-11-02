import type { ClaudeModel } from '../shared/models.js';
import type {
  Comment,
  CommentStatus,
  CommentType,
  Exploration,
  FileKind,
  Fork,
  ForkKind,
  Message,
  MessageFile,
  MessageSource,
  Note,
  NoteAuthor,
  NoteGroup,
  QueuedSubmission,
  Role,
} from '../shared/types.js';

export interface ExplorationRow {
  id: string;
  title: string;
  summary: string;
  created_at: number;
  updated_at: number;
  attached_session_id: string | null;
  attached_shim_id: string | null;
  attached_seen_at: number | null;
  model: ClaudeModel;
  background_session_id: string | null;
  archived_at: number | null;
  deleted_at: number | null;
}

export interface ForkRow {
  id: string;
  exploration_id: string;
  parent_fork_id: string | null;
  base_message_id: string | null;
  origin_comment_id: string | null;
  tip_message_id: string | null;
  kind: ForkKind;
  summary: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface MessageRow {
  id: string;
  exploration_id: string;
  fork_id: string;
  parent_id: string | null;
  role: Role;
  content: string;
  source: MessageSource;
  created_at: number;
}

export interface CommentRow {
  id: string;
  exploration_id: string;
  message_id: string;
  view_fork_id: string;
  quote: string;
  start_offset: number;
  end_offset: number;
  body: string;
  edit_body: string | null;
  type: CommentType;
  status: CommentStatus;
  submission_id: string | null;
  reply_message_id: string | null;
  created_fork_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface FileRow {
  id: string;
  exploration_id: string | null;
  submission_id: string | null;
  message_id: string | null;
  name: string;
  kind: FileKind;
  media_type: string;
  size: number;
  path: string;
  draft_fork_id: string | null;
  created_at: number;
}

export interface ReplyDraftRow {
  fork_id: string;
  exploration_id: string;
  text: string;
  new_fork: number;
  updated_at: number;
}

export interface NoteGroupRow {
  id: string;
  exploration_id: string;
  name: string;
  checklist: number;
  position: number;
  created_at: number;
  updated_at: number;
}

export interface NoteRow {
  id: string;
  exploration_id: string;
  group_id: string;
  topic: string | null;
  description: string;
  checked: number;
  position: number;
  source_fork_id: string | null;
  source_message_id: string | null;
  source_quote: string | null;
  source_start_offset: number | null;
  source_end_offset: number | null;
  source_comment_id: string | null;
  created_by: NoteAuthor;
  deletion_requested_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface SubmissionRow {
  id: string;
  exploration_id: string;
  fork_id: string;
  global_message: string;
  new_fork: number;
  status: 'queued' | 'delivered';
  created_at: number;
  delivered_at: number | null;
}

export const toExploration = (row: ExplorationRow): Exploration => ({
  id: row.id,
  title: row.title,
  summary: row.summary,
  model: row.model,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  archivedAt: row.archived_at,
  deletedAt: row.deleted_at,
});

export const toFork = (row: ForkRow): Fork => ({
  id: row.id,
  explorationId: row.exploration_id,
  parentForkId: row.parent_fork_id,
  baseMessageId: row.base_message_id,
  originCommentId: row.origin_comment_id,
  tipMessageId: row.tip_message_id,
  kind: row.kind,
  summary: row.summary,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  archivedAt: row.archived_at,
});

export const toMessage = (row: MessageRow): Message => ({
  id: row.id,
  explorationId: row.exploration_id,
  forkId: row.fork_id,
  parentId: row.parent_id,
  role: row.role,
  content: row.content,
  source: row.source,
  createdAt: row.created_at,
});

export const toComment = (row: CommentRow): Comment => ({
  id: row.id,
  explorationId: row.exploration_id,
  messageId: row.message_id,
  viewForkId: row.view_fork_id,
  quote: row.quote,
  startOffset: row.start_offset,
  endOffset: row.end_offset,
  body: row.body,
  editBody: row.edit_body,
  type: row.type,
  status: row.status,
  submissionId: row.submission_id,
  replyMessageId: row.reply_message_id,
  createdForkId: row.created_fork_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toMessageFile = (row: FileRow): MessageFile => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  mediaType: row.media_type,
  size: row.size,
  submissionId: row.submission_id,
  messageId: row.message_id,
  createdAt: row.created_at,
});

export const toQueuedSubmission = (row: SubmissionRow): QueuedSubmission => ({
  id: row.id,
  explorationId: row.exploration_id,
  forkId: row.fork_id,
  globalMessage: row.global_message,
  newFork: row.new_fork === 1,
  createdAt: row.created_at,
});

export const toNoteGroup = (row: NoteGroupRow): NoteGroup => ({
  id: row.id,
  explorationId: row.exploration_id,
  name: row.name,
  checklist: row.checklist === 1,
  position: row.position,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toNote = (row: NoteRow): Note => ({
  id: row.id,
  explorationId: row.exploration_id,
  groupId: row.group_id,
  topic: row.topic,
  description: row.description,
  checked: row.checked === 1,
  position: row.position,
  sourceForkId: row.source_fork_id,
  sourceMessageId: row.source_message_id,
  sourceQuote: row.source_quote,
  sourceCommentId: row.source_comment_id,
  createdBy: row.created_by,
  deletionRequestedAt: row.deletion_requested_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
