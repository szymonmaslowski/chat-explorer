import { randomUUID } from 'node:crypto';
import type { ClaudeModel } from '@chat-explorer/shared/models.js';
import { RunnerClient, StaleLeaseError } from './client.js';
import type { Engine, EngineEvent, EngineRun, EngineRunSpec } from './engine.js';
import {
  noReply,
  type Lease,
  type PendingMessage,
  type RunInput,
} from '@chat-explorer/shared/protocol.js';
import type { DiskGuard } from './disk-guard.js';
import type { MemoryGate } from './memory-gate.js';
import type { RunnerConfig } from './runner-config.js';
import { checkedAccess, checkedRunSpec, RunRefusedError } from './run-spec.js';

export interface RunnerTimings {
  heartbeatMs: number;
  // A fork whose engine has nothing to do for this long lets its process go.
  idleCloseMs: number;
  // A turn that reports nothing for this long is stuck and fails.
  stuckMs: number;
  claimWaitMs: number;
  inputWaitMs: number;
  retryMs: number;
  // How often a coding fork's disk use is measured while it runs.
  diskCheckMs: number;
}

export interface RunnerOptions {
  client: RunnerClient;
  engine: Engine;
  config: RunnerConfig;
  runnerId: string;
  // Where the engine reaches the job tools.
  toolsUrl: string;
  maxParallel: number;
  // Measures coding forks' disk use; none in tests that don't need it.
  diskGuard?: DiskGuard;
  // Keeps coding containers within Docker's memory; none in tests that don't need it.
  memoryGate?: MemoryGate;
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
  diskCheckMs: 60_000,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const maxTopicLength = 60;

export const noteTopicPrompt = (description: string) =>
  `Write a topic for this note: a short title under ${maxTopicLength} characters, in the language of the note. Reply with the title only.\n\n<note>\n${description}\n</note>`;

const shortTopic = (topic: string) => {
  const line = topic
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > maxTopicLength ? `${line.slice(0, maxTopicLength - 1)}…` : line;
};

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
    void this.noteTopicLoop();
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

  // Notes saved without a topic get one from a short completion. One that fails is not retried
  // until the runner restarts, so a broken note cannot loop.
  private async noteTopicLoop() {
    const { client, engine } = this.options;
    const failed = new Set<string>();
    while (!this.stopped) {
      try {
        const notes = await client.noteTopics(this.timings.claimWaitMs, this.abort.signal);
        const todo = notes.filter((note) => !failed.has(note.noteId));
        if (todo.length === 0 && notes.length > 0) await sleep(this.timings.claimWaitMs);
        for (const note of todo) {
          try {
            await engine.ready?.();
            const topic = await engine.complete(noteTopicPrompt(note.description));
            await client.setNoteTopic(note.noteId, shortTopic(topic));
          } catch (error) {
            failed.add(note.noteId);
            this.options.onError?.(error);
          }
        }
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
  private lastUsage: { model: string; contextTokens: number } | null = null;
  private reports: Promise<unknown> = Promise.resolve();
  private finished = false;
  private closing = false;
  private stopping = false;
  private coding = false;
  private model: ClaudeModel | null = null;
  private credentials = '';
  private diskChecks: NodeJS.Timeout | undefined;
  private diskWarned = false;
  private hosts = '';
  private exited: Promise<void> = Promise.resolve();
  private releaseMemory: (() => void) | null = null;
  private restartAfterTurn = false;

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
        client
          .heartbeat(this.lease)
          .then(({ stop }) => stop && this.stopTurn())
          .catch((error: unknown) => this.onReportError(error));
      }, this.timings.heartbeatMs);
      const resume = this.lease.sessionId !== null;
      const context = await client.context(this.lease, resume);
      this.history = context.history;
      this.coding = context.coding;
      this.model = context.model;
      this.credentials = JSON.stringify(context.network.credentials);
      this.hosts = JSON.stringify(context.network);
      const spec = checkedRunSpec({
        lease: this.lease,
        context,
        sessionId: this.lease.sessionId ?? randomUUID(),
        toolsUrl: this.options.toolsUrl,
        config: this.options.config,
      });
      const { diskGuard, memoryGate } = this.options;
      if (spec.coding && memoryGate) {
        this.releaseMemory = await memoryGate.acquire(
          this.lease.forkId,
          this.abort.signal,
          (reason) => this.report(() => client.waitingForMemory(this.lease, reason)),
        );
      }
      if (spec.coding && diskGuard) {
        const refusal = await diskGuard.refusal(spec);
        if (refusal) throw new RunRefusedError(refusal);
        this.diskChecks = setInterval(
          () => void this.checkDisk(diskGuard, spec),
          this.timings.diskCheckMs,
        );
      }
      await engine.ready?.();
      const engineRun = engine.start(spec);
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
      else if (!this.engineRun && (this.stopping || this.closing)) await this.letGoUnstarted();
      else await this.failAndStop(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (this.diskChecks) clearInterval(this.diskChecks);
      await this.exited;
      this.releaseMemory?.();
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
    while (!this.finished && !this.closing && !this.stopping) {
      let input: RunInput;
      try {
        input = await client.input(
          this.lease,
          { waitMs: this.timings.inputWaitMs, after: this.newestSentId },
          this.abort.signal,
        );
      } catch (error) {
        if (this.finished || this.closing) return;
        throw error;
      }
      if (input.stop) {
        this.stopTurn();
        return;
      }
      // A container keeps the coding switch, model and credentials it started with, so a change
      // lets this one go between turns. The fork is claimed again for the message, into a container
      // started with the new settings, and resumes the same session.
      const containerChanged =
        input.coding !== this.coding ||
        input.model !== this.model ||
        (this.coding && JSON.stringify(input.network.credentials) !== this.credentials);
      if (input.messages.length > 0 && !this.turnOpen && containerChanged) {
        await this.close();
        return;
      }
      // Asked for a fresh container: this one goes now, or when the turn ends. Messages that came
      // meanwhile wait for the new one.
      if (input.restart) this.restartAfterTurn = true;
      if (this.restartAfterTurn && !this.turnOpen) {
        await this.close();
        return;
      }
      this.followHosts(input.network);
      if (input.messages.length > 0) {
        await this.send(input.messages, input.others);
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

  private async checkDisk(diskGuard: DiskGuard, spec: EngineRunSpec) {
    if (this.finished) return;
    try {
      const verdict = await diskGuard.check(spec);
      if (verdict.stop) {
        await this.failAndStop(verdict.stop);
        return;
      }
      if (!verdict.warning || this.diskWarned || !this.newestSentId) return;
      this.diskWarned = true;
      const activity = {
        afterMessageId: this.newestSentId,
        kind: 'progress',
        text: verdict.warning,
      } as const;
      this.report(() => this.options.client.activity(this.lease, activity));
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  // A changed host list goes to the proxy at once, without a new container: dev servers and other
  // shell state survive it. A list the runner refuses fails the fork, as at the start.
  private followHosts(network: RunInput['network']) {
    const hosts = JSON.stringify(network);
    if (!this.coding || hosts === this.hosts) return;
    this.hosts = hosts;
    this.engineRun?.allowHosts(checkedAccess(network, this.options.config).network);
  }

  private async send(messages: PendingMessage[], others: string | null) {
    if (!this.turnOpen) {
      this.turnOpen = true;
      this.lastEventAt = Date.now();
      await this.options.client.startTurn(this.lease);
    }
    for (const [index, message] of messages.entries()) {
      const before = index === 0 ? [this.history, others].filter(Boolean) : [];
      this.engineRun!.send([...before, message.text].join('\n\n'));
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
        this.lastUsage = { model: event.model, contextTokens: event.contextTokens };
        await client.usage(this.lease, { ...this.lastUsage, contextWindow: this.contextWindow });
        return;
      case 'heartbeat':
        return;
      case 'rate-limited':
        await client.waiting(
          this.lease,
          event.resetsAt ? new Date(event.resetsAt * 1000).toISOString() : '',
        );
        return;
      case 'turn-finished':
        this.pendingText = [];
        // The window size comes only with the result, after the turn's last usage.
        if (event.contextWindow !== this.contextWindow && this.lastUsage) {
          this.contextWindow = event.contextWindow;
          await client.usage(this.lease, { ...this.lastUsage, contextWindow: this.contextWindow });
        }
        if (event.failed) {
          await this.failAndStop(event.answer || 'Claude Code reported an error.');
          return;
        }
        const answer = event.answer.trim();
        if (answer && answer !== noReply) await client.answer(this.lease, event.answer);
        await client.finishTurn(this.lease, this.newestSentId!);
        this.turnOpen = false;
        this.idleSince = Date.now();
        if (this.restartAfterTurn) void this.close();
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

  // The reader asked to stop: the turn ends at once, without an answer.
  private stopTurn() {
    if (this.finished || this.stopping) return;
    this.stopping = true;
    this.abort.abort();
    this.engineRun?.stop({ immediately: true });
  }

  private async onExit(result: { code: number | null; error?: string }) {
    if (this.finished) return;
    this.finished = true;
    this.abort.abort();
    const { client } = this.options;
    if (this.stopping) {
      if (this.newestSentId) {
        await client.activity(this.lease, {
          afterMessageId: this.newestSentId,
          kind: 'progress',
          text: 'Stopped',
        });
      }
      await client.stopped(this.lease, this.newestSentId);
      return;
    }
    if (this.closing || (!this.turnOpen && result.code === 0)) {
      await client.release(this.lease);
      return;
    }
    await client.fail(
      this.lease,
      result.error ?? `Claude Code stopped with exit code ${result.code ?? 'unknown'}.`,
    );
  }

  // Stopped or closed before its container started, such as while it waited for memory.
  private async letGoUnstarted() {
    this.finished = true;
    const { client } = this.options;
    await this.reports;
    await (this.stopping ? client.stopped(this.lease, null) : client.release(this.lease)).catch(
      (error: unknown) => this.onReportError(error),
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
