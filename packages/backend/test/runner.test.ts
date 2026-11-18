import { describe, expect, it } from 'vitest';
import { RunnerClient } from '@chat-explorer/runner/client.js';
import type {
  Engine,
  EngineEvent,
  EngineRunSpec,
  HostPolicy,
} from '@chat-explorer/runner/engine.js';
import type { DiskGuard } from '@chat-explorer/runner/disk-guard.js';
import { Runner } from '@chat-explorer/runner/runner.js';
import type { Credential } from '@chat-explorer/runner/access-config.js';
import { MemoryGate } from '@chat-explorer/runner/memory-gate.js';
import { defaultCodingLimits } from '@chat-explorer/runner/runner-config.js';
import { createTestApp, seedConversation, testMachineToken } from './helpers.js';

interface FakeRun {
  spec: EngineRunSpec;
  sent: string[];
  emit: (event: EngineEvent) => void;
  exit: (code: number | null, error?: string) => void;
  stopped: boolean;
  allowedHosts: HostPolicy[];
}

function fakeEngine() {
  const runs: FakeRun[] = [];
  const prompts: string[] = [];
  const engine: Engine = {
    complete: async (prompt) => {
      prompts.push(prompt);
      return '"Redis keys"';
    },
    start(spec) {
      const listeners: ((event: EngineEvent) => void)[] = [];
      const exitListeners: ((result: { code: number | null; error?: string }) => void)[] = [];
      const run: FakeRun = {
        spec,
        sent: [],
        emit: (event) => listeners.forEach((listener) => listener(event)),
        exit: (code, error) => exitListeners.forEach((listener) => listener({ code, error })),
        stopped: false,
        allowedHosts: [],
      };
      runs.push(run);
      return {
        send: (text) => run.sent.push(text),
        onEvent: (listener) => listeners.push(listener),
        onExit: (listener) => exitListeners.push(listener),
        allowHosts: (network) => run.allowedHosts.push(network),
        stop: () => {
          run.stopped = true;
          setTimeout(() => run.exit(0));
        },
      };
    },
  };
  return { engine, runs, prompts };
}

const until = async (condition: () => boolean, timeoutMs = 3_000) => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

interface SetupExtras {
  diskGuard?: DiskGuard;
  memoryGate?: MemoryGate;
  credentials?: Credential[];
}

// Docker with memory free for one coding container: it uses most of what's free once it runs.
function memoryForOne() {
  const gigabyte = 1024 ** 3;
  const gate: MemoryGate = new MemoryGate(
    { memory: '6656m', refusal: null },
    async () => (gate.forkIds.length === 0 ? 3 * gigabyte : 0.8 * gigabyte),
    undefined,
    { recheckMs: 50, startingMs: 0 },
  );
  return gate;
}

function setup(timings = {}, coding = false, extras: SetupExtras = {}) {
  const { diskGuard, memoryGate, credentials = [] } = extras;
  const context = createTestApp();
  const conversation = seedConversation(context.store);
  const client = new RunnerClient('http://127.0.0.1:4999', testMachineToken, async (url, init) =>
    context.app.request(url, {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init.headers)), host: '127.0.0.1:4999' },
    }),
  );
  const { engine, runs: engineRuns, prompts } = fakeEngine();
  const errors: unknown[] = [];
  const runner = new Runner({
    client,
    engine,
    config: {
      path: '/runner/config.json',
      coding: { enabled: coding, ...defaultCodingLimits, allowedHosts: null, credentials },
      localBackend: true,
    },
    diskGuard,
    memoryGate,
    runnerId: 'runner-test',
    toolsUrl: 'http://host.docker.internal:4999/api/tools/mcp',
    maxParallel: 2,
    timings: { claimWaitMs: 50, inputWaitMs: 20, heartbeatMs: 1_000, ...timings },
    onError: (error) => errors.push(error),
  });
  const messages = () => context.store.readFork(conversation.mainForkId).messages;
  return { ...context, ...conversation, runner, engineRuns, prompts, errors, messages };
}

const sessionId = '11111111-2222-3333-4444-555555555555';

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

    run!.emit({ type: 'session', sessionId, model: 'claude-haiku-5-5' });
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

  it('refuses a coding fork when its own config does not allow coding', async () => {
    const { runner, engineRuns, store, explorationId, mainForkId } = setup();
    store.setForkCoding(mainForkId, true);
    runner.start();
    store.submit(explorationId, mainForkId, 'Build it');
    await until(() => store.snapshot(explorationId).forkRuns[0]?.status === 'failed');
    expect(store.snapshot(explorationId).forkRuns[0]!.statusDetail).toMatch(
      /Coding is turned on for this fork, but this runner does not allow it.*\/runner\/config\.json/,
    );
    expect(engineRuns).toHaveLength(0);
    await runner.stop();
  });

  it('starts a coding fork with coding on when its config allows it', async () => {
    const { runner, engineRuns, store, explorationId, mainForkId } = setup({}, true);
    store.setForkCoding(mainForkId, true);
    runner.start();
    store.submit(explorationId, mainForkId, 'Build it');
    await until(() => engineRuns[0]?.sent.length === 1);
    expect(engineRuns[0]!.spec).toMatchObject({ forkId: mainForkId, explorationId, coding: true });
    await runner.stop();
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

  it('posts nothing for a turn whose answers all went out with the answer tool', async () => {
    const { runner, engineRuns, store, explorationId, mainForkId, messages } = setup();
    runner.start();
    store.submit(explorationId, mainForkId, 'Quick');
    await until(() => engineRuns[0]?.sent.length === 1);
    const before = messages().length;
    engineRuns[0]!.emit({
      type: 'turn-finished',
      answer: '[no reply]',
      failed: false,
      contextWindow: null,
    });
    await until(() => store.snapshot(explorationId).forkRuns[0]?.status === 'idle');
    expect(messages()).toHaveLength(before);
    await runner.stop();
  });

  it('starts a new container, resuming the session, once the coding switch changes', async () => {
    const { runner, engineRuns, store, explorationId, mainForkId, messages } = setup({}, true);
    runner.start();
    store.submit(explorationId, mainForkId, 'First');
    await until(() => engineRuns[0]?.sent.length === 1);
    engineRuns[0]!.emit({ type: 'session', sessionId, model: 'claude-haiku-5-5' });
    engineRuns[0]!.emit({
      type: 'turn-finished',
      answer: 'One.',
      failed: false,
      contextWindow: 1e6,
    });
    await until(() => store.snapshot(explorationId).forkRuns[0]?.status === 'idle');
    expect(messages().at(-1)?.text).toBe('One.');

    store.setForkCoding(mainForkId, true);
    store.submit(explorationId, mainForkId, 'Now build it');
    await until(() => engineRuns[1]?.sent.length === 1);
    expect(engineRuns[0]!.stopped).toBe(true);
    expect(engineRuns[0]!.sent).toEqual([expect.stringContaining('First')]);
    expect(engineRuns[1]!.spec).toMatchObject({ coding: true, resume: true, sessionId });
    expect(engineRuns[1]!.sent).toEqual(['Now build it']);
    await runner.stop();
  });

  it('replaces the container on request once no turn runs, resuming the session', async () => {
    const { runner, engineRuns, store, explorationId, mainForkId, runs } = setup({}, true);
    store.setForkCoding(mainForkId, true);
    runner.start();
    store.submit(explorationId, mainForkId, 'Start the dev server');
    await until(() => engineRuns[0]?.sent.length === 1);
    engineRuns[0]!.emit({ type: 'session', sessionId, model: 'claude-haiku-5-5' });
    expect(runs.requestRestart(mainForkId)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(engineRuns[0]!.stopped).toBe(false);
    engineRuns[0]!.emit({
      type: 'turn-finished',
      answer: 'Up.',
      failed: false,
      contextWindow: 1e6,
    });
    await until(() => engineRuns[0]!.stopped);
    await until(() => store.snapshot(explorationId).forkRuns[0]?.status === 'idle');

    store.submit(explorationId, mainForkId, 'Check it');
    await until(() => engineRuns[1]?.sent.length === 1);
    expect(engineRuns[1]!.spec).toMatchObject({ coding: true, resume: true, sessionId });
    await runner.stop();
  });

  it("starts a new container with a fork's newly picked credential", async () => {
    const credential: Credential = {
      name: 'GitHub token',
      type: 'token',
      file: '/runner/secrets/github-token',
      username: 'x-access-token',
      hosts: [{ pattern: 'api.github.com:443', private: false, hidden: false }],
      knownHosts: [],
      hidden: false,
    };
    const { runner, engineRuns, store, explorationId, mainForkId } = setup({}, true, {
      credentials: [credential],
    });
    store.setForkCoding(mainForkId, true);
    runner.start();
    store.submit(explorationId, mainForkId, 'Clone it');
    await until(() => engineRuns[0]?.sent.length === 1);
    expect(engineRuns[0]!.spec.credentials).toEqual([]);
    engineRuns[0]!.emit({
      type: 'turn-finished',
      answer: 'Done.',
      failed: false,
      contextWindow: 1e6,
    });
    await until(() => store.snapshot(explorationId).forkRuns[0]?.status === 'idle');

    store.setForkNetwork(mainForkId, { hosts: [], registries: [], credentials: ['GitHub token'] });
    store.submit(explorationId, mainForkId, 'Now push');
    await until(() => engineRuns[1]?.sent.length === 1);
    expect(engineRuns[0]!.stopped).toBe(true);
    expect(engineRuns[1]!.spec.credentials).toEqual([credential]);
    expect(engineRuns[1]!.spec.network.hosts).toEqual(['api.github.com:443']);
    await runner.stop();
  });

  it('gives a coding fork its allowed hosts, and follows a change without a new container', async () => {
    const { runner, engineRuns, store, explorationId, mainForkId } = setup({}, true);
    store.setForkCoding(mainForkId, true);
    store.setForkNetwork(mainForkId, {
      hosts: ['github.com:443'],
      registries: [],
      credentials: [],
    });
    runner.start();
    store.submit(explorationId, mainForkId, 'Clone it');
    await until(() => engineRuns[0]?.sent.length === 1);
    expect(engineRuns[0]!.spec.network.hosts).toEqual(['github.com:443']);

    store.setForkNetwork(mainForkId, {
      hosts: ['github.com:443'],
      registries: ['npm'],
      credentials: [],
    });
    store.submit(explorationId, mainForkId, 'Now install');
    await until(() => engineRuns[0]!.sent.length === 2);
    expect(engineRuns[0]!.allowedHosts.at(-1)?.hosts).toEqual(
      expect.arrayContaining(['github.com:443', 'registry.npmjs.org:443']),
    );
    expect(engineRuns).toHaveLength(1);
    await runner.stop();
  });

  it('gives a chat fork no hosts, whatever its settings say', async () => {
    const { runner, engineRuns, store, explorationId, mainForkId } = setup({}, true);
    store.setForkNetwork(mainForkId, {
      hosts: ['github.com:443'],
      registries: ['npm'],
      credentials: [],
    });
    runner.start();
    store.submit(explorationId, mainForkId, 'Hello');
    await until(() => engineRuns[0]?.sent.length === 1);
    expect(engineRuns[0]!.spec.network.hosts).toEqual([]);
    await runner.stop();
  });

  it('holds a coding fork while Docker has no memory for it, and starts it once room frees', async () => {
    const gate = memoryForOne();
    const { runner, engineRuns, store, explorationId, mainForkId } = setup({}, true, {
      memoryGate: gate,
    });
    const other = seedConversation(store);
    store.setForkCoding(mainForkId, true);
    store.setForkCoding(other.mainForkId, true);
    const runOf = (forkId: string) =>
      store
        .snapshot(forkId === mainForkId ? explorationId : other.explorationId)
        .forkRuns.find((run) => run.forkId === forkId);
    runner.start();
    store.submit(explorationId, mainForkId, 'Build the first');
    await until(() => engineRuns[0]?.sent.length === 1);
    store.submit(other.explorationId, other.mainForkId, 'Build the second');
    await until(() => runOf(other.mainForkId)?.status === 'waiting_memory');
    expect(runOf(other.mainForkId)?.statusDetail).toBe(
      'Docker has 0.8 GB of memory free, and a coding fork needs 2.5 GB free to start.',
    );
    expect(engineRuns).toHaveLength(1);

    engineRuns[0]!.emit({
      type: 'turn-finished',
      answer: 'Done.',
      failed: false,
      contextWindow: 1e6,
    });
    await until(() => runOf(mainForkId)?.status === 'idle');
    await runner.stop();
    await until(() => gate.forkIds.length === 0);
  });

  it('starts the waiting coding fork when the other one lets its container go', async () => {
    const gate = memoryForOne();
    const { runner, engineRuns, store, explorationId, mainForkId } = setup(
      { idleCloseMs: 100 },
      true,
      { memoryGate: gate },
    );
    const other = seedConversation(store);
    store.setForkCoding(mainForkId, true);
    store.setForkCoding(other.mainForkId, true);
    runner.start();
    store.submit(explorationId, mainForkId, 'Build the first');
    await until(() => engineRuns[0]?.sent.length === 1);
    store.submit(other.explorationId, other.mainForkId, 'Build the second');
    await until(() => gate.forkIds.length === 1 && engineRuns.length === 1);
    engineRuns[0]!.emit({
      type: 'turn-finished',
      answer: 'Done.',
      failed: false,
      contextWindow: 1e6,
    });
    await until(() => engineRuns[1]?.sent.length === 1);
    expect(engineRuns[1]!.spec.forkId).toBe(other.mainForkId);
    expect(engineRuns[1]!.sent[0]).toContain('Build the second');
    expect(gate.forkIds).toEqual([other.mainForkId]);
    await runner.stop();
  });

  it('lets the reader stop a coding fork that waits for memory, its message handled', async () => {
    const gate = memoryForOne();
    const { runner, engineRuns, store, explorationId, mainForkId, runs } = setup({}, true, {
      memoryGate: gate,
    });
    const other = seedConversation(store);
    store.setForkCoding(mainForkId, true);
    store.setForkCoding(other.mainForkId, true);
    const otherRun = () => store.snapshot(other.explorationId).forkRuns[0];
    runner.start();
    store.submit(explorationId, mainForkId, 'Build the first');
    await until(() => engineRuns[0]?.sent.length === 1);
    store.submit(other.explorationId, other.mainForkId, 'Build the second');
    await until(() => otherRun()?.status === 'waiting_memory');
    expect(runs.requestStop(other.mainForkId)).toBe(true);
    await until(() => otherRun()?.status === 'idle', 5_000);
    expect(otherRun()?.handledUpTo).toBe(store.readFork(other.mainForkId).messages.at(-1)!.id);
    expect(engineRuns).toHaveLength(1);
    await runner.stop();
  });

  it('refuses to start a coding fork the disk guard turns down, with its reason', async () => {
    const guard: DiskGuard = {
      refusal: async () => 'Your Mac has 2.0 GB free.',
      check: async () => ({}),
    };
    const { runner, engineRuns, store, explorationId, mainForkId } = setup({}, true, {
      diskGuard: guard,
    });
    store.setForkCoding(mainForkId, true);
    runner.start();
    store.submit(explorationId, mainForkId, 'Build it');
    await until(() => store.snapshot(explorationId).forkRuns[0]?.status === 'failed');
    expect(store.snapshot(explorationId).forkRuns[0]!.statusDetail).toBe(
      'Your Mac has 2.0 GB free.',
    );
    expect(engineRuns).toHaveLength(0);
    await runner.stop();
  });

  it('warns once when a coding workspace grows past its limit, and stops it past the hard one', async () => {
    let verdict: { warning?: string; stop?: string } = {};
    const guard: DiskGuard = { refusal: async () => null, check: async () => verdict };
    const { runner, engineRuns, store, explorationId, mainForkId } = setup(
      { diskCheckMs: 10 },
      true,
      { diskGuard: guard },
    );
    store.setForkCoding(mainForkId, true);
    runner.start();
    store.submit(explorationId, mainForkId, 'Build it');
    await until(() => engineRuns[0]?.sent.length === 1);
    verdict = { warning: 'The workspace is 11.0 GB, over its 10 GB limit.' };
    const warnings = () =>
      store
        .snapshot(explorationId)
        .activities.filter((activity) => activity.text.startsWith('The workspace is'));
    await until(() => warnings().length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(warnings()).toHaveLength(1);
    verdict = { stop: 'The workspace is 16.0 GB, past 1.5 times its limit.' };
    await until(() => engineRuns[0]!.stopped);
    await until(() => store.snapshot(explorationId).forkRuns[0]?.status !== 'answering');
    await runner.stop();
  });

  it('keeps a turn alive while its tool call sends heartbeats, past the stuck limit', async () => {
    const { runner, engineRuns, store, explorationId, mainForkId } = setup({ stuckMs: 100 });
    runner.start();
    store.submit(explorationId, mainForkId, 'Build the project');
    await until(() => engineRuns[0]?.sent.length === 1);
    engineRuns[0]!.emit({ type: 'tool', name: 'Bash', summary: 'Running npm run build' });
    for (let beat = 0; beat < 8; beat++) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      engineRuns[0]!.emit({ type: 'heartbeat' });
    }
    expect(engineRuns[0]!.stopped).toBe(false);
    expect(store.snapshot(explorationId).forkRuns[0]?.status).toBe('answering');
    await until(() => engineRuns[0]!.stopped, 1_000);
    await runner.stop();
  });

  it('lets an idle engine go and resumes its session for the next message', async () => {
    const { runner, engineRuns, store, explorationId, mainForkId, messages } = setup({
      idleCloseMs: 30,
    });
    runner.start();
    store.submit(explorationId, mainForkId, 'First');
    await until(() => engineRuns[0]?.sent.length === 1);
    engineRuns[0]!.emit({ type: 'session', sessionId, model: 'claude-haiku-5-5' });
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
    expect(engineRuns[1]!.spec).toMatchObject({ resume: true, sessionId });
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

  it('names a note saved without a topic', async () => {
    const { runner, store, explorationId, prompts } = setup();
    const group = store.createNoteGroup(explorationId, {});
    const note = store.createNote(explorationId, {
      groupId: group.id,
      description: 'Use Redis for the cache keys.',
    });
    runner.start();
    await until(() => store.note(note.id).topic !== null);
    expect(store.note(note.id).topic).toBe('Redis keys');
    expect(prompts[0]).toContain('Use Redis for the cache keys.');
    await runner.stop();
  });

  it('stops a turn the reader stops, and answers the next message afresh', async () => {
    const { runner, engineRuns, store, runs, explorationId, mainForkId, messages } = setup();
    runner.start();
    store.submit(explorationId, mainForkId, 'Something long');
    await until(() => engineRuns[0]?.sent.length === 1);
    expect(runs.requestStop(mainForkId)).toBe(true);
    await until(() => engineRuns[0]!.stopped);
    await until(() => runner.activeForks.length === 0);
    const activities = store.snapshot(explorationId).activities;
    expect(activities.at(-1)).toMatchObject({ kind: 'progress', text: 'Stopped' });
    expect(runs.claimable()).toEqual([]);

    store.submit(explorationId, mainForkId, 'Do this instead');
    await until(() => engineRuns[1]?.sent.length === 1);
    expect(engineRuns[1]!.sent[0]).toMatch(/Do this instead$/);
    expect(messages().at(-1)?.text).toBe('Do this instead');
    await runner.stop();
  });
});
