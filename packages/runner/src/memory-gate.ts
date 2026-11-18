import { RunRefusedError } from './run-spec.js';

const mebibyte = 1024 ** 2;
const gibibyte = 1024 ** 3;
// Kept free of coding containers for the egress proxy and chat forks, which mostly wait for the
// model and use a few hundred megabytes each.
export const memoryReserveBytes = 1.5 * gibibyte;
// What a new coding container needs free to start. A smaller cap would fail at its first install.
export const codingStartBytes = gibibyte;
export const codingNeedsBytes = memoryReserveBytes + codingStartBytes;

const bytesOf = (memory: string) =>
  Number(memory.slice(0, -1)) * (memory.endsWith('g') ? gibibyte : mebibyte);
const shown = (bytes: number) => `${(Math.max(bytes, 0) / gibibyte).toFixed(1)} GB`;

export interface CodingMemory {
  // Each coding container's cap, as `docker run --memory` takes it.
  memory: string;
  // Why no coding container fits at all, or null.
  refusal: string | null;
}

// Each coding container's memory cap: the one the runner's config sets, or else all Docker can
// spare, so a single fork can still run a big build.
export function codingMemory(configured: string | undefined, dockerBytes: number | null) {
  if (dockerBytes === null) return { memory: configured ?? '4g', refusal: null };
  const spare = dockerBytes - memoryReserveBytes;
  const giveMore = "give Docker more memory in Docker Desktop's settings, then restart the daemon";
  if (spare < codingStartBytes) {
    return {
      memory: configured ?? '1g',
      refusal: `Docker has ${shown(dockerBytes)} of memory, too little for a coding fork next to the chat forks. To code, ${giveMore}.`,
    };
  }
  if (configured && bytesOf(configured) > spare) {
    return {
      memory: configured,
      refusal: `coding.memory in the runner's config is ${configured}, more than the ${shown(spare)} Docker can spare for coding. Lower it, or ${giveMore}.`,
    };
  }
  return { memory: configured ?? `${Math.floor(spare / mebibyte)}m`, refusal: null };
}

// Why a new coding container can't start now, or null when it can.
export function memoryShortage(availableBytes: number | null, running: number) {
  if (availableBytes === null) {
    return running === 0
      ? null
      : "Docker's free memory couldn't be measured, so coding forks run one at a time.";
  }
  return availableBytes >= codingNeedsBytes
    ? null
    : `Docker has ${shown(availableBytes)} of memory free, and a coding fork needs ${shown(codingNeedsBytes)} free to start.`;
}

export interface MemoryGateTimings {
  // How often a waiting fork measures again, besides whenever a coding fork lets go.
  recheckMs: number;
  // How long a new container counts as using `codingStartBytes` the measure may not show yet.
  startingMs: number;
}

// Coding containers start while Docker has memory free for them, measured, not added up from their
// caps: a fork writing code uses a few hundred megabytes of its cap. If several grow at once and
// Docker runs out, its kernel ends a coding process, never the proxy or a chat fork.
export class MemoryGate {
  private readonly holders = new Set<string>();
  private readonly startedAt = new Map<string, number>();
  private waiters: (() => void)[] = [];
  // One admission at a time, so two forks never both count the same free memory.
  private admitting = Promise.resolve();

  constructor(
    readonly sizing: CodingMemory,
    private readonly measure: () => Promise<number | null>,
    private readonly onChange: (forkIds: string[]) => void = () => {},
    private readonly timings: MemoryGateTimings = { recheckMs: 10_000, startingMs: 60_000 },
  ) {}

  get forkIds() {
    return [...this.holders];
  }

  // Docker's free memory, less what containers that just started are about to take.
  async availableBytes() {
    const measured = await this.measure();
    if (measured === null) return null;
    const now = Date.now();
    const starting = [...this.startedAt.values()].filter(
      (startedAt) => now - startedAt < this.timings.startingMs,
    ).length;
    return measured - starting * codingStartBytes;
  }

  // Resolves with the function that gives the room back. `onWait` runs once if the fork waits.
  async acquire(forkId: string, signal: AbortSignal, onWait: (reason: string) => void) {
    if (this.sizing.refusal) throw new RunRefusedError(this.sizing.refusal);
    let waiting = false;
    for (;;) {
      const shortage = await this.admit(forkId);
      if (shortage === null) break;
      if (!waiting) onWait(shortage);
      waiting = true;
      await this.roomMayHaveFreed(signal);
    }
    return () => {
      if (!this.holders.delete(forkId)) return;
      this.startedAt.delete(forkId);
      this.onChange(this.forkIds);
      const waiters = this.waiters;
      this.waiters = [];
      for (const wake of waiters) wake();
    };
  }

  private admit(forkId: string) {
    const attempt = this.admitting.then(async () => {
      const shortage = memoryShortage(await this.availableBytes(), this.holders.size);
      if (shortage !== null) return shortage;
      this.holders.add(forkId);
      this.startedAt.set(forkId, Date.now());
      this.onChange(this.forkIds);
      return null;
    });
    this.admitting = attempt.then(
      () => {},
      () => {},
    );
    return attempt;
  }

  private roomMayHaveFreed(signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const wake = () => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((waiter) => waiter !== wake);
        signal.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((waiter) => waiter !== wake);
        reject(new Error('Stopped while waiting for memory.'));
      };
      const timer = setTimeout(wake, this.timings.recheckMs);
      if (signal.aborted) return abort();
      this.waiters.push(wake);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
}
