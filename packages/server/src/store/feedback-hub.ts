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

// Where answers come from when no terminal session is attached: a runner, when one is in use.
export interface RunnerStatus {
  status(explorationId: string): 'answering' | 'listening' | 'detached';
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
  private readonly statusTimer: NodeJS.Timeout;

  constructor(
    private readonly store: ChatStore,
    private readonly bus: EventBus,
    private readonly now: () => number = Date.now,
    private readonly startingSessions: StartingSessions = { isStarting: () => false },
    private readonly runner: RunnerStatus | null = null,
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
      if (event.type === 'exploration.updated' && event.exploration.archivedAt !== null) {
        this.settleAll(explorationId, { status: 'detached' });
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
      if (this.runner) return this.runner.status(explorationId);
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
    this.store.deliverQueued(explorationId);
    const forks = this.store.pendingForks(explorationId);
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
    return {
      status: 'feedback',
      forks,
      notesNeedingTopic,
      notes: this.store.notesIndex(explorationId),
    };
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
