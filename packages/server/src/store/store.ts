import type { Database } from '../db/database.js';
import {
  toActivity,
  toBookmark,
  toForkRun,
  toComment,
  toExploration,
  toFork,
  toMessage,
  toMessageFile,
  toNote,
  toNoteGroup,
  toQueuedSubmission,
  type ActivityRow,
  type BookmarkRow,
  type ForkRunRow,
  type CommentRow,
  type ExplorationRow,
  type FileRow,
  type ForkRow,
  type NoteGroupRow,
  type NoteRow,
  type ReplyDraftRow,
  type MessageRow,
  type SubmissionRow,
} from '../db/rows.js';
import type {
  Comment,
  CommentChanges,
  Exploration,
  ExplorationEvent,
  ExplorationListItem,
  ExplorationView,
  FileKind,
  ForkAwareness,
  ForkKind,
  ForkRun,
  MessageSource,
  NewBookmark,
  NewComment,
  NewNote,
  NewNoteGroup,
  NoteAuthor,
  NoteChanges,
  NoteGroupChanges,
  QueuedSubmission,
  ReplyDraft,
  Role,
  Snapshot,
} from '../shared/types.js';
import { commentTag, messageTag, withoutTagLines } from '../shared/answer-tags.js';
import { defaultClaudeModel, type ClaudeModel } from '../shared/models.js';
import {
  inTextOrder,
  joinForkGroup,
  leaveForkGroup,
  type GroupableComment,
} from '../shared/fork-groups.js';
import { defaultGroupName, noteForkMessage, reorderedIds } from '../shared/notes.js';
import { StoreError } from './errors.js';
import { idAlphabet, idLength } from '../shared/ids.js';
import type { EventBus } from './event-bus.js';
import { newId } from './ids.js';
import { repairMarkdown } from './repair-markdown.js';

export const attachmentLivenessMs = 45_000;
const forkSummaryLength = 80;
const repliesToExcerptLength = 300;
const fileReference = new RegExp(`/api/files/([${idAlphabet}]{${idLength}})`, 'g');
const clearAttachment =
  'attached_shim_id = NULL, attached_session_id = NULL, attached_seen_at = NULL';

export interface NewMessage {
  role: Role;
  content: string;
  // When it was written, for a message imported from a transcript.
  createdAt?: number;
}

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

// A fork ends with a user message no turn handled yet; a stopped turn handled it without an answer.
const awaitingAnswer = `(
  (SELECT role FROM messages WHERE messages.id = forks.tip_message_id) = 'user'
  AND forks.tip_message_id IS NOT
    (SELECT input_cursor FROM fork_runs WHERE fork_runs.fork_id = forks.id)
)`;

// Starts a message the session answering the main fork sends into another fork.
export const supervisorMessagePrefix = '**From the main fork:**';

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

export interface NotesRead {
  groups: {
    id: string;
    name: string;
    checklist: boolean;
    notes: {
      id: string;
      topic: string | null;
      description: string;
      checked: boolean;
      createdBy: NoteAuthor;
      deletionRequested: boolean;
    }[];
  }[];
}

export interface Attachment {
  shimId: string;
  sessionId: string | null;
  live: boolean;
}

type PendingEvent = [explorationId: string, event: ExplorationEvent];

const shortened = (text: string, length: number) => {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length > length ? `${singleLine.slice(0, length - 1)}…` : singleLine;
};
const summaryFrom = (text: string) => shortened(text, forkSummaryLength);
const pageMessageLength = 2_000;
const excerptOf = (text: string) => shortened(text, repliesToExcerptLength);

// A comment in a fork group goes to the group's fork, whatever its own type.
const startsAFork = (comment: CommentRow) =>
  comment.fork_group_id !== null || comment.type === 'fork';
const goesIntoReply = (comment: CommentRow) =>
  comment.fork_group_id === null && comment.type === 'inline';

const quoteBlock = (quote: string) =>
  quote
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
// A general comment quotes nothing, so it is only its text.
const quotedText = (quote: string, text: string, separator: string) =>
  quote ? `${quoteBlock(quote)}${separator}${text}` : text;

export class ChatStore {
  constructor(
    private readonly db: Database,
    private readonly bus: EventBus,
    private readonly now: () => number = Date.now,
  ) {}

  createExploration(
    options: { title?: string; messages?: NewMessage[]; model?: ClaudeModel } = {},
  ) {
    const createdAt = this.now();
    const explorationId = newId();
    const mainForkId = newId();
    this.db.transaction(() => {
      this.db.run(
        'INSERT INTO explorations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        explorationId,
        options.title ?? '',
        options.model ?? defaultClaudeModel,
        createdAt,
        createdAt,
      );
      this.db.run(
        'INSERT INTO forks (id, exploration_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
        mainForkId,
        explorationId,
        createdAt,
        createdAt,
      );
      let mainFork = this.requireForkRow(mainForkId);
      for (const message of options.messages ?? []) {
        mainFork = this.appendMessage(
          mainFork,
          message.role,
          message.content,
          'import',
          message.createdAt,
        ).fork;
      }
    });
    return {
      exploration: toExploration(this.requireExplorationRow(explorationId)),
      mainFork: toFork(this.requireForkRow(mainForkId)),
    };
  }

  listExplorations(
    view: ExplorationView = 'active',
  ): Omit<ExplorationListItem, 'sessionStatus' | 'sessionError'>[] {
    const filters: Record<ExplorationView, string> = {
      active: 'deleted_at IS NULL AND archived_at IS NULL ORDER BY updated_at DESC',
      archived: 'deleted_at IS NULL AND archived_at IS NOT NULL ORDER BY archived_at DESC',
      deleted: 'deleted_at IS NOT NULL ORDER BY deleted_at DESC',
    };
    return this.db
      .all<ExplorationRow & { fork_count: number; has_unread: number; awaiting_answer: number }>(
        `SELECT explorations.*,
           (WITH RECURSIVE shown(id) AS (
              SELECT id FROM forks
               WHERE exploration_id = explorations.id AND parent_fork_id IS NULL
              UNION ALL
              SELECT forks.id FROM forks JOIN shown ON forks.parent_fork_id = shown.id
               WHERE forks.archived_at IS NULL
            ) SELECT count(*) FROM shown) AS fork_count,
           EXISTS (
             SELECT 1 FROM messages
              WHERE messages.exploration_id = explorations.id AND messages.read_at IS NULL
           ) AS has_unread,
           EXISTS (
             SELECT 1 FROM forks WHERE forks.exploration_id = explorations.id AND ${awaitingAnswer}
           ) AS awaiting_answer
         FROM explorations WHERE ${filters[view]}`,
      )
      .map((row) => ({
        ...toExploration(row),
        forkCount: row.fork_count,
        hasUnread: row.has_unread === 1,
        awaitingAnswer: row.awaiting_answer === 1,
      }));
  }

  snapshot(explorationId: string): Omit<Snapshot, 'sessionStatus' | 'sessionError'> {
    const exploration = toExploration(this.requireExplorationRow(explorationId));
    return {
      exploration,
      forks: this.db
        .all<ForkRow>(
          'SELECT * FROM forks WHERE exploration_id = ? ORDER BY created_at, rowid',
          explorationId,
        )
        .map(toFork),
      messages: this.db
        .all<MessageRow>(
          'SELECT * FROM messages WHERE exploration_id = ? ORDER BY created_at, rowid',
          explorationId,
        )
        .map(toMessage),
      comments: this.db
        .all<CommentRow>(
          'SELECT * FROM comments WHERE exploration_id = ? ORDER BY created_at, rowid',
          explorationId,
        )
        .map(toComment),
      queuedSubmissions: this.queuedSubmissions(explorationId),
      files: this.db
        .all<FileRow>(
          'SELECT * FROM files WHERE exploration_id = ? ORDER BY created_at, rowid',
          explorationId,
        )
        .map(toMessageFile),
      replyDrafts: this.db
        .all<ReplyDraftRow>('SELECT * FROM reply_drafts WHERE exploration_id = ?', explorationId)
        .map((row) => this.toReplyDraft(row)),
      noteGroups: this.db
        .all<NoteGroupRow>(
          'SELECT * FROM note_groups WHERE exploration_id = ? ORDER BY position, rowid',
          explorationId,
        )
        .map(toNoteGroup),
      notes: this.db
        .all<NoteRow>(
          'SELECT * FROM notes WHERE exploration_id = ? ORDER BY position, rowid',
          explorationId,
        )
        .map(toNote),
      bookmarks: this.db
        .all<BookmarkRow>(
          'SELECT * FROM bookmarks WHERE exploration_id = ? ORDER BY created_at, rowid',
          explorationId,
        )
        .map(toBookmark),
      forkRuns: this.db
        .all<ForkRunRow>('SELECT * FROM fork_runs WHERE exploration_id = ?', explorationId)
        .map(toForkRun),
      activities: this.db
        .all<ActivityRow>(
          'SELECT * FROM activities WHERE exploration_id = ? ORDER BY created_at, rowid',
          explorationId,
        )
        .map(toActivity),
    };
  }

  updateExploration(input: {
    explorationId: string;
    title?: string | undefined;
    summary?: string | undefined;
  }) {
    const { explorationId } = input;
    const row = this.requireExplorationRow(explorationId);
    this.db.run(
      'UPDATE explorations SET title = ?, summary = ?, updated_at = ? WHERE id = ?',
      input.title ?? row.title,
      input.summary ?? row.summary,
      this.now(),
      explorationId,
    );
    return this.publishExplorationUpdate(explorationId);
  }

  setModel(explorationId: string, model: ClaudeModel) {
    this.requireExplorationRow(explorationId);
    this.db.run(
      'UPDATE explorations SET model = ?, updated_at = ? WHERE id = ?',
      model,
      this.now(),
      explorationId,
    );
    return this.publishExplorationUpdate(explorationId);
  }

  backgroundSession(explorationId: string) {
    const row = this.requireExplorationRow(explorationId);
    return { model: row.model, sessionId: row.background_session_id };
  }

  setBackgroundSessionId(explorationId: string, sessionId: string) {
    this.db.run(
      'UPDATE explorations SET background_session_id = ? WHERE id = ?',
      sessionId,
      explorationId,
    );
  }

  archiveExploration(explorationId: string) {
    this.requireExplorationRow(explorationId);
    this.db.run(
      `UPDATE explorations SET archived_at = ?, ${clearAttachment} WHERE id = ?`,
      this.now(),
      explorationId,
    );
    return this.publishExplorationUpdate(explorationId);
  }

  unarchiveExploration(explorationId: string) {
    this.requireExplorationRow(explorationId);
    this.db.run('UPDATE explorations SET archived_at = NULL WHERE id = ?', explorationId);
    return this.publishExplorationUpdate(explorationId);
  }

  archiveFork(forkId: string) {
    const row = this.requireForkRow(forkId);
    this.requireWritable(row.exploration_id);
    if (row.parent_fork_id === null) {
      throw new StoreError(
        'invalid',
        'The main fork cannot be archived. Archive the chat instead.',
      );
    }
    const queued = this.db.get<{ id: string }>(
      `WITH RECURSIVE subtree(id) AS (
         SELECT ?
         UNION ALL
         SELECT forks.id FROM forks JOIN subtree ON forks.parent_fork_id = subtree.id
       )
       SELECT submissions.id FROM submissions JOIN subtree ON submissions.fork_id = subtree.id
        WHERE submissions.status = 'queued'`,
      forkId,
    );
    if (queued) {
      throw new StoreError(
        'invalid',
        'A message in this fork is still queued. Cancel it or wait for the answer first.',
      );
    }
    return this.setForkArchivedAt(forkId, this.now());
  }

  unarchiveFork(forkId: string) {
    const row = this.requireForkRow(forkId);
    this.requireWritable(row.exploration_id);
    return this.setForkArchivedAt(forkId, null);
  }

  isArchived(explorationId: string) {
    return this.requireExplorationRow(explorationId).archived_at !== null;
  }

  deleteExploration(explorationId: string) {
    this.requireExplorationRow(explorationId);
    this.db.run(
      `UPDATE explorations SET deleted_at = ?, ${clearAttachment} WHERE id = ?`,
      this.now(),
      explorationId,
    );
    this.publish([[explorationId, { type: 'exploration.deleted', explorationId }]]);
  }

  // A deleted exploration comes back archived, so it does not reappear among the active ones.
  restoreExploration(explorationId: string) {
    this.requireExplorationRow(explorationId, { includeDeleted: true });
    this.db.run(
      'UPDATE explorations SET deleted_at = NULL, archived_at = coalesce(archived_at, ?) WHERE id = ?',
      this.now(),
      explorationId,
    );
    return toExploration(this.requireExplorationRow(explorationId));
  }

  purgeExploration(explorationId: string) {
    this.requireExplorationRow(explorationId, { includeDeleted: true });
    this.db.run('DELETE FROM explorations WHERE id = ?', explorationId);
    this.publish([[explorationId, { type: 'exploration.deleted', explorationId }]]);
  }

  updateForkSummary(input: { forkId: string; summary: string }) {
    const row = this.requireForkRow(input.forkId);
    this.db.run(
      'UPDATE forks SET summary = ?, updated_at = ? WHERE id = ?',
      input.summary,
      this.now(),
      input.forkId,
    );
    const fork = toFork(this.requireForkRow(input.forkId));
    this.publish([[row.exploration_id, { type: 'fork.updated', fork }]]);
    return fork;
  }

  forkMap(explorationId: string): ForkMapEntry[] {
    this.requireExplorationRow(explorationId);
    const runs = new Map(
      this.db
        .all<ForkRunRow>('SELECT * FROM fork_runs WHERE exploration_id = ?', explorationId)
        .map((row) => [row.fork_id, toForkRun(row)]),
    );
    return this.db
      .all<ForkRow & { message_count: number; awaiting_answer: number }>(
        `SELECT forks.*,
           (SELECT count(*) FROM messages WHERE messages.fork_id = forks.id) AS message_count,
           ${awaitingAnswer} AS awaiting_answer
         FROM forks WHERE exploration_id = ? ORDER BY created_at, rowid`,
        explorationId,
      )
      .map((row) => ({
        id: row.id,
        parentForkId: row.parent_fork_id,
        baseMessageId: row.base_message_id,
        summary: row.summary,
        kind: row.kind,
        messageCount: row.message_count,
        awaitingAnswer: row.awaiting_answer === 1,
        run: runs.get(row.id) ?? null,
      }));
  }

  fork(forkId: string) {
    return toFork(this.requireForkRow(forkId));
  }

  setForkAwareness(forkId: string, awareness: ForkAwareness) {
    const row = this.requireWritableFork(forkId);
    this.db.run(
      'UPDATE forks SET awareness = ?, updated_at = ? WHERE id = ?',
      awareness,
      this.now(),
      forkId,
    );
    const fork = toFork(this.requireForkRow(forkId));
    this.publish([[row.exploration_id, { type: 'fork.updated', fork }]]);
    return fork;
  }

  // The chat's other forks that are not archived, each with its messages after `afterRowid` and
  // the start of its newest answer, for an engine to hear what happened elsewhere.
  otherForks(forkId: string, afterRowid = 0) {
    const fork = this.requireForkRow(forkId);
    return this.db
      .all<{ id: string; summary: string; new_messages: number; latest_answer: string | null }>(
        `SELECT forks.id, forks.summary,
           (SELECT count(*) FROM messages
             WHERE messages.fork_id = forks.id AND messages.rowid > ?) AS new_messages,
           (SELECT content FROM messages
             WHERE messages.fork_id = forks.id AND messages.role = 'assistant'
             ORDER BY rowid DESC LIMIT 1) AS latest_answer
         FROM forks
         WHERE exploration_id = ? AND id != ? AND archived_at IS NULL
         ORDER BY created_at, rowid`,
        afterRowid,
        fork.exploration_id,
        forkId,
      )
      .map((row) => ({
        forkId: row.id,
        summary: row.summary || 'Untitled fork',
        newMessages: row.new_messages,
        latestAnswer: row.latest_answer ? excerptOf(withoutTagLines(row.latest_answer)) : null,
      }));
  }

  newestMessageRowid(explorationId: string) {
    return (
      this.db.get<{ rowid: number | null }>(
        'SELECT max(rowid) AS rowid FROM messages WHERE exploration_id = ?',
        explorationId,
      )?.rowid ?? 0
    );
  }

  // Reading is allowed in archived chats and forks too, so their unread marks can be cleared.
  markRead(explorationId: string, messageIds: string[]) {
    this.requireExplorationRow(explorationId);
    const readAt = this.now();
    const changedIds = messageIds.filter(
      (messageId) =>
        this.db.run(
          'UPDATE messages SET read_at = ? WHERE id = ? AND exploration_id = ? AND read_at IS NULL',
          readAt,
          messageId,
          explorationId,
        ).changes > 0,
    );
    this.publishReadChange(explorationId, changedIds, readAt);
    return { messageIds: changedIds, readAt };
  }

  // The answer and every later answer of Claude's on the path of the fork being read.
  markUnreadFrom(messageId: string, viewForkId: string) {
    const message = this.requireMessageRow(messageId);
    const viewFork = this.requireForkRow(viewForkId, message.exploration_id);
    if (message.role !== 'assistant') {
      throw new StoreError('invalid', "Only an answer of Claude's can be marked unread.");
    }
    const path = this.pathTo(viewFork.tip_message_id ?? viewFork.base_message_id);
    const start = path.findIndex((row) => row.id === messageId);
    if (start === -1) {
      throw new StoreError('invalid', `Message ${messageId} is not in fork ${viewForkId}.`);
    }
    const changedIds = path
      .slice(start)
      .filter((row) => row.role === 'assistant' && row.read_at !== null)
      .map((row) => row.id);
    for (const changedId of changedIds) {
      this.db.run('UPDATE messages SET read_at = NULL WHERE id = ?', changedId);
    }
    this.publishReadChange(message.exploration_id, changedIds, null);
    return { messageIds: changedIds, readAt: null };
  }

  private publishReadChange(explorationId: string, messageIds: string[], readAt: number | null) {
    if (messageIds.length === 0) return;
    this.publish([[explorationId, { type: 'messages.read', messageIds, readAt }]]);
  }

  readFork(forkId: string, limit?: number): ForkRead {
    const fork = this.requireForkRow(forkId);
    const path = this.pathTo(fork.tip_message_id);
    const kept = limit === undefined ? path : path.slice(-limit);
    const omittedRows = path.slice(0, path.length - kept.length);
    const omittedForkIds = [...new Set(omittedRows.map((row) => row.fork_id))];
    return {
      forkId,
      messages: kept.map((row) => ({
        id: row.id,
        forkId: row.fork_id,
        role: row.role,
        text: this.messageText(row),
      })),
      omitted:
        omittedRows.length === 0
          ? null
          : {
              count: omittedRows.length,
              forks: omittedForkIds.map((id) => ({ id, summary: this.requireForkRow(id).summary })),
            },
    };
  }

  // A page of a fork's path for the job tools, newest last, going back from `before`. Long
  // messages are cut, so one answer cannot fill the reader's context.
  readForkPage(forkId: string, options: { limit: number; before?: string | undefined }) {
    const fork = this.requireForkRow(forkId);
    const path = this.pathTo(fork.tip_message_id);
    const end = options.before ? path.findIndex((row) => row.id === options.before) : path.length;
    if (end === -1) {
      throw new StoreError('not_found', `Message ${options.before} is not in fork ${forkId}.`);
    }
    const start = Math.max(0, end - options.limit);
    return {
      forkId,
      summary: fork.summary,
      messages: path.slice(start, end).map((row) => {
        const text = this.messageText(row);
        return {
          id: row.id,
          forkId: row.fork_id,
          role: row.role,
          text: text.length > pageMessageLength ? `${text.slice(0, pageMessageLength)}…` : text,
          truncated: text.length > pageMessageLength,
        };
      }),
      nextBefore: start > 0 ? path[start]!.id : null,
    };
  }

  addAssistantMessage(input: {
    shimId: string;
    forkId: string;
    inReplyTo: string;
    content: string;
  }) {
    const fork = this.requireForkRow(input.forkId);
    this.requireAttachedShim(fork.exploration_id, input.shimId);
    if (fork.tip_message_id !== input.inReplyTo) {
      throw new StoreError(
        'stale_tip',
        `Fork ${fork.id} ends with message ${fork.tip_message_id}, not ${input.inReplyTo}. Call read_fork and answer its last message.`,
      );
    }
    const tip = this.requireMessageRow(input.inReplyTo);
    if (tip.role !== 'user') {
      throw new StoreError('invalid', `Fork ${fork.id} is not awaiting an answer.`);
    }
    const { message, fork: updatedFork } = this.db.transaction(() => {
      const appended = this.appendMessage(fork, 'assistant', repairMarkdown(input.content), 'live');
      this.keepFilesShownIn(appended.message);
      return appended;
    });
    this.publish([
      [
        fork.exploration_id,
        { type: 'message.added', message: toMessage(message), fork: toFork(updatedFork) },
      ],
    ]);
    return toMessage(message);
  }

  // An answer from a runner's turn. It goes after the fork's newest message, which may be one the
  // reader sent while Claude was working; its tags say which messages it answers.
  addRunnerAnswer(forkId: string, content: string) {
    const fork = this.requireWritableFork(forkId);
    const { message, fork: updatedFork } = this.db.transaction(() => {
      const appended = this.appendMessage(fork, 'assistant', repairMarkdown(content), 'live');
      this.keepFilesShownIn(appended.message);
      return appended;
    });
    this.publish([
      [
        fork.exploration_id,
        { type: 'message.added', message: toMessage(message), fork: toFork(updatedFork) },
      ],
    ]);
    return toMessage(message);
  }

  // A message from the session answering the main fork, which supervises the chat's other forks.
  addSupervisorMessage(forkId: string, text: string) {
    const fork = this.requireWritableFork(forkId);
    if (fork.parent_fork_id === null) {
      throw new StoreError('invalid', 'The main fork is yours to answer; message the other forks.');
    }
    if (!text.trim()) throw new StoreError('invalid', 'Write a message for the fork.');
    const { message, fork: updatedFork } = this.db.transaction(() =>
      this.appendMessage(fork, 'user', `${supervisorMessagePrefix}\n\n${text.trim()}`, 'live'),
    );
    this.publish([
      [
        fork.exploration_id,
        { type: 'message.added', message: toMessage(message), fork: toFork(updatedFork) },
      ],
    ]);
    return toMessage(message);
  }

  createComment(explorationId: string, input: NewComment) {
    const existing = input.id
      ? this.existingRow<CommentRow>('comments', input.id, explorationId)
      : null;
    if (existing) return toComment(existing);
    const viewFork = this.requireWritableFork(input.viewForkId, explorationId);
    this.requireShownIn(viewFork, input.messageId);
    if (!input.body.trim() && input.editBody === undefined) {
      throw new StoreError('invalid', 'A comment needs a body.');
    }
    // Without a quote it is a general comment, on the conversation up to its message.
    const offsetsValid = input.quote
      ? input.startOffset >= 0 && input.endOffset > input.startOffset
      : input.startOffset === 0 && input.endOffset === 0;
    if (!offsetsValid) {
      throw new StoreError('invalid', 'The comment anchor offsets are out of order.');
    }
    if (input.noteGroupId) this.requireNoteGroupRow(input.noteGroupId, explorationId);
    const id = input.id ?? newId();
    const createdAt = this.now();
    this.db.run(
      `INSERT INTO comments (id, exploration_id, message_id, view_fork_id, quote, start_offset,
         end_offset, body, edit_body, type, note_group_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      id,
      explorationId,
      input.messageId,
      input.viewForkId,
      input.quote,
      input.startOffset,
      input.endOffset,
      input.body.trim(),
      input.editBody ?? null,
      input.type ?? 'inline',
      input.noteGroupId ?? null,
      createdAt,
      createdAt,
    );
    const comment = toComment(this.requireCommentRow(id));
    this.publish([[explorationId, { type: 'comment.created', comment }]]);
    return comment;
  }

  updateComment(commentId: string, changes: CommentChanges) {
    const row = this.requireDraft(commentId);
    this.requireWritable(row.exploration_id);
    if (changes.body !== undefined && !changes.body.trim()) {
      throw new StoreError('invalid', 'A comment body cannot be empty.');
    }
    if (changes.noteGroupId) this.requireNoteGroupRow(changes.noteGroupId, row.exploration_id);
    const leavesGroup = changes.type === 'note';
    const groupChanges = leavesGroup ? this.forkGroupChangesWithout(row) : new Map();
    this.db.transaction(() => {
      this.db.run(
        `UPDATE comments SET body = ?, edit_body = ?, type = ?, note_group_id = ?, updated_at = ?
         WHERE id = ?`,
        changes.body?.trim() ?? row.body,
        changes.editBody === undefined ? row.edit_body : changes.editBody,
        changes.type ?? row.type,
        changes.noteGroupId === undefined ? row.note_group_id : changes.noteGroupId,
        this.now(),
        commentId,
      );
      this.saveForkGroups(groupChanges);
    });
    groupChanges.delete(commentId);
    const comment = toComment(this.requireCommentRow(commentId));
    this.publish([[row.exploration_id, { type: 'comment.updated', comment }]]);
    this.publishCommentUpdates(row.exploration_id, [...groupChanges.keys()]);
    return comment;
  }

  deleteComment(commentId: string) {
    const row = this.requireDraft(commentId);
    this.requireWritable(row.exploration_id);
    const groupChanges = this.forkGroupChangesWithout(row);
    groupChanges.delete(commentId);
    this.db.transaction(() => {
      this.db.run('DELETE FROM comments WHERE id = ?', commentId);
      this.saveForkGroups(groupChanges);
    });
    this.publish([[row.exploration_id, { type: 'comment.deleted', commentId }]]);
    this.publishCommentUpdates(row.exploration_id, [...groupChanges.keys()]);
  }

  // Bookmarking the same passage again finds the bookmark it already has.
  createBookmark(explorationId: string, input: NewBookmark) {
    const existing = input.id
      ? this.existingRow<BookmarkRow>('bookmarks', input.id, explorationId)
      : null;
    if (existing) return toBookmark(existing);
    const fork = this.requireWritableFork(input.forkId, explorationId);
    this.requireShownIn(fork, input.messageId);
    if (!input.quote || input.startOffset < 0 || input.endOffset <= input.startOffset) {
      throw new StoreError('invalid', 'A bookmark needs a quote and offsets in order.');
    }
    const id = input.id ?? newId();
    const inserted = this.db.run(
      `INSERT INTO bookmarks (id, exploration_id, fork_id, message_id, quote, start_offset,
         end_offset, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (fork_id, message_id, start_offset, end_offset) DO NOTHING`,
      id,
      explorationId,
      input.forkId,
      input.messageId,
      input.quote,
      input.startOffset,
      input.endOffset,
      this.now(),
    );
    const bookmark = toBookmark(
      this.db.get<BookmarkRow>(
        `SELECT * FROM bookmarks
         WHERE fork_id = ? AND message_id = ? AND start_offset = ? AND end_offset = ?`,
        input.forkId,
        input.messageId,
        input.startOffset,
        input.endOffset,
      )!,
    );
    if (inserted.changes > 0) {
      this.publish([[explorationId, { type: 'bookmark.created', bookmark }]]);
    }
    return bookmark;
  }

  deleteBookmark(bookmarkId: string) {
    const row = this.db.get<BookmarkRow>('SELECT * FROM bookmarks WHERE id = ?', bookmarkId);
    if (!row) throw new StoreError('not_found', `Bookmark ${bookmarkId} does not exist.`);
    this.requireWritableFork(row.fork_id, row.exploration_id);
    this.db.run('DELETE FROM bookmarks WHERE id = ?', bookmarkId);
    this.publish([[row.exploration_id, { type: 'bookmark.deleted', bookmarkId }]]);
  }

  // The starting comment's group becomes it and the picked comments, which leave the groups they
  // were in. A group is one fork: its comments go there on Submit, whatever their own type.
  joinForkGroup(commentId: string, input: { memberIds: string[]; groupId?: string }) {
    const start = this.requireDraft(commentId);
    this.requireWritable(start.exploration_id);
    const joinableComments = this.draftJoinableComments(start.view_fork_id);
    const joinable = new Set(joinableComments.map((comment) => comment.id));
    if (![commentId, ...input.memberIds].every((id) => joinable.has(id))) {
      throw new StoreError('invalid', 'Only draft comments of the same fork, not notes, can join.');
    }
    const changes = joinForkGroup(
      joinableComments,
      commentId,
      input.memberIds,
      input.groupId ?? newId(),
    );
    this.db.transaction(() => this.saveForkGroups(changes));
    return this.publishCommentUpdates(start.exploration_id, [...changes.keys()]);
  }

  // Every comment of the group goes back to doing what its own type says.
  ungroupForkGroup(groupId: string) {
    const rows = this.db.all<CommentRow>(
      "SELECT * FROM comments WHERE fork_group_id = ? AND status = 'draft'",
      groupId,
    );
    const first = rows[0];
    if (!first) throw new StoreError('not_found', `Fork group ${groupId} not found.`);
    this.requireWritable(first.exploration_id);
    const changes = new Map(rows.map((row) => [row.id, null]));
    this.db.transaction(() => this.saveForkGroups(changes));
    return this.publishCommentUpdates(first.exploration_id, [...changes.keys()]);
  }

  leaveForkGroup(commentId: string) {
    const row = this.requireDraft(commentId);
    this.requireWritable(row.exploration_id);
    const changes = this.forkGroupChangesWithout(row);
    this.db.transaction(() => this.saveForkGroups(changes));
    return this.publishCommentUpdates(row.exploration_id, [...changes.keys()]);
  }

  submit(
    explorationId: string,
    forkId: string,
    globalMessage: string,
    options: { id?: string; newFork?: boolean; fileIds?: string[] } = {},
  ) {
    const { newFork = false, fileIds = [] } = options;
    const existing = options.id
      ? this.existingRow<SubmissionRow>('submissions', options.id, explorationId)
      : null;
    if (existing) return toQueuedSubmission(existing);
    const fork = this.requireWritableFork(forkId, explorationId);
    const drafts = this.draftsIn(forkId);
    const files = fileIds.map((fileId) => this.requireDraftFile(fileId));
    const message = globalMessage.trim();
    if (drafts.length === 0 && !message && files.length === 0) {
      throw new StoreError('invalid', 'Nothing to submit: no draft comments and no message.');
    }
    if (newFork && !message && files.length === 0 && !drafts.some(goesIntoReply)) {
      throw new StoreError('invalid', 'A new fork needs a message, a file or an inline comment.');
    }
    if (newFork && fork.tip_message_id === null) {
      throw new StoreError('invalid', 'This fork has no messages to fork from.');
    }
    if (drafts.some((draft) => draft.edit_body !== null)) {
      throw new StoreError('invalid', 'Save or cancel the comments being edited first.');
    }
    const noteDrafts = drafts.filter((draft) => draft.type === 'note');
    const claudeDrafts = drafts.filter((draft) => draft.type !== 'note');
    // Note comments alone ask nothing of Claude, so their submission is done at once. It is still
    // stored, so a repeated request finds it.
    const forClaude = claudeDrafts.length > 0 || message !== '' || files.length > 0;
    const id = options.id ?? newId();
    const noteEvents = this.db.transaction(() => {
      this.insertSubmission(
        { id, explorationId, forkId, message, newFork, delivered: !forClaude },
        claudeDrafts,
      );
      for (const file of files) {
        this.db.run(
          'UPDATE files SET exploration_id = ?, submission_id = ? WHERE id = ?',
          explorationId,
          id,
          file.id,
        );
      }
      this.db.run('UPDATE files SET draft_fork_id = NULL WHERE draft_fork_id = ?', forkId);
      this.db.run('DELETE FROM reply_drafts WHERE fork_id = ?', forkId);
      return this.notesFromComments(noteDrafts);
    });
    this.publish(noteEvents);
    this.publishReplyDraft(forkId);
    if (!forClaude) return toQueuedSubmission(this.requireSubmissionRow(id));
    const submission = this.publishSubmission(explorationId, id, claudeDrafts);
    if (files.length > 0) {
      this.publish([[explorationId, { type: 'files.updated', files: this.filesOf(id) }]]);
    }
    return submission;
  }

  // Sends one fork comment on its own; the other drafts and the reply box stay as they are.
  forkNow(commentId: string, options: { id?: string } = {}) {
    const comment = this.requireCommentRow(commentId);
    const explorationId = comment.exploration_id;
    const existing = options.id
      ? this.existingRow<SubmissionRow>('submissions', options.id, explorationId)
      : null;
    if (existing) return toQueuedSubmission(existing);
    const draft = this.requireDraft(commentId);
    this.requireWritableFork(draft.view_fork_id, explorationId);
    if (draft.type !== 'fork' && !draft.fork_group_id) {
      throw new StoreError(
        'invalid',
        'Only a fork comment or a group can start a fork on its own.',
      );
    }
    // A comment in a group starts the group's fork, with all of its comments.
    const comments = draft.fork_group_id
      ? this.draftsIn(draft.view_fork_id).filter(
          (comment) => comment.fork_group_id === draft.fork_group_id,
        )
      : [draft];
    if (comments.some((comment) => comment.edit_body !== null)) {
      throw new StoreError('invalid', 'Save or cancel the comment being edited first.');
    }
    const id = options.id ?? newId();
    const forkId = draft.view_fork_id;
    this.db.transaction(() => {
      this.insertSubmission(
        { id, explorationId, forkId, message: '', newFork: false, delivered: false },
        comments,
      );
    });
    return this.publishSubmission(explorationId, id, comments);
  }

  // Starts a fork of the main fork at once, holding one queued message about the note, so the
  // reader can open it before Claude answers. The main fork's drafts stay as they are.
  // A fork that starts after one of Claude's answers: its history ends with that answer, and the
  // first message written there replies to it. Named after the answer until Claude names it.
  forkAtAnswer(messageId: string, options: { forkId?: string } = {}) {
    const message = this.requireMessageRow(messageId);
    const explorationId = message.exploration_id;
    const existing = options.forkId
      ? this.db.get<ForkRow>('SELECT * FROM forks WHERE id = ?', options.forkId)
      : undefined;
    if (existing) {
      if (existing.exploration_id !== explorationId) {
        throw new StoreError('invalid', `Id ${options.forkId} is already taken.`);
      }
      return toFork(existing);
    }
    if (message.role !== 'assistant') {
      throw new StoreError('invalid', "Only one of Claude's answers can start a fork.");
    }
    this.requireWritableFork(message.fork_id, explorationId);
    const fork = this.insertFork({
      id: options.forkId,
      explorationId,
      parentForkId: message.fork_id,
      baseMessageId: message.id,
      originCommentId: null,
      summary: summaryFrom(withoutTagLines(message.content)),
    });
    this.publish([[explorationId, { type: 'fork.created', fork: toFork(fork) }]]);
    return toFork(fork);
  }

  forkFromNote(noteId: string, message: string, options: { id?: string; forkId?: string } = {}) {
    const note = toNote(this.requireNoteRow(noteId));
    const { explorationId } = note;
    const existing = options.id
      ? this.existingRow<SubmissionRow>('submissions', options.id, explorationId)
      : null;
    if (existing) return toQueuedSubmission(existing);
    if (!message.trim()) throw new StoreError('invalid', 'Write a message for the new fork.');
    const mainFork = this.db.get<ForkRow>(
      'SELECT * FROM forks WHERE exploration_id = ? AND parent_fork_id IS NULL',
      explorationId,
    )!;
    this.requireWritableFork(mainFork.id, explorationId);
    if (mainFork.tip_message_id === null) {
      throw new StoreError('invalid', 'This chat has no messages to fork from.');
    }
    const id = options.id ?? newId();
    const fork = this.db.transaction(() => {
      const fork = this.insertFork({
        id: options.forkId,
        explorationId,
        parentForkId: mainFork.id,
        baseMessageId: mainFork.tip_message_id,
        originCommentId: null,
        summary: summaryFrom(message.trim()),
      });
      this.insertSubmission(
        {
          id,
          explorationId,
          forkId: fork.id,
          message: noteForkMessage(note, message),
          newFork: false,
          delivered: false,
        },
        [],
      );
      return fork;
    });
    this.publish([[explorationId, { type: 'fork.created', fork: toFork(fork) }]]);
    return this.publishSubmission(explorationId, id, []);
  }

  cancelSubmission(submissionId: string) {
    const { row, commentIds, files } = this.db.transaction(() => {
      const row = this.requireSubmissionRow(submissionId);
      if (row.status !== 'queued') {
        throw new StoreError('already_sent', 'This submission was already sent to Claude.');
      }
      const commentIds = this.db
        .all<{ id: string }>('SELECT id FROM comments WHERE submission_id = ?', submissionId)
        .map(({ id }) => id);
      const files = this.filesOf(submissionId);
      this.db.run(
        "UPDATE comments SET status = 'draft', submission_id = NULL WHERE submission_id = ?",
        submissionId,
      );
      this.db.run(
        'UPDATE files SET exploration_id = NULL, submission_id = NULL WHERE submission_id = ?',
        submissionId,
      );
      this.db.run('DELETE FROM submissions WHERE id = ?', submissionId);
      return { row, commentIds, files };
    });
    this.publishCommentUpdates(row.exploration_id, commentIds);
    this.publish([[row.exploration_id, { type: 'submission.cancelled', submissionId }]]);
    if (files.length > 0) {
      const fileIds = files.map((file) => file.id);
      this.publish([[row.exploration_id, { type: 'files.released', fileIds }]]);
    }
    return {
      globalMessage: row.global_message,
      newFork: row.new_fork === 1,
      files: files.map((file) => ({ ...file, submissionId: null })),
    };
  }

  // Queued submissions, and notes waiting for a topic from Claude.
  explorationsAwaitingClaude() {
    return this.db
      .all<{ exploration_id: string }>(
        `SELECT DISTINCT waiting.exploration_id FROM (
           SELECT exploration_id FROM submissions WHERE status = 'queued'
           UNION
           SELECT exploration_id FROM notes WHERE topic IS NULL
         ) AS waiting
         JOIN explorations ON explorations.id = waiting.exploration_id
         WHERE archived_at IS NULL AND deleted_at IS NULL`,
      )
      .map((row) => row.exploration_id);
  }

  queuedSubmissions(explorationId: string): QueuedSubmission[] {
    return this.queuedSubmissionRows(explorationId).map(toQueuedSubmission);
  }

  deliverQueued(explorationId: string) {
    const events = this.db.transaction(() => {
      const submissions = this.queuedSubmissionRows(explorationId);
      if (submissions.length === 0) return [];
      const events: PendingEvent[] = [];
      const addEvent = (event: ExplorationEvent) => events.push([explorationId, event]);
      const repliesByFork = new Map<
        string,
        { inline: CommentRow[]; globalMessages: string[]; submissionIds: string[]; files: number }
      >();
      const forkComments: CommentRow[] = [];

      // Before the replies to the same forks move their tips, so a new fork starts where
      // the reader saw the fork end.
      for (const submission of submissions.filter((row) => row.new_fork === 1)) {
        const comments = this.db.all<CommentRow>(
          'SELECT * FROM comments WHERE submission_id = ? ORDER BY created_at, rowid',
          submission.id,
        );
        const { fork, message } = this.createForkFromReply(
          submission,
          comments.filter(goesIntoReply),
        );
        forkComments.push(...comments.filter(startsAFork));
        this.db.run(
          'UPDATE files SET message_id = ? WHERE submission_id = ?',
          message.id,
          submission.id,
        );
        addEvent({ type: 'fork.created', fork: toFork(fork) });
        addEvent({ type: 'message.added', message: toMessage(message), fork: toFork(fork) });
      }

      for (const submission of submissions.filter((row) => row.new_fork === 0)) {
        const reply = repliesByFork.get(submission.fork_id) ?? {
          inline: [],
          globalMessages: [],
          submissionIds: [],
          files: 0,
        };
        reply.submissionIds.push(submission.id);
        reply.files += this.filesOf(submission.id).length;
        repliesByFork.set(submission.fork_id, reply);
        const comments = this.db.all<CommentRow>(
          'SELECT * FROM comments WHERE submission_id = ? ORDER BY created_at, rowid',
          submission.id,
        );
        reply.inline.push(...comments.filter(goesIntoReply));
        forkComments.push(...comments.filter(startsAFork));
        if (submission.global_message) reply.globalMessages.push(submission.global_message);
      }

      for (const [forkId, reply] of repliesByFork) {
        if (reply.inline.length === 0 && reply.globalMessages.length === 0 && reply.files === 0) {
          continue;
        }
        const { message, fork } = this.appendMessage(
          this.requireForkRow(forkId),
          'user',
          reply.globalMessages.join('\n\n'),
          'live',
        );
        for (const comment of reply.inline) {
          this.db.run(
            "UPDATE comments SET status = 'submitted', reply_message_id = ? WHERE id = ?",
            message.id,
            comment.id,
          );
        }
        for (const submissionId of reply.submissionIds) {
          this.db.run(
            'UPDATE files SET message_id = ? WHERE submission_id = ?',
            message.id,
            submissionId,
          );
        }
        addEvent({ type: 'message.added', message: toMessage(message), fork: toFork(fork) });
      }

      const forkGroups = new Map<string, CommentRow[]>();
      for (const comment of forkComments) {
        const key = comment.fork_group_id ?? comment.id;
        forkGroups.set(key, [...(forkGroups.get(key) ?? []), comment]);
      }
      for (const comments of forkGroups.values()) {
        const { fork, message } = this.createForkFromComments(comments);
        addEvent({ type: 'fork.created', fork: toFork(fork) });
        addEvent({ type: 'message.added', message: toMessage(message), fork: toFork(fork) });
      }

      const deliveredAt = this.now();
      for (const submission of submissions) {
        this.db.run(
          "UPDATE submissions SET status = 'delivered', delivered_at = ? WHERE id = ?",
          deliveredAt,
          submission.id,
        );
        const comments = this.db.all<CommentRow>(
          'SELECT * FROM comments WHERE submission_id = ? ORDER BY created_at, rowid',
          submission.id,
        );
        for (const comment of comments) {
          addEvent({ type: 'comment.updated', comment: toComment(comment) });
        }
        const files = this.filesOf(submission.id);
        if (files.length > 0) addEvent({ type: 'files.updated', files });
        addEvent({ type: 'submission.delivered', submissionId: submission.id });
      }
      return events;
    });
    this.publish(events);
    return events.length > 0;
  }

  pendingForks(explorationId: string): PendingFork[] {
    return this.db
      .all<ForkRow>(
        `SELECT forks.* FROM forks JOIN messages ON messages.id = forks.tip_message_id
         WHERE forks.exploration_id = ? AND messages.role = 'user'
         ORDER BY forks.created_at, forks.rowid`,
        explorationId,
      )
      .map((fork) => {
        const path = this.pathTo(fork.tip_message_id);
        const trailingUserMessages: MessageRow[] = [];
        for (const row of path.toReversed()) {
          if (row.role !== 'user' || row.fork_id !== fork.id) break;
          trailingUserMessages.unshift(row);
        }
        const isNewFork =
          fork.parent_fork_id !== null &&
          trailingUserMessages[0]?.parent_id === fork.base_message_id;
        const answered = path.at(-trailingUserMessages.length - 1);
        return {
          forkId: fork.id,
          parentForkId: fork.parent_fork_id,
          isNewFork,
          baseMessageId: fork.base_message_id,
          inReplyTo: fork.tip_message_id!,
          userMessages: trailingUserMessages.map((row) => ({
            id: row.id,
            text: this.messageText(row),
          })),
          repliesTo: answered
            ? { messageId: answered.id, excerpt: excerptOf(this.messageText(answered)) }
            : null,
        };
      });
  }

  attach(input: { explorationId: string; shimId: string; sessionId: string; takeover: boolean }) {
    const row = this.requireWritable(input.explorationId);
    const heldByOther =
      row.attached_shim_id !== null && row.attached_shim_id !== input.shimId && this.isLive(row);
    if (heldByOther && !input.takeover) {
      throw new StoreError(
        'attached_elsewhere',
        `Exploration ${row.id} is attached to Claude session ${row.attached_session_id}. Pass takeover to move it to this session.`,
      );
    }
    const now = this.now();
    this.db.transaction(() => {
      this.db.run(
        `UPDATE explorations SET ${clearAttachment}
         WHERE attached_shim_id = ? AND id != ?`,
        input.shimId,
        input.explorationId,
      );
      this.db.run(
        `UPDATE explorations SET attached_shim_id = ?, attached_session_id = ?, attached_seen_at = ?
         WHERE id = ?`,
        input.shimId,
        input.sessionId,
        now,
        input.explorationId,
      );
    });
    this.publish([[input.explorationId, { type: 'session.attached', shimId: input.shimId }]]);
  }

  detach(shimId: string) {
    const explorationIds = this.attachedExplorationIds(shimId);
    this.db.run(
      `UPDATE explorations SET ${clearAttachment}
       WHERE attached_shim_id = ?`,
      shimId,
    );
    return explorationIds;
  }

  // A new daemon has no background sessions yet, so attachments left by earlier ones are stale.
  releaseBackgroundAttachments() {
    this.db.run(
      `UPDATE explorations SET ${clearAttachment}
       WHERE attached_session_id = background_session_id`,
    );
  }

  heartbeat(shimId: string) {
    this.db.run(
      'UPDATE explorations SET attached_seen_at = ? WHERE attached_shim_id = ?',
      this.now(),
      shimId,
    );
    return this.attachedExplorationIds(shimId);
  }

  requireAttachedShim(explorationId: string, shimId: string) {
    const row = this.requireExplorationRow(explorationId);
    if (row.attached_shim_id !== shimId) {
      throw new StoreError(
        'detached',
        `This session is no longer attached to exploration ${explorationId}.`,
      );
    }
    this.db.run(
      'UPDATE explorations SET attached_seen_at = ? WHERE id = ?',
      this.now(),
      explorationId,
    );
  }

  attachment(explorationId: string): Attachment | null {
    const row = this.requireExplorationRow(explorationId);
    if (row.attached_shim_id === null) return null;
    return {
      shimId: row.attached_shim_id,
      sessionId: row.attached_session_id,
      live: this.isLive(row),
    };
  }

  explorationForSession(sessionId: string): Exploration | null {
    const row = this.db.get<ExplorationRow>(
      'SELECT * FROM explorations WHERE attached_session_id = ? ORDER BY attached_seen_at DESC LIMIT 1',
      sessionId,
    );
    return row ? toExploration(row) : null;
  }

  hasExploration(explorationId: string) {
    return (
      this.db.get(
        'SELECT 1 FROM explorations WHERE id = ? AND deleted_at IS NULL',
        explorationId,
      ) !== undefined
    );
  }

  messageContent(messageId: string) {
    return this.requireMessageRow(messageId).content;
  }

  messageText(row: MessageRow) {
    if (row.role === 'assistant') return row.content;
    const comments = this.db.all<CommentRow>(
      'SELECT * FROM comments WHERE reply_message_id = ? ORDER BY created_at, rowid',
      row.id,
    );
    const taggedComments = (comments.length > 1 ? this.inTextOrder(comments) : comments).map(
      (comment) => `${commentTag(comment.id)}\n${quotedText(comment.quote, comment.body, '\n')}`,
    );
    const content =
      row.content && comments.length > 0 ? `${messageTag(row.id)}\n${row.content}` : row.content;
    const paths = this.db
      .all<FileRow>('SELECT * FROM files WHERE message_id = ? ORDER BY created_at, rowid', row.id)
      .map((file) => `- ${file.path}`);
    const files = paths.length
      ? `Attached files (open them with the Read tool):\n${paths.join('\n')}`
      : '';
    return [...taggedComments, content, files].filter(Boolean).join('\n\n');
  }

  createFile(input: {
    id: string;
    name: string;
    kind: FileKind;
    mediaType: string;
    size: number;
    path: string;
  }) {
    this.db.run(
      `INSERT INTO files (id, name, kind, media_type, size, path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.name,
      input.kind,
      input.mediaType,
      input.size,
      input.path,
      this.now(),
    );
    return toMessageFile(this.requireFileRow(input.id));
  }

  fileRow(fileId: string) {
    return this.requireFileRow(fileId);
  }

  deleteDraftFile(fileId: string) {
    const row = this.requireDraftFile(fileId);
    this.db.run('DELETE FROM files WHERE id = ?', fileId);
    return row;
  }

  filePathsOf(explorationId: string) {
    return this.db
      .all<FileRow>('SELECT * FROM files WHERE exploration_id = ?', explorationId)
      .map((row) => row.path);
  }

  // Drafts belong to no exploration until submitted, so a closed page leaves them behind.
  deleteDraftFilesBefore(createdBefore: number) {
    return this.db.transaction(() => {
      const unused = `exploration_id IS NULL AND created_at < ?
        AND (draft_fork_id IS NULL OR draft_fork_id NOT IN (SELECT fork_id FROM reply_drafts))`;
      const rows = this.db.all<FileRow>(`SELECT * FROM files WHERE ${unused}`, createdBefore);
      this.db.run(`DELETE FROM files WHERE ${unused}`, createdBefore);
      return rows.map((row) => row.path);
    });
  }

  replyDraft(forkId: string): ReplyDraft {
    const row = this.db.get<ReplyDraftRow>('SELECT * FROM reply_drafts WHERE fork_id = ?', forkId);
    if (row) return this.toReplyDraft(row);
    this.requireForkRow(forkId);
    return { forkId, text: '', newFork: false, files: [], updatedAt: 0 };
  }

  // An empty draft is no draft: its row goes, so a fork never keeps a blank one around.
  saveReplyDraft(forkId: string, input: { text: string; newFork: boolean; fileIds: string[] }) {
    const fork = this.requireForkRow(forkId);
    this.requireWritable(fork.exploration_id);
    const files = input.fileIds.map((fileId) => this.requireDraftFile(fileId));
    this.db.transaction(() => {
      this.db.run('UPDATE files SET draft_fork_id = NULL WHERE draft_fork_id = ?', forkId);
      for (const file of files) {
        this.db.run('UPDATE files SET draft_fork_id = ? WHERE id = ?', forkId, file.id);
      }
      if (!input.text && !input.newFork && files.length === 0) {
        this.db.run('DELETE FROM reply_drafts WHERE fork_id = ?', forkId);
        return;
      }
      this.db.run(
        `INSERT INTO reply_drafts (fork_id, exploration_id, text, new_fork, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (fork_id) DO UPDATE SET
           text = excluded.text, new_fork = excluded.new_fork, updated_at = excluded.updated_at`,
        forkId,
        fork.exploration_id,
        input.text,
        input.newFork ? 1 : 0,
        this.now(),
      );
    });
    return this.publishReplyDraft(forkId);
  }

  // Other pages showing the fork's reply box follow what one of them saved or submitted.
  private publishReplyDraft(forkId: string) {
    const draft = this.replyDraft(forkId);
    const { exploration_id: explorationId } = this.requireForkRow(forkId);
    this.publish([[explorationId, { type: 'reply-draft.updated', draft }]]);
    return draft;
  }

  createNoteGroup(explorationId: string, input: NewNoteGroup) {
    const existing = input.id
      ? this.existingRow<NoteGroupRow>('note_groups', input.id, explorationId)
      : null;
    if (existing) return toNoteGroup(existing);
    this.requireWritable(explorationId);
    const group = toNoteGroup(this.insertNoteGroup(explorationId, input));
    this.publish([[explorationId, { type: 'note-group.created', group }]]);
    return group;
  }

  updateNoteGroup(groupId: string, changes: NoteGroupChanges) {
    const row = this.requireNoteGroupRow(groupId);
    this.requireWritable(row.exploration_id);
    const name =
      changes.name === undefined
        ? row.name
        : changes.name.trim() || this.defaultGroupNameIn(row.exploration_id, groupId);
    const checklist = changes.checklist === undefined ? row.checklist : changes.checklist ? 1 : 0;
    this.db.run(
      'UPDATE note_groups SET name = ?, checklist = ?, updated_at = ? WHERE id = ?',
      name,
      checklist,
      this.now(),
      groupId,
    );
    const group = toNoteGroup(this.requireNoteGroupRow(groupId));
    this.publish([[row.exploration_id, { type: 'note-group.updated', group }]]);
    return group;
  }

  // Its notes go with it.
  deleteNoteGroup(groupId: string) {
    const row = this.requireNoteGroupRow(groupId);
    this.requireWritable(row.exploration_id);
    this.db.run('DELETE FROM note_groups WHERE id = ?', groupId);
    this.publish([[row.exploration_id, { type: 'note-group.deleted', groupId }]]);
  }

  // A new note goes first in its group.
  createNote(explorationId: string, input: NewNote) {
    const existing = input.id ? this.existingRow<NoteRow>('notes', input.id, explorationId) : null;
    if (existing) return toNote(existing);
    this.requireWritable(explorationId);
    const group = this.requireNoteGroupRow(input.groupId, explorationId);
    const topic = input.topic?.trim() ?? '';
    const description = input.description?.trim() ?? '';
    if (!topic && !description) {
      throw new StoreError('invalid', 'A note needs a topic or a description.');
    }
    const id = input.id ?? newId();
    const events = this.db.transaction(() =>
      this.insertNote({
        id,
        groupId: group.id,
        topic: topic || null,
        description,
        createdBy: 'user',
      }),
    );
    this.publish(events);
    return toNote(this.requireNoteRow(id));
  }

  updateNote(noteId: string, changes: NoteChanges) {
    const row = this.requireNoteRow(noteId);
    this.requireWritable(row.exploration_id);
    const topic = changes.topic === undefined ? row.topic : changes.topic.trim() || null;
    const description = changes.description?.trim() ?? row.description;
    if (!topic && !description) {
      throw new StoreError('invalid', 'A note needs a topic or a description.');
    }
    const checked = changes.checked === undefined ? row.checked : changes.checked ? 1 : 0;
    this.db.run(
      'UPDATE notes SET topic = ?, description = ?, checked = ?, updated_at = ? WHERE id = ?',
      topic,
      description,
      checked,
      this.now(),
      noteId,
    );
    const note = toNote(this.requireNoteRow(noteId));
    this.publish([[row.exploration_id, { type: 'note.updated', note }]]);
    return note;
  }

  deleteNote(noteId: string) {
    const row = this.requireNoteRow(noteId);
    this.requireWritable(row.exploration_id);
    this.db.run('DELETE FROM notes WHERE id = ?', noteId);
    this.publish([[row.exploration_id, { type: 'note.deleted', noteId }]]);
  }

  // Applied to the order as it is now, so moves made elsewhere since the page loaded are kept.
  reorderNote(noteId: string, afterNoteId: string | null) {
    const row = this.requireNoteRow(noteId);
    this.requireWritable(row.exploration_id);
    const noteIds = this.db.transaction(() => {
      const noteIds = reorderedIds(this.noteIdsIn(row.group_id), noteId, afterNoteId);
      this.writeNoteOrder(noteIds);
      return noteIds;
    });
    this.publish([
      [row.exploration_id, { type: 'notes.reordered', groupId: row.group_id, noteIds }],
    ]);
    return { groupId: row.group_id, noteIds };
  }

  // The note goes first in its new group.
  changeNoteGroup(noteId: string, groupId: string) {
    const row = this.requireNoteRow(noteId);
    this.requireWritable(row.exploration_id);
    const group = this.requireNoteGroupRow(groupId, row.exploration_id);
    const noteIds = this.db.transaction(() => {
      if (group.id === row.group_id) return this.noteIdsIn(group.id);
      this.db.run(
        'UPDATE notes SET group_id = ?, position = 0, updated_at = ? WHERE id = ?',
        group.id,
        this.now(),
        noteId,
      );
      this.renumberNotes(row.group_id);
      return this.renumberNotes(group.id);
    });
    const note = toNote(this.requireNoteRow(noteId));
    this.publish([[row.exploration_id, { type: 'note.group-changed', note, noteIds }]]);
    return { note, noteIds };
  }

  // Claude's notes go first in the group in the order given, linked to the message that asked.
  addNotes(input: {
    explorationId: string;
    groupId: string;
    notes: { topic?: string | undefined; description?: string | undefined }[];
    sourceMessageId?: string | undefined;
  }) {
    const { explorationId } = input;
    this.requireWritable(explorationId);
    const group = this.requireNoteGroupRow(input.groupId, explorationId);
    const notes = input.notes.map((note) => ({
      id: newId(),
      topic: note.topic?.trim() ?? '',
      description: note.description?.trim() ?? '',
    }));
    if (notes.some((note) => !note.topic && !note.description)) {
      throw new StoreError('invalid', 'Every note needs a topic or a description.');
    }
    const message = input.sourceMessageId ? this.requireMessageRow(input.sourceMessageId) : null;
    if (message && message.exploration_id !== explorationId) {
      throw new StoreError('not_found', `Message ${input.sourceMessageId} does not exist.`);
    }
    const source = message
      ? {
          forkId: message.fork_id,
          messageId: message.id,
          quote: null,
          startOffset: null,
          endOffset: null,
          commentId: null,
        }
      : undefined;
    const events = this.db.transaction(() =>
      notes.toReversed().flatMap((note) =>
        this.insertNote({
          id: note.id,
          groupId: group.id,
          topic: note.topic || null,
          description: note.description,
          createdBy: 'claude',
          source,
        }),
      ),
    );
    this.publish(events);
    return { noteIds: notes.map((note) => note.id) };
  }

  notesNeedingTopic(explorationId: string): NoteNeedingTopic[] {
    return this.db
      .all<NoteRow>(
        'SELECT * FROM notes WHERE exploration_id = ? AND topic IS NULL ORDER BY created_at, rowid',
        explorationId,
      )
      .map((row) => ({ noteId: row.id, groupId: row.group_id, description: row.description }));
  }

  notesIndex(explorationId: string): NotesIndex {
    return {
      groups: this.groupsWithNotes(explorationId).map(({ group, notes }) => ({
        id: group.id,
        name: group.name,
        checklist: group.checklist === 1,
        notes: notes.map((note) => ({
          id: note.id,
          topic: note.topic,
          checked: note.checked === 1,
        })),
      })),
    };
  }

  readNotes(explorationId: string, groupId?: string): NotesRead {
    this.requireExplorationRow(explorationId);
    if (groupId !== undefined) this.requireNoteGroupRow(groupId, explorationId);
    return {
      groups: this.groupsWithNotes(explorationId)
        .filter(({ group }) => groupId === undefined || group.id === groupId)
        .map(({ group, notes }) => ({
          id: group.id,
          name: group.name,
          checklist: group.checklist === 1,
          notes: notes.map((note) => ({
            id: note.id,
            topic: note.topic,
            description: note.description,
            checked: note.checked === 1,
            createdBy: note.created_by,
            deletionRequested: note.deletion_requested_at !== null,
          })),
        })),
    };
  }

  forkExplorationId(forkId: string) {
    return this.requireForkRow(forkId).exploration_id;
  }

  noteExplorationId(noteId: string) {
    return this.requireNoteRow(noteId).exploration_id;
  }

  note(noteId: string) {
    return toNote(this.requireNoteRow(noteId));
  }

  // Claude never deletes a note itself: the page shows the request and the user decides.
  requestNoteDeletion(noteId: string) {
    return this.setDeletionRequestedAt(noteId, this.now());
  }

  keepNote(noteId: string) {
    return this.setDeletionRequestedAt(noteId, null);
  }

  private setDeletionRequestedAt(noteId: string, requestedAt: number | null) {
    const row = this.requireNoteRow(noteId);
    this.requireWritable(row.exploration_id);
    this.db.run(
      'UPDATE notes SET deletion_requested_at = ?, updated_at = ? WHERE id = ?',
      requestedAt,
      this.now(),
      noteId,
    );
    const note = toNote(this.requireNoteRow(noteId));
    this.publish([[row.exploration_id, { type: 'note.updated', note }]]);
    return note;
  }

  private groupsWithNotes(explorationId: string) {
    const notes = this.db.all<NoteRow>(
      'SELECT * FROM notes WHERE exploration_id = ? ORDER BY position, rowid',
      explorationId,
    );
    return this.db
      .all<NoteGroupRow>(
        'SELECT * FROM note_groups WHERE exploration_id = ? ORDER BY position, rowid',
        explorationId,
      )
      .map((group) => ({ group, notes: notes.filter((note) => note.group_id === group.id) }));
  }

  private insertNoteGroup(explorationId: string, input: NewNoteGroup) {
    const id = input.id ?? newId();
    const createdAt = this.now();
    this.db.run(
      `INSERT INTO note_groups (id, exploration_id, name, checklist, position, created_at, updated_at)
       VALUES (?, ?, ?, ?,
         (SELECT coalesce(max(position), 0) + 1 FROM note_groups WHERE exploration_id = ?), ?, ?)`,
      id,
      explorationId,
      input.name?.trim() || this.defaultGroupNameIn(explorationId),
      input.checklist ? 1 : 0,
      explorationId,
      createdAt,
      createdAt,
    );
    return this.requireNoteGroupRow(id);
  }

  // Goes first in its group. Returns the events to publish once the transaction is over.
  private insertNote(input: {
    id: string;
    groupId: string;
    topic: string | null;
    description: string;
    createdBy: NoteAuthor;
    source?: {
      forkId: string;
      messageId: string;
      quote: string | null;
      startOffset: number | null;
      endOffset: number | null;
      commentId: string | null;
    };
  }): PendingEvent[] {
    const group = this.requireNoteGroupRow(input.groupId);
    const createdAt = this.now();
    this.db.run(
      `INSERT INTO notes (id, exploration_id, group_id, topic, description, position,
         source_fork_id, source_message_id, source_quote, source_start_offset, source_end_offset,
         source_comment_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      group.exploration_id,
      group.id,
      input.topic,
      input.description,
      input.source?.forkId ?? null,
      input.source?.messageId ?? null,
      input.source?.quote ?? null,
      input.source?.startOffset ?? null,
      input.source?.endOffset ?? null,
      input.source?.commentId ?? null,
      input.createdBy,
      createdAt,
      createdAt,
    );
    const noteIds = this.renumberNotes(group.id);
    const note = toNote(this.requireNoteRow(input.id));
    return [
      [group.exploration_id, { type: 'note.created', note }],
      [group.exploration_id, { type: 'notes.reordered', groupId: group.id, noteIds }],
    ];
  }

  // A note comment becomes a note at once, in the group picked in the comment box. The ones that
  // asked for a new group share one, made only now.
  private notesFromComments(comments: CommentRow[]) {
    const events: PendingEvent[] = [];
    let newGroup: NoteGroupRow | null = null;
    for (const comment of comments) {
      const explorationId = comment.exploration_id;
      let group = comment.note_group_id
        ? this.requireNoteGroupRow(comment.note_group_id)
        : newGroup;
      if (!group) {
        group = newGroup = this.insertNoteGroup(explorationId, {});
        events.push([explorationId, { type: 'note-group.created', group: toNoteGroup(group) }]);
      }
      const noteId = newId();
      events.push(
        ...this.insertNote({
          id: noteId,
          groupId: group.id,
          topic: null,
          description: quotedText(comment.quote, comment.body, '\n\n'),
          createdBy: 'user',
          source: {
            forkId: comment.view_fork_id,
            messageId: comment.message_id,
            quote: comment.quote,
            startOffset: comment.start_offset,
            endOffset: comment.end_offset,
            commentId: comment.id,
          },
        }),
      );
      this.db.run(
        "UPDATE comments SET status = 'submitted', created_note_id = ?, updated_at = ? WHERE id = ?",
        noteId,
        this.now(),
        comment.id,
      );
      events.push([
        explorationId,
        { type: 'comment.updated', comment: toComment(this.requireCommentRow(comment.id)) },
      ]);
    }
    return events;
  }

  private defaultGroupNameIn(explorationId: string, exceptGroupId?: string) {
    const names = this.db
      .all<{ name: string }>(
        'SELECT name FROM note_groups WHERE exploration_id = ? AND id IS NOT ?',
        explorationId,
        exceptGroupId ?? null,
      )
      .map(({ name }) => name);
    return defaultGroupName(names);
  }

  private noteIdsIn(groupId: string) {
    return this.db
      .all<{ id: string }>(
        'SELECT id FROM notes WHERE group_id = ? ORDER BY position, rowid',
        groupId,
      )
      .map(({ id }) => id);
  }

  private writeNoteOrder(noteIds: string[]) {
    noteIds.forEach((noteId, index) => {
      this.db.run(
        'UPDATE notes SET position = ? WHERE id = ? AND position != ?',
        index + 1,
        noteId,
        index + 1,
      );
    });
  }

  private renumberNotes(groupId: string) {
    const noteIds = this.noteIdsIn(groupId);
    this.writeNoteOrder(noteIds);
    return noteIds;
  }

  private toReplyDraft(row: ReplyDraftRow): ReplyDraft {
    return {
      forkId: row.fork_id,
      text: row.text,
      newFork: row.new_fork === 1,
      files: this.db
        .all<FileRow>(
          'SELECT * FROM files WHERE draft_fork_id = ? ORDER BY created_at, rowid',
          row.fork_id,
        )
        .map(toMessageFile),
      updatedAt: row.updated_at,
    };
  }

  private insertFork(input: {
    id?: string;
    explorationId: string;
    parentForkId: string;
    baseMessageId: string | null;
    originCommentId: string | null;
    summary: string;
  }) {
    const forkId = input.id ?? newId();
    const createdAt = this.now();
    this.db.run(
      `INSERT INTO forks (id, exploration_id, parent_fork_id, base_message_id, origin_comment_id,
         summary, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      forkId,
      input.explorationId,
      input.parentForkId,
      input.baseMessageId,
      input.originCommentId,
      input.summary,
      createdAt,
      createdAt,
    );
    return this.requireForkRow(forkId);
  }

  private createForkFromReply(submission: SubmissionRow, inlineComments: CommentRow[]) {
    const parent = this.requireForkRow(submission.fork_id);
    const forkRow = this.insertFork({
      explorationId: submission.exploration_id,
      parentForkId: parent.id,
      baseMessageId: parent.tip_message_id,
      originCommentId: null,
      summary: summaryFrom(
        submission.global_message ||
          inlineComments[0]?.body ||
          this.filesOf(submission.id)[0]?.name ||
          '',
      ),
    });
    const { message, fork } = this.appendMessage(
      forkRow,
      'user',
      submission.global_message,
      'live',
    );
    for (const comment of inlineComments) {
      this.db.run(
        `UPDATE comments SET status = 'submitted', reply_message_id = ?, created_fork_id = ?
         WHERE id = ?`,
        message.id,
        fork.id,
        comment.id,
      );
    }
    return { message, fork };
  }

  // Joined fork comments start one fork. It branches after the latest message they quote, so all
  // the quoted text is in its history, and is named after the first comment in text order.
  private createForkFromComments(comments: CommentRow[]) {
    const ordered = this.inTextOrder(comments);
    const first = ordered[0]!;
    const base = this.requireMessageRow(ordered.at(-1)!.message_id);
    const forkRow = this.insertFork({
      explorationId: first.exploration_id,
      parentForkId: base.fork_id,
      baseMessageId: base.id,
      originCommentId: first.id,
      summary: summaryFrom(first.body),
    });
    const { message, fork } = this.appendMessage(forkRow, 'user', '', 'live');
    for (const comment of comments) {
      this.db.run(
        `UPDATE comments SET status = 'submitted', reply_message_id = ?, created_fork_id = ?
         WHERE id = ?`,
        message.id,
        fork.id,
        comment.id,
      );
    }
    return { message, fork };
  }

  private inTextOrder(comments: CommentRow[]) {
    const viewFork = this.requireForkRow(comments[0]!.view_fork_id);
    const messageOrder = this.pathTo(viewFork.tip_message_id).map((row) => row.id);
    const orderable = comments.map((row) => ({
      row,
      messageId: row.message_id,
      quote: row.quote,
      startOffset: row.start_offset,
    }));
    return inTextOrder(orderable, messageOrder).map(({ row }) => row);
  }

  private draftJoinableComments(forkId: string): (CommentRow & GroupableComment)[] {
    return this.draftsIn(forkId)
      .filter((comment) => comment.type !== 'note')
      .map((comment) => ({ ...comment, forkGroupId: comment.fork_group_id }));
  }

  private forkGroupChangesWithout(row: CommentRow) {
    if (!row.fork_group_id) return new Map<string, string | null>();
    return leaveForkGroup(this.draftJoinableComments(row.view_fork_id), row.id);
  }

  private saveForkGroups(changes: Map<string, string | null>) {
    const updatedAt = this.now();
    for (const [commentId, groupId] of changes) {
      this.db.run(
        'UPDATE comments SET fork_group_id = ?, updated_at = ? WHERE id = ?',
        groupId,
        updatedAt,
        commentId,
      );
    }
  }

  // An answer can show an uploaded file, such as a screenshot. The file then belongs to the answer,
  // so it is not cleaned up as an upload nobody sent.
  private keepFilesShownIn(message: MessageRow) {
    for (const [, fileId] of message.content.matchAll(fileReference)) {
      this.db.run(
        'UPDATE files SET exploration_id = ?, message_id = ? WHERE id = ? AND exploration_id IS NULL',
        message.exploration_id,
        message.id,
        fileId!,
      );
    }
  }

  private appendMessage(
    fork: ForkRow,
    role: Role,
    content: string,
    source: MessageSource,
    createdAt = this.now(),
  ) {
    const id = newId();
    const updatedAt = this.now();
    this.db.run(
      `INSERT INTO messages (id, exploration_id, fork_id, parent_id, role, content, source,
         created_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      fork.exploration_id,
      fork.id,
      fork.tip_message_id ?? fork.base_message_id,
      role,
      content,
      source,
      createdAt,
      role === 'assistant' && source === 'live' ? null : createdAt,
    );
    this.db.run(
      'UPDATE forks SET tip_message_id = ?, updated_at = ? WHERE id = ?',
      id,
      updatedAt,
      fork.id,
    );
    this.db.run(
      'UPDATE explorations SET updated_at = ? WHERE id = ?',
      updatedAt,
      fork.exploration_id,
    );
    return { message: this.requireMessageRow(id), fork: this.requireForkRow(fork.id) };
  }

  private requireShownIn(fork: ForkRow, messageId: string) {
    if (!this.pathTo(fork.tip_message_id).some((row) => row.id === messageId)) {
      throw new StoreError('invalid', `Message ${messageId} is not shown in fork ${fork.id}.`);
    }
  }

  private pathTo(messageId: string | null) {
    if (messageId === null) return [];
    return this.db.all<MessageRow>(
      `WITH RECURSIVE path (id, depth) AS (
         SELECT ?, 0
         UNION ALL
         SELECT messages.parent_id, path.depth + 1
         FROM messages JOIN path ON messages.id = path.id
         WHERE messages.parent_id IS NOT NULL
       )
       SELECT messages.* FROM path JOIN messages ON messages.id = path.id ORDER BY path.depth DESC`,
      messageId,
    );
  }

  private insertSubmission(
    submission: {
      id: string;
      explorationId: string;
      forkId: string;
      message: string;
      newFork: boolean;
      delivered: boolean;
    },
    drafts: CommentRow[],
  ) {
    const createdAt = this.now();
    this.db.run(
      `INSERT INTO submissions
         (id, exploration_id, fork_id, global_message, new_fork, status, created_at, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      submission.id,
      submission.explorationId,
      submission.forkId,
      submission.message,
      submission.newFork ? 1 : 0,
      submission.delivered ? 'delivered' : 'queued',
      createdAt,
      submission.delivered ? createdAt : null,
    );
    for (const draft of drafts) {
      this.db.run(
        "UPDATE comments SET status = 'queued', submission_id = ? WHERE id = ?",
        submission.id,
        draft.id,
      );
    }
  }

  private publishSubmission(explorationId: string, submissionId: string, drafts: CommentRow[]) {
    const submission = toQueuedSubmission(this.requireSubmissionRow(submissionId));
    this.publishCommentUpdates(
      explorationId,
      drafts.map((draft) => draft.id),
    );
    this.publish([[explorationId, { type: 'submission.queued', submission }]]);
    return submission;
  }

  private draftsIn(forkId: string) {
    return this.db.all<CommentRow>(
      "SELECT * FROM comments WHERE view_fork_id = ? AND status = 'draft' ORDER BY created_at, rowid",
      forkId,
    );
  }

  private queuedSubmissionRows(explorationId: string) {
    return this.db.all<SubmissionRow>(
      "SELECT * FROM submissions WHERE exploration_id = ? AND status = 'queued' ORDER BY created_at, rowid",
      explorationId,
    );
  }

  private attachedExplorationIds(shimId: string) {
    return this.db
      .all<{ id: string }>('SELECT id FROM explorations WHERE attached_shim_id = ?', shimId)
      .map(({ id }) => id);
  }

  private isLive(row: ExplorationRow) {
    return (
      row.attached_seen_at !== null && this.now() - row.attached_seen_at < attachmentLivenessMs
    );
  }

  private publishCommentUpdates(explorationId: string, commentIds: string[]): Comment[] {
    const comments = commentIds.map((id) => toComment(this.requireCommentRow(id)));
    this.publish(
      comments.map((comment) => [explorationId, { type: 'comment.updated', comment }] as const),
    );
    return comments;
  }

  private publish(events: readonly PendingEvent[]) {
    for (const [explorationId, event] of events) this.bus.publish(explorationId, event);
  }

  private requireExplorationRow(explorationId: string, options = { includeDeleted: false }) {
    const row = this.db.get<ExplorationRow>(
      'SELECT * FROM explorations WHERE id = ?',
      explorationId,
    );
    if (!row || (row.deleted_at !== null && !options.includeDeleted)) {
      throw new StoreError('not_found', `Exploration ${explorationId} does not exist.`);
    }
    return row;
  }

  private requireWritable(explorationId: string) {
    const row = this.requireExplorationRow(explorationId);
    if (row.archived_at !== null) {
      throw new StoreError(
        'archived',
        `Exploration ${explorationId} is archived. Restore it to continue.`,
      );
    }
    return row;
  }

  // A fork is read only while it or a fork above it is archived. Drafts can still be saved, so
  // text typed just before archiving is kept for when the fork is restored.
  requireWritableFork(forkId: string, explorationId?: string) {
    const row = this.requireForkRow(forkId, explorationId);
    this.requireWritable(row.exploration_id);
    const archived = this.db.get<{ id: string }>(
      `WITH RECURSIVE lineage(id, parent_fork_id, archived_at) AS (
         SELECT id, parent_fork_id, archived_at FROM forks WHERE id = ?
         UNION ALL
         SELECT forks.id, forks.parent_fork_id, forks.archived_at
           FROM forks JOIN lineage ON forks.id = lineage.parent_fork_id
       )
       SELECT id FROM lineage WHERE archived_at IS NOT NULL LIMIT 1`,
      forkId,
    );
    if (archived) {
      throw new StoreError('archived', `Fork ${forkId} is archived. Restore it to continue.`);
    }
    return row;
  }

  private setForkArchivedAt(forkId: string, archivedAt: number | null) {
    this.db.run('UPDATE forks SET archived_at = ? WHERE id = ?', archivedAt, forkId);
    const fork = toFork(this.requireForkRow(forkId));
    this.publish([[fork.explorationId, { type: 'fork.updated', fork }]]);
    return fork;
  }

  private publishExplorationUpdate(explorationId: string) {
    const exploration = toExploration(this.requireExplorationRow(explorationId));
    this.publish([[explorationId, { type: 'exploration.updated', exploration }]]);
    return exploration;
  }

  private requireForkRow(forkId: string, explorationId?: string) {
    const row = this.db.get<ForkRow>('SELECT * FROM forks WHERE id = ?', forkId);
    if (!row || (explorationId !== undefined && row.exploration_id !== explorationId)) {
      throw new StoreError('not_found', `Fork ${forkId} does not exist.`);
    }
    return row;
  }

  private requireMessageRow(messageId: string) {
    const row = this.db.get<MessageRow>('SELECT * FROM messages WHERE id = ?', messageId);
    if (!row) throw new StoreError('not_found', `Message ${messageId} does not exist.`);
    return row;
  }

  // A repeated request with an id the page made finds what the first one created.
  private existingRow<Row extends { exploration_id: string | null }>(
    table: 'comments' | 'submissions' | 'note_groups' | 'notes' | 'bookmarks',
    id: string,
    explorationId: string,
  ) {
    const row = this.db.get<Row>(`SELECT * FROM ${table} WHERE id = ?`, id);
    if (row && row.exploration_id !== explorationId) {
      throw new StoreError('invalid', `Id ${id} is already taken.`);
    }
    return row ?? null;
  }

  private requireCommentRow(commentId: string) {
    const row = this.db.get<CommentRow>('SELECT * FROM comments WHERE id = ?', commentId);
    if (!row) throw new StoreError('not_found', `Comment ${commentId} does not exist.`);
    return row;
  }

  private requireNoteGroupRow(groupId: string, explorationId?: string) {
    const row = this.db.get<NoteGroupRow>('SELECT * FROM note_groups WHERE id = ?', groupId);
    if (!row || (explorationId !== undefined && row.exploration_id !== explorationId)) {
      throw new StoreError('not_found', `Note group ${groupId} does not exist.`);
    }
    return row;
  }

  private requireNoteRow(noteId: string) {
    const row = this.db.get<NoteRow>('SELECT * FROM notes WHERE id = ?', noteId);
    if (!row) throw new StoreError('not_found', `Note ${noteId} does not exist.`);
    return row;
  }

  private requireDraft(commentId: string) {
    const row = this.requireCommentRow(commentId);
    if (row.status !== 'draft') {
      throw new StoreError('not_draft', 'Only draft comments can be changed.');
    }
    return row;
  }

  private filesOf(submissionId: string) {
    return this.db
      .all<FileRow>(
        'SELECT * FROM files WHERE submission_id = ? ORDER BY created_at, rowid',
        submissionId,
      )
      .map(toMessageFile);
  }

  private requireFileRow(fileId: string) {
    const row = this.db.get<FileRow>('SELECT * FROM files WHERE id = ?', fileId);
    if (!row) throw new StoreError('not_found', `File ${fileId} does not exist.`);
    return row;
  }

  private requireDraftFile(fileId: string) {
    const row = this.requireFileRow(fileId);
    if (row.exploration_id !== null) {
      throw new StoreError('not_draft', `File ${fileId} was already submitted.`);
    }
    return row;
  }

  private requireSubmissionRow(submissionId: string) {
    const row = this.db.get<SubmissionRow>('SELECT * FROM submissions WHERE id = ?', submissionId);
    if (!row) throw new StoreError('not_found', `Submission ${submissionId} does not exist.`);
    return row;
  }
}
