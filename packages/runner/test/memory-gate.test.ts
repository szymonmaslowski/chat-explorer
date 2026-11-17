import { describe, expect, it } from 'vitest';
import { codingMemory, MemoryGate, memoryReserveBytes } from '../src/memory-gate.js';
import { RunRefusedError } from '../src/run-spec.js';

const gigabytes = (count: number) => count * 1024 ** 3;

describe("coding containers' memory", () => {
  it('gives one coding fork all Docker can spare when the config sets no cap', () => {
    expect(codingMemory(undefined, gigabytes(8))).toEqual({
      memory: '6656m',
      slots: 1,
      refusal: null,
    });
    expect(gigabytes(8) - memoryReserveBytes).toBe(6656 * 1024 ** 2);
  });

  it('fits as many capped containers as Docker can spare memory for', () => {
    expect(codingMemory('3g', gigabytes(8))).toMatchObject({ memory: '3g', slots: 2 });
    expect(codingMemory('4g', gigabytes(16))).toMatchObject({ slots: 3 });
    expect(codingMemory('512m', gigabytes(8))).toMatchObject({ slots: 13 });
  });

  it('refuses coding when a cap or Docker itself leaves no room for one fork', () => {
    expect(codingMemory('8g', gigabytes(8))).toMatchObject({
      slots: 0,
      refusal: expect.stringContaining('coding.memory in the runner'),
    });
    expect(codingMemory(undefined, gigabytes(2))).toMatchObject({
      slots: 0,
      refusal: expect.stringContaining('too little for a coding fork'),
    });
  });
});

describe('the memory gate', () => {
  const sizing = { memory: '3g', slots: 2, refusal: null };

  it('lets forks in while there is room, and the next one once a fork lets go', async () => {
    const changes: string[][] = [];
    const gate = new MemoryGate(sizing, (forkIds) => changes.push(forkIds));
    const signal = new AbortController().signal;
    let waited = 0;
    const releaseA = await gate.acquire('fork_a', signal, () => waited++);
    await gate.acquire('fork_b', signal, () => waited++);
    let cIn = false;
    const third = gate.acquire('fork_c', signal, () => waited++).then(() => (cIn = true));
    await Promise.resolve();
    expect(cIn).toBe(false);
    expect(waited).toBe(1);
    releaseA();
    await third;
    expect(gate.forkIds).toEqual(['fork_b', 'fork_c']);
    expect(changes).toEqual([['fork_a'], ['fork_a', 'fork_b'], ['fork_b'], ['fork_b', 'fork_c']]);
  });

  it('stops waiting when the fork is stopped, and gives back room only once', async () => {
    const gate = new MemoryGate({ ...sizing, slots: 1 });
    const release = await gate.acquire('fork_a', new AbortController().signal, () => {});
    const stop = new AbortController();
    const waiting = gate.acquire('fork_b', stop.signal, () => {});
    stop.abort();
    await expect(waiting).rejects.toThrow('Stopped while waiting for memory.');
    release();
    release();
    expect(gate.forkIds).toEqual([]);
  });

  it('refuses at once when no coding fork fits', async () => {
    const gate = new MemoryGate({ memory: '8g', slots: 0, refusal: 'Too big.' });
    await expect(gate.acquire('fork_a', new AbortController().signal, () => {})).rejects.toThrow(
      RunRefusedError,
    );
  });
});
