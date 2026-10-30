import type { Database } from '../db/database.js';
import {
  toComment,
  toExploration,
  toFork,
  toMessage,
  toMessageFile,
  toQueuedSubmission,
  type CommentRow,
  type ExplorationRow,
  type FileRow,
  type ForkRow,
  type ReplyDraftRow,
  type MessageRow,
  type SubmissionRow,
} from '../db/rows.js';
import type {
  Comment,
  CommentChanges,
  CommentType,
  Exploration,
  ExplorationEvent,
  ExplorationListItem,
  ExplorationView,
  FileKind,
  ForkKind,
  MessageSource,
  NewComment,
  QueuedSubmission,
  ReplyDraft,
  Role,
  Snapshot,
} from '../shared/types.js';
import { defaultClaudeModel, type ClaudeModel } from '../shared/models.js';
import { StoreError } from './errors.js';
import type { EventBus } from './event-bus.js';
import { newId } from './ids.js';

export const attachmentLivenessMs = 45_000;
const forkSummaryLength = 80;
const repliesToExcerptLength = 300;
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

export interface ForkMapEntry {
  id: string;
  parentForkId: string | null;
  baseMessageId: string | null;
  summary: string;
  kind: ForkKind;
  messageCount: number;
  awaitingAnswer: boolean;
}

export interface ForkRead {
  forkId: string;
  messages: { id: string; forkId: string; role: Role; text: string }[];
  omitted: { count: number; forks: { id: string; summary: string }[] } | null;
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
const excerptOf = (text: string) => shortened(text, repliesToExcerptLength);

const quoteBlock = (quote: string) =>
  quote
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

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

  listExplorations(view: ExplorationView = 'active'): Omit<ExplorationListItem, 'sessionStatus'>[] {
    const filters: Record<ExplorationView, string> = {
      active: 'deleted_at IS NULL AND archived_at IS NULL ORDER BY updated_at DESC',
      archived: 'deleted_at IS NULL AND archived_at IS NOT NULL ORDER BY archived_at DESC',
      deleted: 'deleted_at IS NOT NULL ORDER BY deleted_at DESC',
    };
    return this.db
      .all<ExplorationRow & { fork_count: number }>(
        `SELECT explorations.*,
           (WITH RECURSIVE shown(id) AS (
              SELECT id FROM forks
               WHERE exploration_id = explorations.id AND parent_fork_id IS NULL
              UNION ALL
              SELECT forks.id FROM forks JOIN shown ON forks.parent_fork_id = shown.id
               WHERE forks.archived_at IS NULL
            ) SELECT count(*) FROM shown) AS fork_count
         FROM explorations WHERE ${filters[view]}`,
      )
      .map((row) => ({ ...toExploration(row), forkCount: row.fork_count }));
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
    };
  }

  updateExploration(input: {
    shimId: string;
    explorationId: string;
    title?: string | undefined;
    summary?: string | undefined;
  }) {
    const { explorationId } = input;
    this.requireAttachedShim(explorationId, input.shimId);
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

  updateForkSummary(input: { shimId: string; forkId: string; summary: string }) {
    const row = this.requireForkRow(input.forkId);
    this.requireAttachedShim(row.exploration_id, input.shimId);
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
    return this.db
      .all<ForkRow & { message_count: number; tip_role: Role | null }>(
        `SELECT forks.*,
           (SELECT count(*) FROM messages WHERE messages.fork_id = forks.id) AS message_count,
           (SELECT role FROM messages WHERE messages.id = forks.tip_message_id) AS tip_role
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
        awaitingAnswer: row.tip_role === 'user',
      }));
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
    const { message, fork: updatedFork } = this.db.transaction(() =>
      this.appendMessage(fork, 'assistant', input.content, 'live'),
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
    const isOnPath = this.pathTo(viewFork.tip_message_id).some((row) => row.id === input.messageId);
    if (!isOnPath) {
      throw new StoreError(
        'invalid',
        `Message ${input.messageId} is not shown in fork ${viewFork.id}.`,
      );
    }
    if ((!input.body.trim() && input.editBody === undefined) || !input.quote) {
      throw new StoreError('invalid', 'A comment needs a quote and a body.');
    }
    if (input.startOffset < 0 || input.endOffset <= input.startOffset) {
      throw new StoreError('invalid', 'The comment anchor offsets are out of order.');
    }
    const id = input.id ?? newId();
    const createdAt = this.now();
    this.db.run(
      `INSERT INTO comments (id, exploration_id, message_id, view_fork_id, quote, start_offset,
         end_offset, body, edit_body, type, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
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
    this.db.run(
      'UPDATE comments SET body = ?, edit_body = ?, type = ?, updated_at = ? WHERE id = ?',
      changes.body?.trim() ?? row.body,
      changes.editBody === undefined ? row.edit_body : changes.editBody,
      changes.type ?? row.type,
      this.now(),
      commentId,
    );
    const comment = toComment(this.requireCommentRow(commentId));
    this.publish([[row.exploration_id, { type: 'comment.updated', comment }]]);
    return comment;
  }

  deleteComment(commentId: string) {
    const row = this.requireDraft(commentId);
    this.requireWritable(row.exploration_id);
    this.db.run('DELETE FROM comments WHERE id = ?', commentId);
    this.publish([[row.exploration_id, { type: 'comment.deleted', commentId }]]);
  }

  toggleForkAll(explorationId: string, forkId: string) {
    this.requireWritableFork(forkId, explorationId);
    const drafts = this.draftsIn(forkId);
    if (drafts.length === 0) return [];
    const type: CommentType = drafts.every((draft) => draft.type === 'fork') ? 'inline' : 'fork';
    const updatedAt = this.now();
    this.db.transaction(() => {
      for (const draft of drafts) {
        this.db.run(
          'UPDATE comments SET type = ?, updated_at = ? WHERE id = ?',
          type,
          updatedAt,
          draft.id,
        );
      }
    });
    return this.publishCommentUpdates(
      explorationId,
      drafts.map((draft) => draft.id),
    );
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
    if (
      newFork &&
      !message &&
      files.length === 0 &&
      drafts.every((draft) => draft.type === 'fork')
    ) {
      throw new StoreError('invalid', 'A new fork needs a message, a file or an inline comment.');
    }
    if (newFork && fork.tip_message_id === null) {
      throw new StoreError('invalid', 'This fork has no messages to fork from.');
    }
    if (drafts.some((draft) => draft.edit_body !== null)) {
      throw new StoreError('invalid', 'Save or cancel the comments being edited first.');
    }
    const id = options.id ?? newId();
    this.db.transaction(() => {
      this.insertSubmission({ id, explorationId, forkId, message, newFork }, drafts);
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
    });
    const submission = this.publishSubmission(explorationId, id, drafts);
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
    if (draft.type !== 'fork') {
      throw new StoreError('invalid', 'Only a fork comment can start a fork on its own.');
    }
    if (draft.edit_body !== null) {
      throw new StoreError('invalid', 'Save or cancel the comment being edited first.');
    }
    const id = options.id ?? newId();
    const forkId = draft.view_fork_id;
    this.db.transaction(() => {
      this.insertSubmission({ id, explorationId, forkId, message: '', newFork: false }, [draft]);
    });
    return this.publishSubmission(explorationId, id, [draft]);
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

  explorationsWithQueuedSubmissions() {
    return this.db
      .all<{ exploration_id: string }>(
        `SELECT DISTINCT exploration_id FROM submissions
         JOIN explorations ON explorations.id = submissions.exploration_id
         WHERE status = 'queued' AND archived_at IS NULL AND deleted_at IS NULL`,
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
          comments.filter((comment) => comment.type === 'inline'),
        );
        forkComments.push(...comments.filter((comment) => comment.type === 'fork'));
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
        reply.inline.push(...comments.filter((comment) => comment.type === 'inline'));
        forkComments.push(...comments.filter((comment) => comment.type === 'fork'));
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

      for (const comment of forkComments) {
        const { fork, message } = this.createForkFromComment(comment);
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
    const quotedComments = this.db
      .all<CommentRow>(
        'SELECT * FROM comments WHERE reply_message_id = ? ORDER BY created_at, rowid',
        row.id,
      )
      .map((comment) => `${quoteBlock(comment.quote)}\n${comment.body}`);
    const paths = this.db
      .all<FileRow>('SELECT * FROM files WHERE message_id = ? ORDER BY created_at, rowid', row.id)
      .map((file) => `- ${file.path}`);
    const files = paths.length
      ? `Attached files (open them with the Read tool):\n${paths.join('\n')}`
      : '';
    return [...quotedComments, row.content, files].filter(Boolean).join('\n\n');
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
    return this.replyDraft(forkId);
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
    explorationId: string;
    parentForkId: string;
    baseMessageId: string | null;
    originCommentId: string | null;
    summary: string;
  }) {
    const forkId = newId();
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

  private createForkFromComment(comment: CommentRow) {
    const base = this.requireMessageRow(comment.message_id);
    const forkRow = this.insertFork({
      explorationId: comment.exploration_id,
      parentForkId: base.fork_id,
      baseMessageId: base.id,
      originCommentId: comment.id,
      summary: summaryFrom(comment.body),
    });
    const { message, fork } = this.appendMessage(forkRow, 'user', '', 'live');
    this.db.run(
      `UPDATE comments SET status = 'submitted', reply_message_id = ?, created_fork_id = ?
       WHERE id = ?`,
      message.id,
      fork.id,
      comment.id,
    );
    return { message, fork };
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
      `INSERT INTO messages (id, exploration_id, fork_id, parent_id, role, content, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      fork.exploration_id,
      fork.id,
      fork.tip_message_id ?? fork.base_message_id,
      role,
      content,
      source,
      createdAt,
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
    },
    drafts: CommentRow[],
  ) {
    this.db.run(
      `INSERT INTO submissions
         (id, exploration_id, fork_id, global_message, new_fork, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
      submission.id,
      submission.explorationId,
      submission.forkId,
      submission.message,
      submission.newFork ? 1 : 0,
      this.now(),
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
  private requireWritableFork(forkId: string, explorationId?: string) {
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
    table: 'comments' | 'submissions',
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
