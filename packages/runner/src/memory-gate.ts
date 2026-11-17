import { RunRefusedError } from './run-spec.js';

const mebibyte = 1024 ** 2;
const gibibyte = 1024 ** 3;
// Kept free of coding containers for the egress proxy and chat forks, which mostly wait for the
// model and use a few hundred megabytes each.
export const memoryReserveBytes = 1.5 * gibibyte;
// Below this, a coding fork would fail at its first install.
const smallestCodingBytes = gibibyte;

const bytesOf = (memory: string) =>
  Number(memory.slice(0, -1)) * (memory.endsWith('g') ? gibibyte : mebibyte);
const shown = (bytes: number) => `${(bytes / gibibyte).toFixed(1)} GB`;

export interface CodingMemory {
  // As `docker run --memory` takes it.
  memory: string;
  // How many coding containers fit in Docker's memory at once, each at its full cap.
  slots: number;
  // Why no coding container fits at all, or null.
  refusal: string | null;
}

// Each coding container's memory cap, and how many fit side by side: the cap the runner's config
// sets, or else all Docker can spare, which leaves room for one coding fork at a time.
export function codingMemory(configured: string | undefined, dockerBytes: number | null) {
  if (dockerBytes === null) return { memory: configured ?? '4g', slots: 1, refusal: null };
  const spare = dockerBytes - memoryReserveBytes;
  const giveMore = "give Docker more memory in Docker Desktop's settings, then restart the daemon";
  if (spare < smallestCodingBytes) {
    return {
      memory: configured ?? '1g',
      slots: 0,
      refusal: `Docker has ${shown(dockerBytes)} of memory, too little for a coding fork next to the chat forks. To code, ${giveMore}.`,
    };
  }
  const memory = configured ?? `${Math.floor(spare / mebibyte)}m`;
  const slots = Math.floor(spare / bytesOf(memory));
  const refusal =
    slots > 0
      ? null
      : `coding.memory in the runner's config is ${memory}, more than the ${shown(spare)} Docker can spare for coding. Lower it, or ${giveMore}.`;
  return { memory, slots, refusal };
}

export const waitingForMemory = ({ memory, slots }: CodingMemory) =>
  slots === 1
    ? `Another coding fork is using the memory Docker has for coding (${memory}).`
    : `All ${slots} coding forks that fit in Docker's memory are running (${memory} each).`;

// Coding containers together never get more memory than Docker can spare, so one busy fork can't
// take what another was promised. A fork with no room waits until another lets its container go.
export class MemoryGate {
  private readonly holders = new Set<string>();
  private waiters: (() => void)[] = [];

  constructor(
    readonly sizing: CodingMemory,
    private readonly onChange: (forkIds: string[]) => void = () => {},
  ) {}

  get forkIds() {
    return [...this.holders];
  }

  // Resolves with the function that gives the room back. `onWait` runs once if the fork waits.
  async acquire(forkId: string, signal: AbortSignal, onWait: () => void) {
    if (this.sizing.refusal) throw new RunRefusedError(this.sizing.refusal);
    let waiting = false;
    while (this.holders.size >= this.sizing.slots) {
      if (!waiting) onWait();
      waiting = true;
      await this.roomFreed(signal);
    }
    this.holders.add(forkId);
    this.onChange(this.forkIds);
    return () => {
      if (!this.holders.delete(forkId)) return;
      this.onChange(this.forkIds);
      const waiters = this.waiters;
      this.waiters = [];
      for (const wake of waiters) wake();
    };
  }

  private roomFreed(signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        this.waiters = this.waiters.filter((waiter) => waiter !== wake);
        reject(new Error('Stopped while waiting for memory.'));
      };
      if (signal.aborted) return abort();
      this.waiters.push(wake);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
}
