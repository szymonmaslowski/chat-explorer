import { randomUUID } from 'node:crypto';
import type { Lease, PendingMessage } from '../store/runs.js';
import { RunnerClient, StaleLeaseError } from './client.js';
import type { Engine, EngineEvent, EngineRun } from './engine.js';

export interface RunnerTimings {
  heartbeatMs: number;
  // A fork whose engine has nothing to do for this long lets its process go.
  idleCloseMs: number;
  // A turn that reports nothing for this long is stuck and fails.
  stuckMs: number;
  claimWaitMs: number;
  inputWaitMs: number;
  retryMs: number;
}

export interface RunnerOptions {
  client: RunnerClient;
  engine: Engine;
  runnerId: string;
  // Where the engine reaches the job tools.
  toolsUrl: string;
  maxParallel: number;
  timings?: Partial<RunnerTimings>;
  onError?: (error: unknown) => void;
}

const defaultTimings: RunnerTimings = {
  heartbeatMs: 20_000,
  idleCloseMs: 10 * 60_000,
  stuckMs: 10 * 60_000,
  claimWaitMs: 30_000,
  inputWaitMs: 30_000,
  retryMs: 5_000,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The agent loop: claims forks that need an answer, up to a limit, and keeps one live engine per
// fork until it has been idle for a while.
export class Runner {
  private readonly workers = new Map<string, ForkWorker>();
  private readonly abort = new AbortController();
  private readonly timings: RunnerTimings;
  private slotFreed: (() => void) | null = null;
  private stopped = false;

  constructor(private readonly options: RunnerOptions) {
    this.timings = { ...defaultTimings, ...options.timings };
  }

  start() {
    void this.claimLoop();
  }

  async stop() {
    this.stopped = true;
    this.abort.abort();
    this.slotFreed?.();
    await Promise.all([...this.workers.values()].map((worker) => worker.close()));
  }

  get activeForks() {
    return [...this.workers.keys()];
  }

  private async claimLoop() {
    const { client, runnerId, maxParallel } = this.options;
    while (!this.stopped) {
      if (this.workers.size >= maxParallel) {
        await new Promise<void>((resolve) => (this.slotFreed = resolve));
        continue;
      }
      try {
        const lease = await client.claim(runnerId, this.timings.claimWaitMs, this.abort.signal);
        if (lease && !this.stopped) this.startWorker(lease);
      } catch (error) {
        if (this.stopped) return;
        this.options.onError?.(error);
        await sleep(this.timings.retryMs);
      }
    }
  }

  private startWorker(lease: Lease) {
    const worker = new ForkWorker(lease, this.options, this.timings);
    this.workers.set(lease.forkId, worker);
    void worker.run().finally(() => {
      this.workers.delete(lease.forkId);
      this.slotFreed?.();
      this.slotFreed = null;
    });
  }
}

// One fork's live engine: hands it the fork's messages, and reports what it does.
class ForkWorker {
  private engineRun: EngineRun | null = null;
  private readonly abort = new AbortController();
  private heartbeat: NodeJS.Timeout | null = null;
  private history: string | null = null;
  private recordedSessionId: string | null;
  private newestSentId: string | null = null;
  private turnOpen = false;
  private lastEventAt = Date.now();
  private idleSince = Date.now();
  // Text Claude wrote before a tool call is activity; text after the last one is the answer.
  private pendingText: string[] = [];
  private contextWindow: number | null = null;
  private reports: Promise<unknown> = Promise.resolve();
  private finished = false;
  private closing = false;
  private exited: Promise<void> = Promise.resolve();

  constructor(
    private readonly lease: Lease,
    private readonly options: RunnerOptions,
    private readonly timings: RunnerTimings,
  ) {
    this.recordedSessionId = lease.sessionId;
  }

  async run() {
    const { client, engine } = this.options;
    try {
      this.heartbeat = setInterval(() => {
        client.heartbeat(this.lease).catch((error: unknown) => this.onReportError(error));
      }, this.timings.heartbeatMs);
      const resume = this.lease.sessionId !== null;
      const context = await client.context(this.lease, resume);
      this.history = context.history;
      const engineRun = engine.start({
        forkId: this.lease.forkId,
        model: context.model,
        sessionId: this.lease.sessionId ?? randomUUID(),
        resume,
        systemPrompt: context.systemPrompt,
        toolsUrl: this.options.toolsUrl,
        toolsToken: this.lease.toolsToken,
      });
      this.engineRun = engineRun;
      this.exited = new Promise((resolve) =>
        engineRun.onExit((result) => {
          this.report(() => this.onExit(result));
          void this.reports.then(() => resolve());
        }),
      );
      engineRun.onEvent((event) => this.report(() => this.onEvent(event)));
      await this.inputLoop();
    } catch (error) {
      if (error instanceof StaleLeaseError) this.onReportError(error);
      else await this.failAndStop(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.heartbeat) clearInterval(this.heartbeat);
      await this.exited;
      await this.reports;
    }
  }

  async close() {
    if (this.finished) return;
    this.closing = true;
    this.abort.abort();
    this.engineRun?.stop();
    await this.exited;
  }

  private async inputLoop() {
    const { client } = this.options;
    while (!this.finished && !this.closing) {
      let messages: PendingMessage[];
      try {
        messages = await client.input(
          this.lease,
          { waitMs: this.timings.inputWaitMs, after: this.newestSentId },
          this.abort.signal,
        );
      } catch (error) {
        if (this.finished || this.closing) return;
        throw error;
      }
      if (messages.length > 0) {
        await this.send(messages);
        continue;
      }
      const now = Date.now();
      if (this.turnOpen && now - this.lastEventAt > this.timings.stuckMs) {
        await this.failAndStop('The answer stopped making progress.');
        return;
      }
      if (!this.turnOpen && now - this.idleSince > this.timings.idleCloseMs) {
        await this.close();
        return;
      }
    }
  }

  private async send(messages: PendingMessage[]) {
    if (!this.turnOpen) {
      this.turnOpen = true;
      this.lastEventAt = Date.now();
      await this.options.client.startTurn(this.lease);
    }
    for (const [index, message] of messages.entries()) {
      const history = index === 0 ? this.history : null;
      this.engineRun!.send(history ? `${history}\n\n${message.text}` : message.text);
      this.history = null;
      this.newestSentId = message.id;
    }
  }

  private async onEvent(event: EngineEvent) {
    const { client } = this.options;
    this.lastEventAt = Date.now();
    switch (event.type) {
      case 'session':
        if (event.sessionId !== this.recordedSessionId) {
          this.recordedSessionId = event.sessionId;
          await client.session(this.lease, event.sessionId);
        }
        return;
      case 'tool':
        await this.flushText();
        // An answer posted with the tool shows as a message of its own.
        if (event.name.endsWith('__answer')) return;
        await client.activity(this.lease, {
          afterMessageId: this.newestSentId!,
          kind: 'tool',
          text: event.summary,
        });
        return;
      case 'text':
        this.pendingText.push(event.text);
        return;
      case 'usage':
        await client.usage(this.lease, {
          model: event.model,
          contextTokens: event.contextTokens,
          contextWindow: this.contextWindow,
        });
        return;
      case 'rate-limited':
        await client.waiting(
          this.lease,
          event.resetsAt ? new Date(event.resetsAt * 1000).toISOString() : '',
        );
        return;
      case 'turn-finished':
        this.pendingText = [];
        this.contextWindow = event.contextWindow;
        if (event.failed) {
          await this.failAndStop(event.answer || 'Claude Code reported an error.');
          return;
        }
        if (event.answer.trim()) await client.answer(this.lease, event.answer);
        await client.finishTurn(this.lease, this.newestSentId!);
        this.turnOpen = false;
        this.idleSince = Date.now();
    }
  }

  private async flushText() {
    const text = this.pendingText.join('\n\n').trim();
    this.pendingText = [];
    if (!text || !this.newestSentId) return;
    await this.options.client.activity(this.lease, {
      afterMessageId: this.newestSentId,
      kind: 'text',
      text,
    });
  }

  private async onExit(result: { code: number | null; error?: string }) {
    if (this.finished) return;
    this.finished = true;
    this.abort.abort();
    const { client } = this.options;
    if (this.closing || (!this.turnOpen && result.code === 0)) {
      await client.release(this.lease);
      return;
    }
    await client.fail(
      this.lease,
      result.error ?? `Claude Code stopped with exit code ${result.code ?? 'unknown'}.`,
    );
  }

  private async failAndStop(reason: string) {
    if (this.finished) return;
    this.finished = true;
    this.abort.abort();
    this.engineRun?.stop({ immediately: true });
    await this.options.client
      .fail(this.lease, reason)
      .catch((error: unknown) => this.onReportError(error));
  }

  // Reports go out one at a time, in the order the engine produced them.
  private report(work: () => Promise<unknown>) {
    this.reports = this.reports.then(work).catch((error: unknown) => this.onReportError(error));
  }

  // Another runner holds the fork now: stop at once and report nothing more.
  private onReportError(error: unknown) {
    if (error instanceof StaleLeaseError) {
      this.finished = true;
      this.abort.abort();
      this.engineRun?.stop({ immediately: true });
      return;
    }
    this.options.onError?.(error);
  }
}
