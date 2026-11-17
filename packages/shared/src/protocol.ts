// What the backend and its clients (the runner, the plugin's MCP server and hooks) send each other
// over HTTP, beyond the chat's own records in types.ts.
import type { ClaudeModel } from './models.js';
import type { ForkKind, ForkRun, NoteAuthor, Role } from './types.js';

export interface Lease {
  forkId: string;
  explorationId: string;
  leaseId: string;
  attempt: number;
  // The engine session from earlier turns, to resume; null for a fork's first run.
  sessionId: string | null;
  // What the engine sends to the job tools; it stops working when the lease ends.
  toolsToken: string;
}

export interface PendingMessage {
  id: string;
  text: string;
}

export interface RunUsage {
  model: string;
  contextTokens: number;
  contextWindow: number | null;
}

// What a runner needs to start an engine for a fork: the model, the standing instructions, and for
// a fork without an engine session yet, the conversation it continues.
export interface RunContext {
  model: ClaudeModel;
  // The fork's coding switch. The runner still checks its own config before it honours it.
  coding: boolean;
  systemPrompt: string;
  // Put before the first messages of a new session; null when the session is resumed.
  history: string | null;
}

// What a running engine gets next: new messages, or a stop the reader asked for.
export interface RunInput {
  messages: PendingMessage[];
  // What changed in the chat's other forks since the engine last heard.
  others: string | null;
  stop: boolean;
  // The fork's coding switch now, which may differ from the one its container started with.
  coding: boolean;
}

// A final reply of only this is not posted: everything went out with the answer tool already.
export const noReply = '[no reply]';

export interface UserMessageText {
  id: string;
  text: string;
}

export interface PendingFork {
  forkId: string;
  parentForkId: string | null;
  isNewFork: boolean;
  baseMessageId: string | null;
  inReplyTo: string;
  userMessages: UserMessageText[];
  // The start of the message the user answered, so Claude can tell which answer they mean when
  // one session answers many forks.
  repliesTo: { messageId: string; excerpt: string } | null;
}

export interface ForkMapEntry {
  id: string;
  parentForkId: string | null;
  baseMessageId: string | null;
  summary: string;
  kind: ForkKind;
  messageCount: number;
  awaitingAnswer: boolean;
  run: ForkRun | null;
}

export interface ForkRead {
  forkId: string;
  messages: { id: string; forkId: string; role: Role; text: string }[];
  omitted: { count: number; forks: { id: string; summary: string }[] } | null;
}

export interface NoteNeedingTopic {
  noteId: string;
  groupId: string;
  description: string;
}

// Group names and note topics, which Claude gets with every feedback.
export interface NotesIndex {
  groups: {
    id: string;
    name: string;
    checklist: boolean;
    notes: { id: string; topic: string | null; checked: boolean }[];
  }[];
}

export interface NoteFacts {
  id: string;
  topic: string | null;
  checked: boolean;
  createdBy: NoteAuthor;
  deletionRequested: boolean;
  updatedAt: number;
}

export interface NotesList {
  groups: {
    id: string;
    name: string;
    checklist: boolean;
    notes: (NoteFacts & { length: number })[];
  }[];
}

export interface NotesRead {
  notes: (NoteFacts & { groupId: string; groupName: string; description: string })[];
  // Notes asked for that did not fit in this read, for another call.
  notShown: { id: string; topic: string | null; length: number }[];
}

export interface NotesFound {
  notes: { id: string; groupId: string; topic: string | null; snippet: string }[];
  more: boolean;
}

export type FeedbackResult =
  | {
      status: 'feedback';
      forks: PendingFork[];
      notesNeedingTopic: NoteNeedingTopic[];
      notes: NotesIndex;
    }
  | { status: 'timeout' }
  | { status: 'detached' }
  | { status: 'deleted' };
