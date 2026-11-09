import { describe, expect, it } from 'vitest';
import { RunnerClient } from '../src/runner/client.js';
import type { Engine, EngineEvent, EngineRunSpec } from '../src/runner/engine.js';
import { Runner } from '../src/runner/runner.js';
import { createTestApp, seedConversation, testMachineToken } from './helpers.js';

interface FakeRun {
  spec: EngineRunSpec;
  sent: string[];
  emit: (event: EngineEvent) => void;
  exit: (code: number | null, error?: string) => void;
  stopped: boolean;
}

function fakeEngine() {
  const runs: FakeRun[] = [];
  const engine: Engine = {
    start(spec) {
      const listeners: ((event: EngineEvent) => void)[] = [];
      const exitListeners: ((result: { code: number | null; error?: string }) => void)[] = [];
      const run: FakeRun = {
        spec,
        sent: [],
        emit: (event) => listeners.forEach((listener) => listener(event)),
        exit: (code, error) => exitListeners.forEach((listener) => listener({ code, error })),
        stopped: false,
      };
      runs.push(run);
      return {
        send: (text) => run.sent.push(text),
        onEvent: (listener) => listeners.push(listener),
        onExit: (listener) => exitListeners.push(listener),
        stop: () => {
          run.stopped = true;
          setTimeout(() => run.exit(0));
        },
      };
    },
  };
  return { engine, runs };
}

const until = async (condition: () => boolean, timeoutMs = 3_000) => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

function setup(timings = {}) {
  const context = createTestApp();
  const conversation = seedConversation(context.store);
  const client = new RunnerClient('http://127.0.0.1:4999', testMachineToken, async (url, init) =>
    context.app.request(url, {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init.headers)), host: '127.0.0.1:4999' },
    }),
  );
  const { engine, runs: engineRuns } = fakeEngine();
  const errors: unknown[] = [];
  const runner = new Runner({
    client,
    engine,
    runnerId: 'runner-test',
    toolsUrl: 'http://host.docker.internal:4999/api/tools/mcp',
    maxParallel: 2,
    timings: { claimWaitMs: 50, inputWaitMs: 20, heartbeatMs: 1_000, ...timings },
    onError: (error) => errors.push(error),
  });
  const messages = () => context.store.readFork(conversation.mainForkId).messages;
  return { ...context, ...conversation, runner, engineRuns, errors, messages };
}

describe('the runner', () => {
  it('starts an engine with the fork history, posts its answer and its activity', async () => {
    const { runner, engineRuns, store, explorationId, mainForkId, messages, errors } = setup();
    runner.start();
    store.submit(explorationId, mainForkId, 'What about Redis?');
    await until(() => engineRuns[0]?.sent.length === 1);
    const [run] = engineRuns;
    expect(run!.spec).toMatchObject({ forkId: mainForkId, resume: false });
    expect(run!.sent[0]).toContain('<message id=');
    expect(run!.sent[0]).toMatch(/What about Redis\?$/);

    run!.emit({ type: 'session', sessionId: 'session-1', model: 'claude-haiku-5-5' });
    run!.emit({ type: 'text', text: 'Let me check.' });
    run!.emit({ type: 'tool', name: 'WebSearch', summary: 'Searching the web for "redis"' });
    run!.emit({ type: 'usage', model: 'claude-haiku-5-5', contextTokens: 5_000 });
    run!.emit({ type: 'text', text: 'Redis works.' });
    run!.emit({ type: 'turn-finished', answer: 'Redis works.', failed: false, contextWindow: 1e6 });
    await until(() => messages().at(-1)?.text === 'Redis works.');

    const snapshot = store.snapshot(explorationId);
    expect(snapshot.activities.map((activity) => [activity.kind, activity.text])).toEqual([
      ['text', 'Let me check.'],
      ['tool', 'Searching the web for "redis"'],
    ]);
    await until(() => store.snapshot(explorationId).forkRuns[0]?.status === 'idle');
    expect(store.snapshot(explorationId).forkRuns[0]).toMatchObject({
      model: 'claude-haiku-5-5',
      contextTokens: 5_000,
    });
    await runner.stop();
    expect(errors).toEqual([]);
  });

  it('hands a message sent mid-turn to the same engine, without the history', async () => {
    const { runner, engineRuns, store, explorationId, mainForkId, messages } = setup();
    runner.start();
    store.submit(explorationId, mainForkId, 'Long question');
    await until(() => engineRuns[0]?.sent.length === 1);
    store.submit(explorationId, mainForkId, 'Quick one');
    await until(() => engineRuns[0]!.sent.length === 2);
    expect(engineRuns[0]!.sent[1]).toBe('Quick one');
    expect(engineRuns).toHaveLength(1);

    engineRuns[0]!.emit({
      type: 'turn-finished',
      answer: 'Both answered.',
      failed: false,
      contextWindow: null,
    });
    await until(() => messages().at(-1)?.text === 'Both answered.');
    await until(() => store.snapshot(explorationId).forkRuns[0]?.status === 'idle');
    await runner.stop();
  });

  it('lets an idle engine go and resumes its session for the next message', async () => {
    const { runner, engineRuns, store, explorationId, mainForkId, messages } = setup({
      idleCloseMs: 30,
    });
    runner.start();
    store.submit(explorationId, mainForkId, 'First');
    await until(() => engineRuns[0]?.sent.length === 1);
    engineRuns[0]!.emit({ type: 'session', sessionId: 'session-1', model: 'claude-haiku-5-5' });
    engineRuns[0]!.emit({
      type: 'turn-finished',
      answer: 'One.',
      failed: false,
      contextWindow: null,
    });
    await until(() => engineRuns[0]!.stopped);
    await until(() => runner.activeForks.length === 0);

    store.submit(explorationId, mainForkId, 'Second');
    await until(() => engineRuns[1]?.sent.length === 1);
    expect(engineRuns[1]!.spec).toMatchObject({ resume: true, sessionId: 'session-1' });
    expect(engineRuns[1]!.sent[0]).toBe('Second');
    expect(messages().at(-2)?.text).toBe('One.');
    await runner.stop();
  });

  it('fails the attempt when the engine dies mid-turn, and the fork is claimed again', async () => {
    const { runner, engineRuns, store, explorationId, mainForkId } = setup();
    runner.start();
    store.submit(explorationId, mainForkId, 'Crash please');
    await until(() => engineRuns[0]?.sent.length === 1);
    engineRuns[0]!.emit({ type: 'tool', name: 'WebSearch', summary: 'Searching' });
    engineRuns[0]!.exit(1, 'boom');
    await until(() => engineRuns.length === 2);
    await until(() =>
      store.snapshot(explorationId).activities.every((activity) => activity.interrupted),
    );
    expect(engineRuns[1]!.sent[0]).toMatch(/Crash please$/);
    await runner.stop();
  });
});
