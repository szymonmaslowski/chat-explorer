import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Settings } from '../settings.js';
import { StoreError } from '../store/errors.js';
import type { EventBus } from '../store/event-bus.js';
import type { StartingSessions } from '../store/feedback-hub.js';
import type { ChatStore } from '../store/store.js';
import type { Launcher, SessionProcess } from './launch-claude.js';

interface RunningSession {
  process: SessionProcess;
  sessionId: string;
  attached: boolean;
  stopping: boolean;
  restartAfterExit: boolean;
  lastActiveAt: number;
}

export interface BackgroundSessionsOptions {
  store: ChatStore;
  bus: EventBus;
  settings: Pick<Settings, 'idleMinutes' | 'maxSessions'>;
  sessionsPath: string;
  launch: Launcher;
  canResume: (sessionId: string) => boolean;
  onStatusChange: (explorationId: string) => void;
  now?: () => number;
}

const checkIntervalMs = 15_000;
const logTailLines = 8;

export class BackgroundSessions implements StartingSessions {
  private readonly running = new Map<string, RunningSession>();
  private readonly errors = new Map<string, string>();
  private readonly checkTimer: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private readonly options: BackgroundSessionsOptions) {
    this.now = options.now ?? Date.now;
    options.store.releaseBackgroundAttachments();
    options.bus.subscribe((explorationId, event) => {
      const session = this.running.get(explorationId);
      if (event.type === 'exploration.deleted') {
        this.stop(explorationId);
        this.errors.delete(explorationId);
        return;
      }
      if (event.type === 'exploration.updated' && event.exploration.archivedAt !== null) {
        this.stop(explorationId);
      }
      if (event.type === 'session.attached' && session) session.attached = true;
      if (event.type === 'message.added' || event.type === 'session.attached') {
        if (session) session.lastActiveAt = this.now();
      }
      if (event.type === 'submission.queued') {
        if (session) session.lastActiveAt = this.now();
        else this.startIfUnattended(explorationId);
      }
    });
    this.checkTimer = setInterval(() => {
      this.stopIdle();
      this.startForUnansweredQueues();
    }, checkIntervalMs);
    this.checkTimer.unref();
  }

  isStarting(explorationId: string) {
    const session = this.running.get(explorationId);
    return session !== undefined && !session.stopping;
  }

  error(explorationId: string) {
    return this.errors.get(explorationId) ?? null;
  }

  start(explorationId: string) {
    const { store } = this.options;
    if (this.running.has(explorationId)) return;
    if (store.isArchived(explorationId)) {
      throw new StoreError('archived', 'This exploration is archived. Restore it to continue.');
    }
    if (store.attachment(explorationId)?.live) {
      throw new StoreError(
        'attached_elsewhere',
        'A Claude session is already attached to this exploration.',
      );
    }
    if (this.running.size >= this.options.settings.maxSessions && !this.stopLongestIdle()) {
      throw new StoreError(
        'too_many_sessions',
        `${this.options.settings.maxSessions} Claude sessions are busy. Submit again when one has finished.`,
      );
    }
    const { model, sessionId: storedSessionId } = store.backgroundSession(explorationId);
    const resume = storedSessionId !== null && this.options.canResume(storedSessionId);
    const sessionId = resume ? storedSessionId : randomUUID();
    if (!resume) store.setBackgroundSessionId(explorationId, sessionId);
    const logPath = this.logPath(explorationId);
    const session: RunningSession = {
      process: this.options.launch({ explorationId, model, sessionId, resume, logPath }),
      sessionId,
      attached: false,
      stopping: false,
      restartAfterExit: false,
      lastActiveAt: this.now(),
    };
    this.running.set(explorationId, session);
    session.process.onExit((result) => this.onExit(explorationId, session, result));
    this.setError(explorationId, null);
    this.options.onStatusChange(explorationId);
  }

  restart(explorationId: string) {
    const session = this.running.get(explorationId);
    if (!session) return;
    session.restartAfterExit = true;
    this.stop(explorationId);
  }

  stopAll() {
    clearInterval(this.checkTimer);
    for (const session of this.running.values()) session.process.stop({ immediately: true });
  }

  stopIdle() {
    const idleMs = this.options.settings.idleMinutes * 60_000;
    for (const [explorationId, session] of this.running) {
      if (this.isIdle(explorationId, session) && this.now() - session.lastActiveAt >= idleMs) {
        this.stop(explorationId);
      }
    }
  }

  // Covers queued feedback that no event will pick up: left from before a daemon restart, or queued
  // while a session from elsewhere was attached and then went away. A failed start is not retried.
  startForUnansweredQueues() {
    for (const explorationId of this.options.store.explorationsWithQueuedSubmissions()) {
      if (!this.running.has(explorationId) && !this.errors.has(explorationId)) {
        this.startIfUnattended(explorationId);
      }
    }
  }

  private startIfUnattended(explorationId: string) {
    const { store } = this.options;
    if (store.isArchived(explorationId) || store.attachment(explorationId)?.live) return;
    this.tryStart(explorationId);
  }

  private tryStart(explorationId: string) {
    try {
      this.start(explorationId);
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      this.setError(explorationId, error.message);
    }
  }

  private stop(explorationId: string) {
    const session = this.running.get(explorationId);
    if (!session || session.stopping) return;
    session.stopping = true;
    session.process.stop();
  }

  private stopLongestIdle() {
    const idle = [...this.running]
      .filter(([explorationId, session]) => this.isIdle(explorationId, session))
      .sort(([, left], [, right]) => left.lastActiveAt - right.lastActiveAt);
    const [longestIdle] = idle[0] ?? [];
    if (longestIdle === undefined) return false;
    this.stop(longestIdle);
    this.running.delete(longestIdle);
    return true;
  }

  private isIdle(explorationId: string, session: RunningSession) {
    const { store } = this.options;
    return (
      session.attached &&
      !session.stopping &&
      store.pendingForks(explorationId).length === 0 &&
      store.queuedSubmissions(explorationId).length === 0
    );
  }

  private onExit(
    explorationId: string,
    session: RunningSession,
    result: { code: number | null; error?: string },
  ) {
    const { store } = this.options;
    if (this.running.get(explorationId) === session) this.running.delete(explorationId);
    if (!store.hasExploration(explorationId)) return;
    // Claude Code may exit before its MCP server has detached, and the new session could not attach.
    const attachment = store.attachment(explorationId);
    if (attachment?.sessionId === session.sessionId) store.detach(attachment.shimId);
    const hasQueued = store.queuedSubmissions(explorationId).length > 0;
    if (session.restartAfterExit || (session.stopping && hasQueued)) {
      this.startIfUnattended(explorationId);
      this.options.onStatusChange(explorationId);
      return;
    }
    const failed = !session.stopping && (!session.attached || result.code !== 0);
    if (failed) {
      const reason = result.error
        ? `Claude could not be started: ${result.error}`
        : `Claude exited with code ${result.code} before it could answer.`;
      this.setError(
        explorationId,
        [reason, this.logTail(explorationId)].filter(Boolean).join('\n\n'),
      );
    }
    this.options.onStatusChange(explorationId);
  }

  private setError(explorationId: string, message: string | null) {
    if (message === this.error(explorationId)) return;
    if (message === null) this.errors.delete(explorationId);
    else this.errors.set(explorationId, message);
    this.options.bus.publish(explorationId, { type: 'session.error', message });
  }

  private logPath(explorationId: string) {
    return join(this.options.sessionsPath, `${explorationId}.log`);
  }

  private logTail(explorationId: string) {
    const logPath = this.logPath(explorationId);
    if (!existsSync(logPath)) return '';
    const lines = readFileSync(logPath, 'utf8').trimEnd().split('\n');
    const lastRun = lines.findLastIndex((line) => line.startsWith('--- '));
    return lines
      .slice(lastRun + 1)
      .slice(-logTailLines)
      .join('\n');
  }
}
