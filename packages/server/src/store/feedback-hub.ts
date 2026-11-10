import type { SessionStatus } from '../shared/types.js';
import type { EventBus } from './event-bus.js';
import {
  attachmentLivenessMs,
  type ChatStore,
  type NoteNeedingTopic,
  type NotesIndex,
  type PendingFork,
} from './store.js';

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

interface Waiter {
  explorationId: string;
  shimId: string;
  settle: (result: FeedbackResult) => void;
}

export interface StartingSessions {
  isStarting(explorationId: string): boolean;
}

// With a runner in use, the attached session is a runner for its chat: it claims forks with
// leases, and the chat's status without a session follows the runner.
export interface SessionLeases {
  status(explorationId: string): 'answering' | 'listening' | 'detached';
  claimForShim(explorationId: string, shimId: string): string[];
}

// A shim long-polls in rounds, so after a round times out there is a short gap before the next one.
const listeningGraceMs = 5_000;

export class FeedbackHub {
  private readonly waiters = new Set<Waiter>();
  private readonly lastPollEndedAt = new Map<string, number>();
  private readonly lastStatus = new Map<string, SessionStatus>();
  // Notes already handed to the attached session for a topic. Without this a session that never
  // writes one would get the same note back at once on every call, in a loop.
  private readonly handedNotes = new Map<string, { shimId: string; noteIds: Set<string> }>();
  // The newest message of each fork handed to the attached session, so a message that arrives
  // while it works reaches it once, at its next tool call.
  private readonly handedTips = new Map<string, string>();
  private readonly statusTimer: NodeJS.Timeout;

  constructor(
    private readonly store: ChatStore,
    private readonly bus: EventBus,
    private readonly now: () => number = Date.now,
    private readonly startingSessions: StartingSessions = { isStarting: () => false },
    private readonly leases: SessionLeases | null = null,
  ) {
    bus.subscribe((explorationId, event) => {
      if (event.type === 'session.status') return;
      // Deferred so every subscriber sees `submission.queued` before the delivery events it triggers.
      const needsTopic =
        (event.type === 'note.created' || event.type === 'note.updated') &&
        event.note.topic === null;
      if (event.type === 'submission.queued' || needsTopic) {
        queueMicrotask(() => this.wakeWithFeedback(explorationId));
      }
      if (event.type === 'session.attached') this.settleOthers(explorationId, event.shimId);
      if (event.type === 'exploration.deleted') {
        this.settleAll(explorationId, { status: 'deleted' });
        this.lastStatus.delete(explorationId);
        this.handedNotes.delete(explorationId);
        return;
      }
      this.refreshStatus(explorationId);
    });
    this.statusTimer = setInterval(() => {
      for (const explorationId of this.lastStatus.keys()) this.refreshStatus(explorationId);
    }, attachmentLivenessMs / 3);
    this.statusTimer.unref();
  }

  waitForFeedback(input: {
    explorationId: string;
    shimId: string;
    waitMs: number;
    signal?: AbortSignal;
  }): Promise<FeedbackResult> {
    const immediate = this.check(input.explorationId, input.shimId);
    if (immediate) return Promise.resolve(immediate);

    return new Promise((resolve) => {
      const waiter: Waiter = {
        explorationId: input.explorationId,
        shimId: input.shimId,
        settle: (result) => {
          clearTimeout(timer);
          input.signal?.removeEventListener('abort', onAbort);
          this.waiters.delete(waiter);
          if (result.status === 'timeout')
            this.lastPollEndedAt.set(input.explorationId, this.now());
          else this.lastPollEndedAt.delete(input.explorationId);
          resolve(result);
          this.refreshStatus(input.explorationId);
        },
      };
      const timer = setTimeout(() => waiter.settle({ status: 'timeout' }), input.waitMs);
      const onAbort = () => waiter.settle({ status: 'timeout' });
      input.signal?.addEventListener('abort', onAbort);
      this.waiters.add(waiter);
      this.refreshStatus(input.explorationId);
    });
  }

  status(explorationId: string): SessionStatus {
    const attachment = this.store.attachment(explorationId);
    if (!attachment?.live) {
      if (this.leases) return this.leases.status(explorationId);
      return this.startingSessions.isStarting(explorationId) ? 'starting' : 'detached';
    }
    if (this.isListening(explorationId)) return 'listening';
    if (this.store.pendingForks(explorationId).length > 0) return 'answering';
    return 'attached';
  }

  refreshStatus(explorationId: string) {
    if (!this.store.hasExploration(explorationId)) return;
    const status = this.status(explorationId);
    if (this.lastStatus.get(explorationId) === status) return;
    this.lastStatus.set(explorationId, status);
    this.bus.publish(explorationId, { type: 'session.status', status });
  }

  stop() {
    clearInterval(this.statusTimer);
    for (const waiter of this.waiters) waiter.settle({ status: 'timeout' });
  }

  private check(explorationId: string, shimId: string): FeedbackResult | null {
    if (!this.store.hasExploration(explorationId)) return { status: 'deleted' };
    if (this.store.attachment(explorationId)?.shimId !== shimId) return { status: 'detached' };
    this.store.requireAttachedShim(explorationId, shimId);
    // Forks the session holds include ones handed out before and not answered yet, so a session
    // that lost track gets them again.
    const forks = this.heldPendingForks(explorationId, shimId);
    let handed = this.handedNotes.get(explorationId);
    if (handed?.shimId !== shimId) {
      handed = { shimId, noteIds: new Set() };
      this.handedNotes.set(explorationId, handed);
    }
    const notesNeedingTopic = this.store
      .notesNeedingTopic(explorationId)
      .filter((note) => !handed.noteIds.has(note.noteId));
    if (forks.length === 0 && notesNeedingTopic.length === 0) return null;
    for (const note of notesNeedingTopic) handed.noteIds.add(note.noteId);
    for (const fork of forks) this.handedTips.set(fork.forkId, fork.inReplyTo);
    return {
      status: 'feedback',
      forks,
      notesNeedingTopic,
      notes: this.store.notesIndex(explorationId),
    };
  }

  // While the attached session works: the forks it answers, and those of them with messages it
  // has not been handed yet.
  duringWork(explorationId: string, shimId: string) {
    const working = this.heldPendingForks(explorationId, shimId);
    const arrived = working.filter((fork) => this.handedTips.get(fork.forkId) !== fork.inReplyTo);
    for (const fork of arrived) this.handedTips.set(fork.forkId, fork.inReplyTo);
    return { working, arrived };
  }

  private heldPendingForks(explorationId: string, shimId: string) {
    const held = this.leases ? new Set(this.leases.claimForShim(explorationId, shimId)) : null;
    if (!held) this.store.deliverQueued(explorationId);
    return this.store.pendingForks(explorationId).filter((fork) => !held || held.has(fork.forkId));
  }

  private isListening(explorationId: string) {
    const hasWaiter = [...this.waiters].some((waiter) => waiter.explorationId === explorationId);
    const lastEnded = this.lastPollEndedAt.get(explorationId);
    return hasWaiter || (lastEnded !== undefined && this.now() - lastEnded < listeningGraceMs);
  }

  private wakeWithFeedback(explorationId: string) {
    for (const waiter of [...this.waiters]) {
      if (waiter.explorationId !== explorationId) continue;
      const result = this.check(explorationId, waiter.shimId);
      if (result) waiter.settle(result);
    }
  }

  private settleOthers(explorationId: string, attachedShimId: string) {
    for (const waiter of [...this.waiters]) {
      if (waiter.explorationId === explorationId && waiter.shimId !== attachedShimId) {
        waiter.settle({ status: 'detached' });
      }
    }
  }

  private settleAll(explorationId: string, result: FeedbackResult) {
    for (const waiter of [...this.waiters]) {
      if (waiter.explorationId === explorationId) waiter.settle(result);
    }
  }
}
