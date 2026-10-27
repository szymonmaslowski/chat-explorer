import type { ClaudeModel } from './models.js';

export type Role = 'user' | 'assistant';
export type MessageSource = 'import' | 'live';
export type ForkKind = 'soft' | 'hard';
export type CommentType = 'inline' | 'fork';
export type CommentStatus = 'draft' | 'queued' | 'submitted';
export type SessionStatus = 'starting' | 'listening' | 'answering' | 'attached' | 'detached';

export interface Exploration {
  id: string;
  title: string;
  summary: string;
  model: ClaudeModel;
  createdAt: number;
  updatedAt: number;
}

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
  type: CommentType;
  status: CommentStatus;
  submissionId: string | null;
  replyMessageId: string | null;
  createdForkId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface QueuedSubmission {
  id: string;
  explorationId: string;
  forkId: string;
  globalMessage: string;
  createdAt: number;
}

export interface Snapshot {
  exploration: Exploration;
  forks: Fork[];
  messages: Message[];
  comments: Comment[];
  queuedSubmissions: QueuedSubmission[];
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
  | { type: 'exploration.updated'; exploration: Exploration }
  | { type: 'exploration.deleted'; explorationId: string }
  | { type: 'session.attached'; shimId: string }
  | { type: 'session.status'; status: SessionStatus }
  | { type: 'session.error'; message: string | null };

export interface NewComment {
  messageId: string;
  viewForkId: string;
  quote: string;
  startOffset: number;
  endOffset: number;
  body: string;
  type?: CommentType;
}

export interface CommentChanges {
  body?: string;
  type?: CommentType;
}
