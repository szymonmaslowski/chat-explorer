import type { ClaudeModel } from './models.js';
import type { ForkNetwork } from './network.js';

export type Role = 'user' | 'assistant';
export type MessageSource = 'import' | 'live';
export type ForkKind = 'soft' | 'hard';
// An aware fork's engine hears about the chat's other forks; a separate one only its own path.
export type ForkAwareness = 'aware' | 'separate';
export type CommentType = 'inline' | 'fork' | 'note';
export type CommentStatus = 'draft' | 'queued' | 'submitted';
export type SessionStatus = 'listening' | 'answering' | 'attached' | 'detached';

export interface Exploration {
  id: string;
  title: string;
  summary: string;
  model: ClaudeModel;
  defaultPage: ChatDefaultPage;
  // The columns of the board of forks, left to right.
  boardColumns: BoardColumn[];
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  deletedAt: number | null;
}

export interface BoardColumn {
  id: string;
  name: string;
}

export const chatDefaultPages = ['map', 'notes'] as const;
export type ChatDefaultPage = (typeof chatDefaultPages)[number];

export type ExplorationView = 'active' | 'archived' | 'deleted';

export interface ExplorationListItem extends Exploration {
  forkCount: number;
  sessionStatus: SessionStatus;
  hasUnread: boolean;
  awaitingAnswer: boolean;
}

// What a split changed: the new fork, the old one and the forks moved under the new one, and
// everything that moved with the messages.
export interface ForkSplit {
  fork: Fork;
  forks: Fork[];
  messages: Message[];
  comments: Comment[];
  bookmarks: Bookmark[];
  activities: Activity[];
  notes: Note[];
  forkRuns: ForkRun[];
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
  awareness: ForkAwareness;
  // Claude may run commands and write files in the fork's workspace, in its container.
  coding: boolean;
  // What a coding fork's container may reach.
  network: ForkNetwork;
  createdAt: number;
  updatedAt: number;
  // Set on the fork the reader archived; the forks below it count as archived too.
  archivedAt: number | null;
  // Hidden from the map with the forks below it; the fork stays usable.
  collapsed: boolean;
  // Split off another fork and named after its first message until Claude names it.
  needsSummary: boolean;
  // The board column the fork is filed under; null puts it in the Ungrouped section.
  boardColumnId: string | null;
  // Its place among the forks of the same column, top to bottom.
  boardPosition: number;
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
  // Null on an answer of Claude's the reader has not seen yet.
  readAt: number | null;
}

// A message without its text, for a light load of a chat. The text comes on request.
export interface MessageHead extends Omit<Message, 'content'> {
  // What an answer of Claude's answers, from its tags: comment and message ids.
  answers: string[];
}

export interface MessageBody {
  id: string;
  content: string;
}

export interface ReadChange {
  messageIds: string[];
  readAt: number | null;
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
  // The fork whose Claude drafted it, for the user to edit and send; null for the user's own.
  draftedByForkId: string | null;
  // A draft goes with the next Submit only when selected.
  selected: boolean;
  // For a comment that starts a fork: the board column the fork goes to. Null is the column of
  // its parent; otherwise 'ungrouped', 'new' (a column made with the fork) or a column id.
  boardColumnChoice: string | null;
  createdAt: number;
  updatedAt: number;
}

// A marked passage of one fork's conversation, shown only in that fork.
export interface Bookmark {
  id: string;
  explorationId: string;
  forkId: string;
  messageId: string;
  quote: string;
  startOffset: number;
  endOffset: number;
  createdAt: number;
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
  // The section of its group the note sits under; null for none.
  category: string | null;
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
  // A file on a comment stays with it, as a draft and once sent.
  commentId: string | null;
  // In pixels, for an image whose size could be read, so the page keeps room for it.
  width: number | null;
  height: number | null;
  createdAt: number;
}

export interface ReplyDraft {
  forkId: string;
  text: string;
  newFork: boolean;
  files: MessageFile[];
  updatedAt: number;
}

// The agent loop's state of a fork: what its runner is doing and how full the context is.
export type RunStatus = 'idle' | 'answering' | 'waiting_limit' | 'waiting_memory' | 'failed';

// How many coding forks fit in Docker's memory at once, each at its cap, and which forks hold that
// room now: a coding fork outside them waits while all of it is taken.
// What a runner offers coding forks, from its own config, for the fork's settings to show. Display
// only: the runner checks every job against its config again. Hidden entries are left out.
export interface RunnerCapabilities {
  coding: boolean;
  // Why coding is off on this runner, when it is.
  codingOff: string | null;
  // Hosts a fork may be allowed, *.domain:port included; null allows any public host.
  allowedHosts: string[] | null;
  // Of those, the ones allowed on the user's own network.
  privateHosts: string[];
  credentials: { name: string; type: 'token' | 'ssh-key'; hosts: string[] }[];
  limits: {
    memory: string;
    cpus: number | null;
    processes: number;
    workspaceLimitGb: number;
  };
  // Changes with the runner's config file.
  configHash: string;
}

// The runner's last capabilities report, and whether that runner is still around.
export interface CapabilitiesReport {
  capabilities: RunnerCapabilities;
  reportedAt: number;
  current: boolean;
}

export interface CodingCapacity {
  // Each coding container's cap.
  memory: string;
  // Memory free in Docker now, or null when the runner couldn't measure it.
  availableBytes: number | null;
  // What a new coding container needs free to start.
  neededBytes: number;
  // Forks whose coding containers run.
  forkIds: string[];
}

export interface ForkRun {
  forkId: string;
  explorationId: string;
  status: RunStatus;
  // Why it failed, until when it waits for the usage limit, or why it waits for memory.
  statusDetail: string | null;
  attempt: number;
  // An attached terminal session holds the fork: the page cannot stop it.
  heldByTerminal: boolean;
  // The newest user message a turn handled, answered or stopped.
  handledUpTo: string | null;
  model: string | null;
  contextTokens: number | null;
  contextWindow: number | null;
  updatedAt: number;
}

export type ActivityKind = 'tool' | 'text' | 'progress';

export interface Activity {
  id: string;
  explorationId: string;
  forkId: string;
  // What the step shows under: the newest user message of its turn, or, once the run answered
  // mid-turn or the reader forked there, that answer or that fork's id.
  afterMessageId: string;
  attempt: number;
  kind: ActivityKind;
  text: string;
  // From an attempt that died before it answered.
  interrupted: boolean;
  createdAt: number;
}

// One attempt at a turn, counted: its steps come on request.
export interface ActivitySummary {
  forkId: string;
  afterMessageId: string;
  attempt: number;
  count: number;
  interrupted: boolean;
  firstAt: number;
  lastAt: number;
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
  bookmarks: Bookmark[];
  forkRuns: ForkRun[];
  activities: Activity[];
  sessionStatus: SessionStatus;
}

// The chat without message texts and with runner steps only counted, except for the attempts
// still running.
export interface LightSnapshot extends Omit<Snapshot, 'messages'> {
  messages: MessageHead[];
  activitySummaries: ActivitySummary[];
  // The change log's number when this was read: the changes after it come from `changes`.
  seq: number;
}

export type ChangeKind =
  | 'exploration'
  | 'fork'
  | 'message'
  | 'comment'
  | 'submission'
  | 'file'
  | 'reply_draft'
  | 'note_group'
  | 'note'
  | 'bookmark'
  | 'fork_run'
  | 'activity';

// What changed in a chat after a number of the change log, as it is now. A reply draft and a
// fork run are named by their fork's id.
export interface ChangeSet {
  seq: number;
  // The log no longer reaches back that far, so the chat has to be loaded fresh.
  reset: boolean;
  exploration: Exploration | null;
  forks: Fork[];
  messages: Message[];
  comments: Comment[];
  queuedSubmissions: QueuedSubmission[];
  files: MessageFile[];
  replyDrafts: ReplyDraft[];
  noteGroups: NoteGroup[];
  notes: Note[];
  bookmarks: Bookmark[];
  forkRuns: ForkRun[];
  activities: Activity[];
  deleted: { kind: ChangeKind; id: string }[];
  // The log keeps no session state, so a chat caught up from it gets the current one.
  sessionStatus: SessionStatus;
}

export type ExplorationEvent =
  | { type: 'message.added'; message: Message; fork: Fork }
  | ({ type: 'messages.read' } & ReadChange)
  | { type: 'fork.created'; fork: Fork }
  | { type: 'fork.updated'; fork: Fork }
  | ({ type: 'fork.split' } & ForkSplit)
  | { type: 'comment.created'; comment: Comment }
  | { type: 'comment.updated'; comment: Comment }
  | { type: 'comment.deleted'; commentId: string }
  | { type: 'submission.queued'; submission: QueuedSubmission }
  | { type: 'submission.cancelled'; submissionId: string }
  | { type: 'submission.delivered'; submissionId: string }
  | { type: 'note-group.created'; group: NoteGroup }
  | { type: 'note-group.updated'; group: NoteGroup }
  | { type: 'note-groups.reordered'; groupIds: string[] }
  | { type: 'note-group.deleted'; groupId: string }
  | { type: 'note.created'; note: Note }
  | { type: 'note.updated'; note: Note }
  | { type: 'note.deleted'; noteId: string }
  | { type: 'notes.reordered'; groupId: string; noteIds: string[] }
  | { type: 'note.group-changed'; note: Note; noteIds: string[] }
  | { type: 'bookmark.created'; bookmark: Bookmark }
  | { type: 'bookmark.deleted'; bookmarkId: string }
  | { type: 'files.updated'; files: MessageFile[] }
  | { type: 'files.released'; fileIds: string[] }
  | { type: 'reply-draft.updated'; draft: ReplyDraft }
  | { type: 'exploration.updated'; exploration: Exploration }
  | { type: 'exploration.deleted'; explorationId: string }
  | { type: 'fork-run.updated'; run: ForkRun }
  | { type: 'activity.added'; activity: Activity }
  | { type: 'activities.interrupted'; forkId: string; attempt: number }
  | { type: 'session.attached'; shimId: string }
  | { type: 'session.status'; status: SessionStatus };

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
  fileIds?: string[];
  selected?: boolean;
  boardColumnChoice?: string | null;
}

export interface CommentChanges {
  body?: string;
  editBody?: string | null;
  type?: CommentType;
  noteGroupId?: string | null;
  // All the comment's files: new uploads join it, files left out are let go.
  fileIds?: string[];
  selected?: boolean;
  boardColumnChoice?: string | null;
}

export interface NewBookmark {
  // Made by the page, so a repeated request creates it only once.
  id?: string;
  forkId: string;
  messageId: string;
  quote: string;
  startOffset: number;
  endOffset: number;
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
  category?: string;
}

export interface NoteChanges {
  topic?: string;
  description?: string;
  // An empty name or null takes the note out of its category.
  category?: string | null;
  checked?: boolean;
  // When the editing device last saw the note, and when its edit was made: an edit from another
  // device in between is a conflict, and the older edit is kept as a copy.
  baseUpdatedAt?: number;
  editedAt?: number;
}

export type SpeechBlock =
  | { kind: 'text'; text: string }
  | { kind: 'code'; language: string; lines: number }
  | { kind: 'diagram' }
  | { kind: 'table'; columns: number; rows: number }
  | { kind: 'image'; description: string };
