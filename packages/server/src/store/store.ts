import type { Database } from '../db/database.js';
import {
  toComment,
  toExploration,
  toFork,
  toMessage,
  toQueuedSubmission,
  type CommentRow,
  type ExplorationRow,
  type ForkRow,
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
  ForkKind,
  MessageSource,
  NewComment,
  QueuedSubmission,
  Role,
  Snapshot,
} from '../shared/types.js';
import { defaultClaudeModel, type ClaudeModel } from '../shared/models.js';
import { StoreError } from './errors.js';
import type { EventBus } from './event-bus.js';
import { newId } from './ids.js';

export const attachmentLivenessMs = 45_000;
const forkSummaryLength = 80;

export interface NewMessage {
  role: Role;
  content: string;
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

const summaryFrom = (text: string) => {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length > forkSummaryLength
    ? `${singleLine.slice(0, forkSummaryLength - 1)}…`
    : singleLine;
};

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
        mainFork = this.appendMessage(mainFork, message.role, message.content, 'import').fork;
      }
    });
    return {
      exploration: toExploration(this.requireExplorationRow(explorationId)),
      mainFork: toFork(this.requireForkRow(mainForkId)),
    };
  }

  listExplorations(): Omit<ExplorationListItem, 'sessionStatus'>[] {
    return this.db
      .all<ExplorationRow & { fork_count: number }>(
        `SELECT explorations.*,
           (SELECT count(*) FROM forks WHERE forks.exploration_id = explorations.id) AS fork_count
         FROM explorations ORDER BY updated_at DESC`,
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
    const exploration = toExploration(this.requireExplorationRow(explorationId));
    this.publish([[explorationId, { type: 'exploration.updated', exploration }]]);
    return exploration;
  }

  setModel(explorationId: string, model: ClaudeModel) {
    this.requireExplorationRow(explorationId);
    this.db.run(
      'UPDATE explorations SET model = ?, updated_at = ? WHERE id = ?',
      model,
      this.now(),
      explorationId,
    );
    const exploration = toExploration(this.requireExplorationRow(explorationId));
    this.publish([[explorationId, { type: 'exploration.updated', exploration }]]);
    return exploration;
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

  deleteExploration(explorationId: string) {
    this.requireExplorationRow(explorationId);
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
    this.requireExplorationRow(explorationId);
    const viewFork = this.requireForkRow(input.viewForkId, explorationId);
    const isOnPath = this.pathTo(viewFork.tip_message_id).some((row) => row.id === input.messageId);
    if (!isOnPath) {
      throw new StoreError(
        'invalid',
        `Message ${input.messageId} is not shown in fork ${viewFork.id}.`,
      );
    }
    if (!input.body.trim() || !input.quote) {
      throw new StoreError('invalid', 'A comment needs a quote and a body.');
    }
    if (input.startOffset < 0 || input.endOffset <= input.startOffset) {
      throw new StoreError('invalid', 'The comment anchor offsets are out of order.');
    }
    const id = newId();
    const createdAt = this.now();
    this.db.run(
      `INSERT INTO comments (id, exploration_id, message_id, view_fork_id, quote, start_offset,
         end_offset, body, type, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      id,
      explorationId,
      input.messageId,
      input.viewForkId,
      input.quote,
      input.startOffset,
      input.endOffset,
      input.body.trim(),
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
    if (changes.body !== undefined && !changes.body.trim()) {
      throw new StoreError('invalid', 'A comment body cannot be empty.');
    }
    this.db.run(
      'UPDATE comments SET body = ?, type = ?, updated_at = ? WHERE id = ?',
      changes.body?.trim() ?? row.body,
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
    this.db.run('DELETE FROM comments WHERE id = ?', commentId);
    this.publish([[row.exploration_id, { type: 'comment.deleted', commentId }]]);
  }

  toggleForkAll(explorationId: string, forkId: string) {
    this.requireForkRow(forkId, explorationId);
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

  submit(explorationId: string, forkId: string, globalMessage: string) {
    this.requireForkRow(forkId, explorationId);
    const drafts = this.draftsIn(forkId);
    const message = globalMessage.trim();
    if (drafts.length === 0 && !message) {
      throw new StoreError('invalid', 'Nothing to submit: no draft comments and no message.');
    }
    const id = newId();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO submissions (id, exploration_id, fork_id, global_message, status, created_at)
         VALUES (?, ?, ?, ?, 'queued', ?)`,
        id,
        explorationId,
        forkId,
        message,
        this.now(),
      );
      for (const draft of drafts) {
        this.db.run(
          "UPDATE comments SET status = 'queued', submission_id = ? WHERE id = ?",
          id,
          draft.id,
        );
      }
    });
    const submission = toQueuedSubmission(this.requireSubmissionRow(id));
    this.publishCommentUpdates(
      explorationId,
      drafts.map((draft) => draft.id),
    );
    this.publish([[explorationId, { type: 'submission.queued', submission }]]);
    return submission;
  }

  cancelSubmission(submissionId: string) {
    const { row, commentIds } = this.db.transaction(() => {
      const row = this.requireSubmissionRow(submissionId);
      if (row.status !== 'queued') {
        throw new StoreError('already_sent', 'This submission was already sent to Claude.');
      }
      const commentIds = this.db
        .all<{ id: string }>('SELECT id FROM comments WHERE submission_id = ?', submissionId)
        .map(({ id }) => id);
      this.db.run(
        "UPDATE comments SET status = 'draft', submission_id = NULL WHERE submission_id = ?",
        submissionId,
      );
      this.db.run('DELETE FROM submissions WHERE id = ?', submissionId);
      return { row, commentIds };
    });
    this.publishCommentUpdates(row.exploration_id, commentIds);
    this.publish([[row.exploration_id, { type: 'submission.cancelled', submissionId }]]);
    return { globalMessage: row.global_message };
  }

  explorationsWithQueuedSubmissions() {
    return this.db
      .all<{ exploration_id: string }>(
        "SELECT DISTINCT exploration_id FROM submissions WHERE status = 'queued'",
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
      const repliesByFork = new Map<string, { inline: CommentRow[]; globalMessages: string[] }>();
      const forkComments: CommentRow[] = [];

      for (const submission of submissions) {
        const reply = repliesByFork.get(submission.fork_id) ?? { inline: [], globalMessages: [] };
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
        if (reply.inline.length === 0 && reply.globalMessages.length === 0) continue;
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
        };
      });
  }

  attach(input: { explorationId: string; shimId: string; sessionId: string; takeover: boolean }) {
    const row = this.requireExplorationRow(input.explorationId);
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
        `UPDATE explorations SET attached_shim_id = NULL, attached_session_id = NULL, attached_seen_at = NULL
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
      `UPDATE explorations SET attached_shim_id = NULL, attached_session_id = NULL, attached_seen_at = NULL
       WHERE attached_shim_id = ?`,
      shimId,
    );
    return explorationIds;
  }

  // A new daemon has no background sessions yet, so attachments left by earlier ones are stale.
  releaseBackgroundAttachments() {
    this.db.run(
      `UPDATE explorations SET attached_shim_id = NULL, attached_session_id = NULL, attached_seen_at = NULL
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
    return this.db.get('SELECT 1 FROM explorations WHERE id = ?', explorationId) !== undefined;
  }

  messageText(row: MessageRow) {
    if (row.role === 'assistant') return row.content;
    const quotedComments = this.db
      .all<CommentRow>(
        'SELECT * FROM comments WHERE reply_message_id = ? ORDER BY created_at, rowid',
        row.id,
      )
      .map((comment) => `${quoteBlock(comment.quote)}\n${comment.body}`);
    return [...quotedComments, row.content].filter(Boolean).join('\n\n');
  }

  private createForkFromComment(comment: CommentRow) {
    const base = this.requireMessageRow(comment.message_id);
    const forkId = newId();
    const createdAt = this.now();
    this.db.run(
      `INSERT INTO forks (id, exploration_id, parent_fork_id, base_message_id, origin_comment_id,
         summary, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      forkId,
      comment.exploration_id,
      base.fork_id,
      base.id,
      comment.id,
      summaryFrom(comment.body),
      createdAt,
      createdAt,
    );
    const { message, fork } = this.appendMessage(this.requireForkRow(forkId), 'user', '', 'live');
    this.db.run(
      `UPDATE comments SET status = 'submitted', reply_message_id = ?, created_fork_id = ?
       WHERE id = ?`,
      message.id,
      forkId,
      comment.id,
    );
    return { message, fork };
  }

  private appendMessage(fork: ForkRow, role: Role, content: string, source: MessageSource) {
    const id = newId();
    const createdAt = this.now();
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
      createdAt,
      fork.id,
    );
    this.db.run(
      'UPDATE explorations SET updated_at = ? WHERE id = ?',
      createdAt,
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

  private requireExplorationRow(explorationId: string) {
    const row = this.db.get<ExplorationRow>(
      'SELECT * FROM explorations WHERE id = ?',
      explorationId,
    );
    if (!row) throw new StoreError('not_found', `Exploration ${explorationId} does not exist.`);
    return row;
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

  private requireSubmissionRow(submissionId: string) {
    const row = this.db.get<SubmissionRow>('SELECT * FROM submissions WHERE id = ?', submissionId);
    if (!row) throw new StoreError('not_found', `Submission ${submissionId} does not exist.`);
    return row;
  }
}
