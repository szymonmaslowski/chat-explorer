import { describe, expect, it } from 'vitest';
import {
  codingMemory,
  codingNeedsBytes,
  codingStartBytes,
  MemoryGate,
  memoryReserveBytes,
  memoryShortage,
} from '../src/memory-gate.js';
import { RunRefusedError } from '../src/run-spec.js';

const gigabytes = (count: number) => count * 1024 ** 3;
const until = async (check: () => boolean) => {
  for (let tries = 0; !check(); tries++) {
    if (tries > 200) throw new Error('Timed out.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("coding containers' memory cap", () => {
  it('gives each coding container all Docker can spare when the config sets no cap', () => {
    expect(codingMemory(undefined, gigabytes(8))).toEqual({ memory: '6656m', refusal: null });
    expect(gigabytes(8) - memoryReserveBytes).toBe(6656 * 1024 ** 2);
  });

  it('keeps the cap the config sets', () => {
    expect(codingMemory('3g', gigabytes(8))).toEqual({ memory: '3g', refusal: null });
  });

  it('refuses coding when a cap or Docker itself leaves no room for one fork', () => {
    expect(codingMemory('8g', gigabytes(8)).refusal).toContain('coding.memory in the runner');
    expect(codingMemory(undefined, gigabytes(2)).refusal).toContain('too little for a coding fork');
  });
});

describe('room for a new coding container', () => {
  it('needs the reserve for the proxy and chat forks, and room for the container to start', () => {
    expect(codingNeedsBytes).toBe(memoryReserveBytes + codingStartBytes);
    expect(memoryShortage(codingNeedsBytes, 3)).toBeNull();
    expect(memoryShortage(gigabytes(2), 1)).toBe(
      'Docker has 2.0 GB of memory free, and a coding fork needs 2.5 GB free to start.',
    );
  });

  it('runs coding forks one at a time when free memory cannot be measured', () => {
    expect(memoryShortage(null, 0)).toBeNull();
    expect(memoryShortage(null, 1)).toContain("couldn't be measured");
  });
});

describe('the memory gate', () => {
  const sizing = { memory: '6656m', refusal: null };
  const timings = { recheckMs: 20, startingMs: 60_000 };
  const signal = new AbortController().signal;

  it('lets forks in on measured free memory, not their caps', async () => {
    const changes: string[][] = [];
    const gate = new MemoryGate(
      sizing,
      async () => gigabytes(6),
      (forkIds) => changes.push(forkIds),
      timings,
    );
    for (const forkId of ['fork_a', 'fork_b', 'fork_c']) {
      await gate.acquire(forkId, signal, () => {
        throw new Error(`${forkId} waited`);
      });
    }
    expect(gate.forkIds).toEqual(['fork_a', 'fork_b', 'fork_c']);
    expect(changes).toHaveLength(3);
  });

  it('counts containers that just started as using room the measure does not show yet', async () => {
    const gate = new MemoryGate(sizing, async () => gigabytes(4), undefined, timings);
    await gate.acquire('fork_a', signal, () => {});
    expect(await gate.availableBytes()).toBe(gigabytes(3));
    await gate.acquire('fork_b', signal, () => {});
    const reasons: string[] = [];
    const stop = new AbortController();
    const third = gate.acquire('fork_c', stop.signal, (reason) => reasons.push(reason));
    await until(() => reasons.length === 1);
    expect(reasons[0]).toContain('2.0 GB of memory free');
    expect(gate.forkIds).toEqual(['fork_a', 'fork_b']);
    stop.abort();
    await expect(third).rejects.toThrow();
  });

  it('never lets two forks count the same free memory', async () => {
    let measures = 0;
    const gate = new MemoryGate(
      sizing,
      async () => {
        measures++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return gigabytes(3);
      },
      undefined,
      timings,
    );
    let waited = 0;
    const stop = new AbortController();
    const first = gate.acquire('fork_a', stop.signal, () => waited++);
    const second = gate.acquire('fork_b', stop.signal, () => waited++);
    await first;
    await until(() => waited === 1);
    expect(gate.forkIds).toEqual(['fork_a']);
    stop.abort();
    await expect(second).rejects.toThrow('Stopped while waiting for memory.');
    expect(measures).toBeGreaterThanOrEqual(2);
  });

  it('starts a waiting fork once memory frees, measuring again on its own', async () => {
    let free = gigabytes(2);
    const gate = new MemoryGate(sizing, async () => free, undefined, timings);
    let waited = 0;
    const waiting = gate.acquire('fork_a', signal, () => waited++);
    await until(() => waited === 1);
    free = gigabytes(5);
    await waiting;
    expect(waited).toBe(1);
    expect(gate.forkIds).toEqual(['fork_a']);
  });

  it('measures again at once when a coding fork lets go, which it does only once', async () => {
    let free = gigabytes(3);
    const gate = new MemoryGate(sizing, async () => free, undefined, {
      recheckMs: 60_000,
      startingMs: 0,
    });
    const release = await gate.acquire('fork_a', signal, () => {});
    free = gigabytes(1);
    let waited = false;
    const waiting = gate.acquire('fork_b', signal, () => (waited = true));
    await until(() => waited);
    free = gigabytes(3);
    release();
    release();
    await waiting;
    expect(gate.forkIds).toEqual(['fork_b']);
  });

  it('stops waiting when the fork is stopped', async () => {
    const gate = new MemoryGate(sizing, async () => gigabytes(1), undefined, timings);
    const stop = new AbortController();
    let waited = false;
    const waiting = gate.acquire('fork_b', stop.signal, () => (waited = true));
    await until(() => waited);
    stop.abort();
    await expect(waiting).rejects.toThrow('Stopped while waiting for memory.');
    expect(gate.forkIds).toEqual([]);
  });

  it('refuses at once when no coding fork fits', async () => {
    const gate = new MemoryGate({ memory: '8g', refusal: 'Too big.' }, async () => gigabytes(8));
    await expect(gate.acquire('fork_a', signal, () => {})).rejects.toThrow(RunRefusedError);
  });
});
