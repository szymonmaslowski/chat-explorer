import { randomBytes } from 'node:crypto';
import type { Database } from '../db/database.js';
import {
  toActivity,
  isShimRunnerId,
  shimRunnerId,
  toForkRun,
  type ActivityRow,
  type ForkRunRow,
  type MessageRow,
} from '../db/rows.js';
import type { ActivityKind, CodingCapacity } from '@chat-explorer/shared/types.js';
import { StoreError } from './errors.js';
import type { EventBus } from './event-bus.js';
import { newId } from './ids.js';
import type { ChatStore } from './store.js';
import { type Lease, type PendingMessage, type RunUsage } from '@chat-explorer/shared/protocol.js';

export const leaseMs = 60_000;
// A runner that asked for work within this time counts as online.
const runnerOnlineMs = 90_000;
// After this many attempts that died before answering, the fork waits for Retry.
export const maxFailedAttempts = 3;
const maxUpdateLines = 10;
// A terminal session that answered and then made no step for this long has stopped working, as
// when the user interrupted it without it waiting for feedback again.
export const followUpIdleMs = 10 * 60_000;

export interface Job {
  forkId: string;
  explorationId: string;
  leaseId: string;
}

const noLease = {
  lease_id: null,
  runner_id: null,
  lease_expires_at: null,
  tools_token: null,
  stop_requested: 0,
} as const;

// The user messages of a fork after this rowid have not been answered: after the newest one a turn
// answered, or for a fork no runner has answered yet, after its newest answer.
const unansweredAfter = `COALESCE(
  (SELECT rowid FROM messages WHERE id = fork_runs.input_cursor),
  (SELECT max(rowid) FROM messages WHERE fork_id = forks.id AND role = 'assistant'),
  0
)`;

// The agent loop's side of the store: which forks need an answer, the lease of the runner working
// on each, the user messages it has not answered yet, and what it reports back.
export class RunStore {
  private lastRunnerSeenAt = 0;
  private codingCapacity: { capacity: CodingCapacity | null; at: number } | null = null;

  // Forks a terminal session answered and keeps holding while it works on before waiting for
  // feedback again, so its steps show under the answer: the answer's id and the last step's time.
  private readonly followUps = new Map<string, { answerId: string; lastStepAt: number }>();

  constructor(
    private readonly db: Database,
    private readonly bus: EventBus,
    private readonly chats: ChatStore,
    private readonly now: () => number = Date.now,
  ) {}

  // In a chat with a live terminal session attached, the session answers the main fork and the
  // runner the others. With no runner online the session, as `attachedShimId`, takes them all.
  claimable(attachedShimId?: string) {
    return this.db
      .all<{ fork_id: string; exploration_id: string }>(
        `SELECT forks.id AS fork_id, forks.exploration_id FROM forks
         JOIN explorations ON explorations.id = forks.exploration_id
         LEFT JOIN fork_runs ON fork_runs.fork_id = forks.id
         WHERE explorations.deleted_at IS NULL
           AND (fork_runs.lease_id IS NULL OR fork_runs.lease_expires_at <= ?)
           AND (fork_runs.status IS NULL OR fork_runs.status != 'failed')
           AND (
             EXISTS (
               SELECT 1 FROM messages
               WHERE messages.fork_id = forks.id AND messages.role = 'user'
                 AND messages.rowid > ${unansweredAfter}
             )
             OR EXISTS (
               SELECT 1 FROM submissions WHERE fork_id = forks.id AND status = 'queued'
             )
           )
         ORDER BY forks.created_at, forks.rowid`,
        this.now(),
      )
      .filter((row) => this.answerable(row.fork_id, row.exploration_id, attachedShimId))
      .map((row) => ({ forkId: row.fork_id, explorationId: row.exploration_id }));
  }

  runnerSeen() {
    this.lastRunnerSeenAt = this.now();
  }

  // How the chat looks from the runner's side: working while one of its forks is answered,
  // listening while a runner is around, detached otherwise.
  status(explorationId: string): 'answering' | 'listening' | 'detached' {
    const answering = this.db.get<{ fork_id: string }>(
      "SELECT fork_id FROM fork_runs WHERE exploration_id = ? AND status = 'answering' LIMIT 1",
      explorationId,
    );
    if (answering) return 'answering';
    return this.runnerOnline() ? 'listening' : 'detached';
  }

  // The runner repeats it while it runs, so one that went away stops counting.
  setCodingCapacity(capacity: CodingCapacity | null) {
    this.codingCapacity = { capacity, at: this.now() };
  }

  // Null while no runner is around, or its runner doesn't code.
  currentCodingCapacity() {
    const reported = this.codingCapacity;
    return reported && this.now() - reported.at < runnerOnlineMs ? reported.capacity : null;
  }

  private runnerOnline() {
    return this.now() - this.lastRunnerSeenAt < runnerOnlineMs;
  }

  // A lease that expired without being released belonged to a run that died: that attempt failed.
  claim(forkId: string, runnerId: string, attachedShimId?: string): Lease | null {
    this.deliverNewForks(forkId);
    const claimed = this.db.transaction(() => {
      const fork = this.claimable(attachedShimId).find((candidate) => candidate.forkId === forkId);
      if (!fork) return null;
      const row = this.ensureRow(forkId, fork.explorationId);
      let failedAttempts = row.failed_attempts;
      const died = row.lease_id !== null;
      if (died) {
        failedAttempts += 1;
        this.interrupt(row);
      }
      if (failedAttempts >= maxFailedAttempts) {
        this.update(forkId, {
          ...noLease,
          failed_attempts: failedAttempts,
          status: 'failed',
          status_detail: 'The runner stopped answering three times.',
        });
        return null;
      }
      const leaseId = newId();
      const toolsToken = randomBytes(24).toString('base64url');
      this.update(forkId, {
        lease_id: leaseId,
        runner_id: runnerId,
        lease_expires_at: this.now() + leaseMs,
        tools_token: toolsToken,
        attempt: row.attempt + 1,
        failed_attempts: failedAttempts,
        status: 'answering',
        status_detail: null,
      });
      return {
        forkId,
        explorationId: fork.explorationId,
        leaseId,
        attempt: row.attempt + 1,
        sessionId: row.session_id,
        toolsToken,
      };
    });
    this.publishRun(forkId);
    return claimed;
  }

  // A submission that starts a new fork waits on the fork it came from, which then looks like it
  // needs an answer. Delivering it creates the new fork, which does.
  private deliverNewForks(forkId: string) {
    const startsAFork = this.db.get<{ exploration_id: string }>(
      "SELECT exploration_id FROM submissions WHERE fork_id = ? AND status = 'queued' AND new_fork = 1",
      forkId,
    );
    if (startsAFork) this.chats.deliverQueued(startsAFork.exploration_id);
  }

  // A runner that slept through its lease keeps it, unless another runner claimed the fork since.
  // The answer says whether the reader asked to stop.
  heartbeat(forkId: string, leaseId: string) {
    const row = this.requireLease(forkId, leaseId);
    this.db.run(
      'UPDATE fork_runs SET lease_expires_at = ? WHERE fork_id = ?',
      this.now() + leaseMs,
      forkId,
    );
    return { stop: row.stop_requested === 1 };
  }

  stopRequested(forkId: string, leaseId: string) {
    return this.requireLease(forkId, leaseId).stop_requested === 1;
  }

  // Only a fork a runner is working on can be stopped; a terminal session never reads the flag.
  requestStop(forkId: string) {
    const row = this.db.get<ForkRunRow>('SELECT * FROM fork_runs WHERE fork_id = ?', forkId);
    if (!row?.lease_id || toForkRun(row).heldByTerminal) return false;
    this.update(forkId, { stop_requested: 1 });
    this.publishRun(forkId);
    return true;
  }

  // The runner stopped the turn: the messages it had count as handled, without an answer, and
  // the fork is free again.
  stopped(forkId: string, leaseId: string, upToMessageId: string | null) {
    const row = this.requireLease(forkId, leaseId);
    // A fork stopped while it waited for memory never handed its messages to an engine. They count
    // as handled all the same, or the fork would be claimed again for them.
    const handled =
      upToMessageId ??
      (row.status === 'waiting_memory'
        ? (this.pendingInput(forkId, leaseId).at(-1)?.id ?? null)
        : null);
    this.update(forkId, {
      ...noLease,
      ...(handled ? { input_cursor: handled } : {}),
      failed_attempts: 0,
      status: 'idle',
      status_detail: null,
    });
    this.publishRun(forkId);
  }

  // Submissions wait in the queue, where the reader can still cancel them, until the runner takes
  // them as the fork's input. `afterMessageId` skips what the runner already handed to its engine
  // during the turn.
  pendingInput(forkId: string, leaseId: string, afterMessageId?: string): PendingMessage[] {
    const row = this.requireLease(forkId, leaseId);
    this.chats.deliverQueued(row.exploration_id);
    return this.db
      .all<MessageRow>(
        `SELECT messages.* FROM messages
         JOIN forks ON forks.id = messages.fork_id
         LEFT JOIN fork_runs ON fork_runs.fork_id = forks.id
         WHERE forks.id = ? AND messages.role = 'user' AND messages.rowid > ${unansweredAfter}
           AND messages.rowid > COALESCE((SELECT rowid FROM messages WHERE id = ?), 0)
         ORDER BY messages.rowid`,
        forkId,
        afterMessageId ?? null,
      )
      .map((row) => ({ id: row.id, text: this.chats.messageText(row) }));
  }

  startTurn(forkId: string, leaseId: string) {
    this.requireLease(forkId, leaseId);
    this.update(forkId, { status: 'answering', status_detail: null });
    this.publishRun(forkId);
  }

  // Every message handed to the engine up to `upToMessageId` is answered once its turn ends.
  finishTurn(forkId: string, leaseId: string, upToMessageId: string) {
    this.requireLease(forkId, leaseId);
    this.update(forkId, {
      input_cursor: upToMessageId,
      failed_attempts: 0,
      status: 'idle',
      status_detail: null,
    });
    this.publishRun(forkId);
  }

  answer(forkId: string, leaseId: string, content: string) {
    this.requireLease(forkId, leaseId);
    return this.chats.addRunnerAnswer(forkId, content);
  }

  addActivity(
    forkId: string,
    leaseId: string,
    input: { afterMessageId: string; kind: ActivityKind; text: string },
  ) {
    const row = this.requireLease(forkId, leaseId);
    const id = newId();
    this.db.run(
      `INSERT INTO activities (id, exploration_id, fork_id, after_message_id, attempt, kind, text,
         created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      row.exploration_id,
      forkId,
      input.afterMessageId,
      row.attempt,
      input.kind,
      input.text,
      this.now(),
    );
    const activity = toActivity(
      this.db.get<ActivityRow>('SELECT * FROM activities WHERE id = ?', id)!,
    );
    this.bus.publish(row.exploration_id, { type: 'activity.added', activity });
    return activity;
  }

  // The chat's messages up to this one count as heard by the fork's engine.
  markOthersSeen(forkId: string, leaseId: string) {
    const row = this.requireLease(forkId, leaseId);
    this.update(forkId, { others_seen_rowid: this.chats.newestMessageRowid(row.exploration_id) });
  }

  // The chat's other forks that changed since the engine last heard, as one block to put before
  // its next message; null for a separate fork or when nothing changed. A fork that never heard
  // starts listening from now.
  othersUpdate(forkId: string, leaseId: string) {
    const row = this.requireLease(forkId, leaseId);
    if (this.chats.fork(forkId).awareness === 'separate') return null;
    this.markOthersSeen(forkId, leaseId);
    if (row.others_seen_rowid === null) return null;
    const changed = this.chats
      .otherForks(forkId, row.others_seen_rowid)
      .filter((fork) => fork.newMessages > 0);
    if (changed.length === 0) return null;
    const shown = changed.slice(0, maxUpdateLines);
    return [
      "Meanwhile in this chat's other forks (read one with read_fork if it matters here):",
      ...shown.map(
        (fork) =>
          `- [${fork.forkId}] ${fork.summary}: ${fork.newMessages} new message${fork.newMessages === 1 ? '' : 's'}`,
      ),
      ...(changed.length > shown.length
        ? [`- and ${changed.length - shown.length} more, see list_forks`]
        : []),
    ].join('\n');
  }

  recordSession(forkId: string, leaseId: string, sessionId: string) {
    this.requireLease(forkId, leaseId);
    this.update(forkId, { session_id: sessionId });
  }

  recordUsage(forkId: string, leaseId: string, usage: RunUsage) {
    this.requireLease(forkId, leaseId);
    this.update(forkId, {
      model: usage.model,
      context_tokens: usage.contextTokens,
      context_window: usage.contextWindow,
    });
    this.publishRun(forkId);
  }

  waitForMemory(forkId: string, leaseId: string, reason: string) {
    this.requireLease(forkId, leaseId);
    this.update(forkId, { status: 'waiting_memory', status_detail: reason });
    this.publishRun(forkId);
  }

  waitForUsageLimit(forkId: string, leaseId: string, until: string) {
    this.requireLease(forkId, leaseId);
    this.update(forkId, { status: 'waiting_limit', status_detail: until });
    this.publishRun(forkId);
  }

  // The runner let the fork go after its turn, for example when its process went idle.
  release(forkId: string, leaseId: string) {
    this.requireLease(forkId, leaseId);
    this.update(forkId, { ...noLease, status: 'idle', status_detail: null });
    this.publishRun(forkId);
  }

  // The run died before answering. The fork is claimable again, until it has failed too often.
  fail(forkId: string, leaseId: string, reason: string) {
    const row = this.requireLease(forkId, leaseId);
    const failedAttempts = row.failed_attempts + 1;
    this.interrupt(row);
    this.update(forkId, {
      ...noLease,
      failed_attempts: failedAttempts,
      status: failedAttempts >= maxFailedAttempts ? 'failed' : 'idle',
      status_detail: failedAttempts >= maxFailedAttempts ? reason : null,
    });
    this.publishRun(forkId);
  }

  retry(forkId: string) {
    const fork = this.chats.requireWritableFork(forkId);
    this.ensureRow(forkId, fork.exploration_id);
    this.update(forkId, { failed_attempts: 0, status: 'idle', status_detail: null });
    this.publishRun(forkId);
  }

  // Notes saved without a topic in chats no terminal session answers, for the runner to name.
  notesNeedingTopic() {
    return this.db
      .all<{ id: string; exploration_id: string; description: string }>(
        `SELECT notes.id, notes.exploration_id, notes.description FROM notes
         JOIN explorations ON explorations.id = notes.exploration_id
         WHERE notes.topic IS NULL
           AND explorations.deleted_at IS NULL
         ORDER BY notes.created_at, notes.rowid`,
      )
      .filter((row) => !this.chats.attachment(row.exploration_id)?.live)
      .map((row) => ({ noteId: row.id, description: row.description }));
  }

  // A topic the runner wrote, kept only if the note still has none.
  setNoteTopic(noteId: string, topic: string) {
    const note = this.chats.note(noteId);
    if (note.topic !== null) return note;
    return this.chats.updateNote(noteId, { topic });
  }

  // The job a tools token belongs to, while its lease lasts.
  jobForToolsToken(token: string): Job | null {
    const row = this.db.get<ForkRunRow>(
      'SELECT * FROM fork_runs WHERE tools_token = ? AND lease_id IS NOT NULL',
      token,
    );
    return row
      ? { forkId: row.fork_id, explorationId: row.exploration_id, leaseId: row.lease_id! }
      : null;
  }

  // An attached terminal session is a runner for its chat's main fork, or for all its forks while
  // no runner is online: it claims them, holds them while it heartbeats, and lets one go once it
  // answered.
  claimForShim(explorationId: string, shimId: string) {
    for (const fork of this.claimable(shimId)) {
      if (fork.explorationId === explorationId)
        this.claim(fork.forkId, shimRunnerId(shimId), shimId);
    }
    return this.db
      .all<ForkRunRow>(
        'SELECT * FROM fork_runs WHERE exploration_id = ? AND runner_id = ? AND lease_id IS NOT NULL',
        explorationId,
        shimRunnerId(shimId),
      )
      .map((row) => {
        // Taking the input delivers the fork's queued submissions as its messages. A new message
        // ends the work after the session's answer: its steps go under that message now.
        if (this.pendingInput(row.fork_id, row.lease_id!).length > 0) {
          this.followUps.delete(row.fork_id);
        }
        return row.fork_id;
      });
  }

  // What an attached session did while answering a fork it holds. After it answered, its steps
  // go under the answer until it waits for feedback again.
  addShimActivity(
    forkId: string,
    shimId: string,
    input: { afterMessageId?: string; kind: ActivityKind; text: string },
  ) {
    const row = this.db.get<ForkRunRow>(
      'SELECT * FROM fork_runs WHERE fork_id = ? AND runner_id = ? AND lease_id IS NOT NULL',
      forkId,
      shimRunnerId(shimId),
    );
    if (!row) return null;
    const followUp = this.followUps.get(forkId);
    const afterMessageId = input.afterMessageId ?? followUp?.answerId;
    if (!afterMessageId) return null;
    if (followUp && input.afterMessageId === undefined) followUp.lastStepAt = this.now();
    return this.addActivity(forkId, row.lease_id!, { ...input, afterMessageId });
  }

  // The forks a session answered and still works on, without new messages from the user.
  shimFollowUps(explorationId: string, shimId: string) {
    return this.db
      .all<ForkRunRow>(
        'SELECT * FROM fork_runs WHERE exploration_id = ? AND runner_id = ? AND lease_id IS NOT NULL',
        explorationId,
        shimRunnerId(shimId),
      )
      .map((row) => row.fork_id)
      .filter((forkId) => this.followUps.has(forkId));
  }

  renewShimLeases(shimId: string) {
    this.db.run(
      'UPDATE fork_runs SET lease_expires_at = ? WHERE runner_id = ? AND lease_id IS NOT NULL',
      this.now() + leaseMs,
      shimRunnerId(shimId),
    );
  }

  // The session answered the fork up to `upToMessageId` with `answerId`. It keeps the fork until
  // it waits for feedback again, as the work it does meanwhile belongs to that answer.
  finishShimTurn(forkId: string, shimId: string, upToMessageId: string, answerId: string) {
    const row = this.db.get<ForkRunRow>('SELECT * FROM fork_runs WHERE fork_id = ?', forkId);
    if (!row?.lease_id || row.runner_id !== shimRunnerId(shimId)) return;
    this.update(forkId, { input_cursor: upToMessageId, failed_attempts: 0, status: 'answering' });
    this.followUps.set(forkId, { answerId, lastStepAt: this.now() });
    this.publishRun(forkId);
  }

  // The session waits for feedback again, or is gone: the forks it answered are free.
  releaseShimFollowUps(shimId: string) {
    for (const row of this.answeredShimRows(shimRunnerId(shimId)))
      this.releaseFollowUp(row.fork_id);
  }

  // Answered forks of sessions that died, whose leases ran out, that made no step for long, or
  // that the daemon lost track of in a restart.
  releaseStaleFollowUps() {
    for (const row of this.answeredShimRows()) {
      const followUp = this.followUps.get(row.fork_id);
      const expired = (row.lease_expires_at ?? 0) <= this.now();
      if (!followUp || expired || this.now() - followUp.lastStepAt >= followUpIdleMs) {
        this.releaseFollowUp(row.fork_id);
      }
    }
  }

  // Forks a terminal session holds with nothing left to answer.
  private answeredShimRows(runnerId?: string) {
    return this.db.all<ForkRunRow>(
      `SELECT fork_runs.* FROM fork_runs
       JOIN forks ON forks.id = fork_runs.fork_id
       WHERE fork_runs.lease_id IS NOT NULL AND fork_runs.runner_id LIKE 'shim:%'
         AND (? IS NULL OR fork_runs.runner_id = ?)
         AND NOT EXISTS (
           SELECT 1 FROM messages
           WHERE messages.fork_id = forks.id AND messages.role = 'user'
             AND messages.rowid > ${unansweredAfter}
         )
         AND NOT EXISTS (SELECT 1 FROM submissions WHERE fork_id = forks.id AND status = 'queued')`,
      runnerId ?? null,
      runnerId ?? null,
    );
  }

  private releaseFollowUp(forkId: string) {
    this.followUps.delete(forkId);
    const row = this.db.get<ForkRunRow>('SELECT * FROM fork_runs WHERE fork_id = ?', forkId);
    if (!row || !isShimRunnerId(row.runner_id)) return;
    this.update(forkId, { ...noLease, status: 'idle', status_detail: null });
    this.publishRun(forkId);
  }

  private answerable(forkId: string, explorationId: string, attachedShimId?: string) {
    const attachment = this.chats.attachment(explorationId);
    try {
      const fork = this.chats.requireWritableFork(forkId);
      if (!attachment?.live) return true;
      const isMain = fork.parent_fork_id === null;
      return attachment.shimId === attachedShimId ? isMain || !this.runnerOnline() : !isMain;
    } catch (error) {
      if (error instanceof StoreError) return false;
      throw error;
    }
  }

  private interrupt(row: ForkRunRow) {
    const marked = this.db.run(
      'UPDATE activities SET interrupted = 1 WHERE fork_id = ? AND attempt = ? AND interrupted = 0',
      row.fork_id,
      row.attempt,
    );
    if (Number(marked.changes) > 0) {
      this.bus.publish(row.exploration_id, {
        type: 'activities.interrupted',
        forkId: row.fork_id,
        attempt: row.attempt,
      });
    }
  }

  private requireLease(forkId: string, leaseId: string) {
    const row = this.db.get<ForkRunRow>('SELECT * FROM fork_runs WHERE fork_id = ?', forkId);
    if (!row || row.lease_id !== leaseId) {
      throw new StoreError('stale_lease', `The lease on fork ${forkId} is no longer yours.`);
    }
    return row;
  }

  private ensureRow(forkId: string, explorationId: string) {
    this.db.run(
      `INSERT INTO fork_runs (fork_id, exploration_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (fork_id) DO NOTHING`,
      forkId,
      explorationId,
      this.now(),
    );
    return this.db.get<ForkRunRow>('SELECT * FROM fork_runs WHERE fork_id = ?', forkId)!;
  }

  private update(forkId: string, changes: Partial<Omit<ForkRunRow, 'fork_id' | 'updated_at'>>) {
    const columns = Object.keys(changes);
    this.db.run(
      `UPDATE fork_runs SET ${columns.map((column) => `${column} = ?`).join(', ')}, updated_at = ?
       WHERE fork_id = ?`,
      ...columns.map((column) => changes[column as keyof typeof changes] ?? null),
      this.now(),
      forkId,
    );
  }

  private publishRun(forkId: string) {
    const row = this.db.get<ForkRunRow>('SELECT * FROM fork_runs WHERE fork_id = ?', forkId);
    if (row)
      this.bus.publish(row.exploration_id, { type: 'fork-run.updated', run: toForkRun(row) });
  }
}
