import { describe, expect, it } from 'vitest';
import { leaseMs, maxFailedAttempts, RunStore } from '../src/store/runs.js';
import { createTestStore, seedConversation } from './helpers.js';

function setup() {
  const context = createTestStore();
  const conversation = seedConversation(context.store);
  const runs = new RunStore(context.database, context.bus, context.store, () => context.clock.now);
  const ask = (text: string, forkId = conversation.mainForkId) => {
    context.store.submit(conversation.explorationId, forkId, text);
    context.store.deliverQueued(conversation.explorationId);
    return context.store.readFork(forkId).messages.at(-1)!;
  };
  return { ...context, ...conversation, runs, ask };
}

describe('claiming forks', () => {
  it('offers a fork with an unanswered message, and not once a turn answered it', () => {
    const { runs, ask, mainForkId, explorationId } = setup();
    expect(runs.claimable()).toEqual([]);

    const question = ask('What about Redis?');
    expect(runs.claimable()).toEqual([{ forkId: mainForkId, explorationId }]);

    const lease = runs.claim(mainForkId, 'runner-a')!;
    expect(lease).toMatchObject({ forkId: mainForkId, attempt: 1, sessionId: null });
    expect(runs.claimable()).toEqual([]);
    expect(runs.claim(mainForkId, 'runner-b')).toBeNull();

    expect(runs.pendingInput(mainForkId, lease.leaseId)).toEqual([
      { id: question.id, text: 'What about Redis?' },
    ]);
    runs.answer(mainForkId, lease.leaseId, 'Redis works.');
    runs.finishTurn(mainForkId, lease.leaseId, question.id);
    expect(runs.pendingInput(mainForkId, lease.leaseId)).toEqual([]);
    runs.release(mainForkId, lease.leaseId);
    expect(runs.claimable()).toEqual([]);
  });

  it('claims the new fork a submission starts, not the fork it was sent from', () => {
    const { runs, store, mainForkId, explorationId } = setup();
    store.submit(explorationId, mainForkId, 'Branch off here', { newFork: true });
    expect(runs.claim(mainForkId, 'runner-a')).toBeNull();
    const [, newFork] = store.forkMap(explorationId);
    expect(runs.claimable()).toEqual([{ forkId: newFork!.id, explorationId }]);
    expect(store.forkMap(explorationId)[0]?.run).toBeNull();
  });

  it('leaves a chat with a live terminal session to that session', () => {
    const { runs, ask, store, explorationId } = setup();
    ask('Still there?');
    store.attach({ explorationId, shimId: 'shim-a', sessionId: 'session-a', takeover: false });
    expect(runs.claimable()).toEqual([]);
    store.detach('shim-a');
    expect(runs.claimable()).toHaveLength(1);
  });

  it('answers archived chats, and skips deleted ones', () => {
    const { runs, ask, store, explorationId } = setup();
    store.archiveExploration(explorationId);
    ask('Anyone?');
    expect(runs.claimable()).toHaveLength(1);
    store.deleteExploration(explorationId);
    expect(runs.claimable()).toEqual([]);
  });
});

describe('leases', () => {
  it('keeps the lease of a runner that slept, unless another runner claimed the fork since', () => {
    const { runs, ask, clock, mainForkId } = setup();
    ask('A question');
    const lease = runs.claim(mainForkId, 'runner-a')!;
    clock.now += leaseMs + 1;
    runs.heartbeat(mainForkId, lease.leaseId);
    expect(runs.claim(mainForkId, 'runner-b')).toBeNull();

    clock.now += leaseMs + 1;
    const taken = runs.claim(mainForkId, 'runner-b')!;
    expect(taken.attempt).toBe(2);
    expect(() => runs.heartbeat(mainForkId, lease.leaseId)).toThrow('no longer yours');
  });

  it('marks what a dead attempt did as interrupted and stops after too many attempts', () => {
    const { runs, ask, clock, mainForkId, events } = setup();
    const question = ask('A question');
    for (let attempt = 1; attempt <= maxFailedAttempts; attempt++) {
      const lease = runs.claim(mainForkId, 'runner-a')!;
      runs.addActivity(mainForkId, lease.leaseId, {
        afterMessageId: question.id,
        kind: 'tool',
        text: `Searching, attempt ${attempt}`,
      });
      clock.now += leaseMs + 1;
    }
    expect(runs.claim(mainForkId, 'runner-a')).toBeNull();
    expect(runs.claimable()).toEqual([]);
    expect(events.filter((event) => event.type === 'activities.interrupted')).toHaveLength(
      maxFailedAttempts,
    );
    const lastRun = events.filter((event) => event.type === 'fork-run.updated').at(-1);
    expect(lastRun).toMatchObject({ run: { status: 'failed' } });

    runs.retry(mainForkId);
    expect(runs.claim(mainForkId, 'runner-a')).not.toBeNull();
  });

  it('gives the fork back after a failed run', () => {
    const { runs, ask, mainForkId } = setup();
    ask('A question');
    const lease = runs.claim(mainForkId, 'runner-a')!;
    runs.fail(mainForkId, lease.leaseId, 'Docker is not running.');
    expect(runs.claimable()).toHaveLength(1);
    expect(() => runs.heartbeat(mainForkId, lease.leaseId)).toThrow('no longer yours');
  });

  it('does not count a message a stopped turn handled as awaiting an answer', () => {
    const { runs, store, ask, mainForkId, explorationId } = setup();
    const question = ask('Never mind');
    const lease = runs.claim(mainForkId, 'runner-a')!;
    expect(store.forkMap(explorationId)[0]?.awaitingAnswer).toBe(true);
    runs.stopped(mainForkId, lease.leaseId, question.id);
    expect(store.forkMap(explorationId)[0]).toMatchObject({
      awaitingAnswer: false,
      run: { handledUpTo: question.id },
    });
    expect(store.listExplorations('active')[0]?.awaitingAnswer).toBe(false);
  });

  it('marks a released fork idle', () => {
    const { runs, store, ask, mainForkId, explorationId } = setup();
    ask('A question');
    const lease = runs.claim(mainForkId, 'runner-a')!;
    runs.release(mainForkId, lease.leaseId);
    expect(store.forkMap(explorationId)[0]?.run).toMatchObject({ status: 'idle' });
  });
});

describe('what a turn reports', () => {
  it('stores the answer, the activity, the session and the usage', () => {
    const { runs, ask, store, explorationId, mainForkId } = setup();
    const question = ask('A question');
    const lease = runs.claim(mainForkId, 'runner-a')!;
    runs.recordSession(mainForkId, lease.leaseId, 'session-1');
    runs.addActivity(mainForkId, lease.leaseId, {
      afterMessageId: question.id,
      kind: 'tool',
      text: 'Searching the web for Redis',
    });
    runs.recordUsage(mainForkId, lease.leaseId, {
      model: 'claude-haiku-5-5',
      contextTokens: 17_000,
      contextWindow: 1_000_000,
    });
    runs.answer(mainForkId, lease.leaseId, 'Use Redis.');

    const snapshot = store.snapshot(explorationId);
    expect(snapshot.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Use Redis.' });
    expect(snapshot.activities).toMatchObject([
      { afterMessageId: question.id, kind: 'tool', attempt: 1, interrupted: false },
    ]);
    expect(snapshot.forkRuns).toMatchObject([
      { status: 'answering', model: 'claude-haiku-5-5', contextTokens: 17_000 },
    ]);
    runs.finishTurn(mainForkId, lease.leaseId, question.id);
    runs.release(mainForkId, lease.leaseId);
    ask('A follow-up');
    expect(runs.claim(mainForkId, 'runner-b')).toMatchObject({ sessionId: 'session-1' });
  });
});

describe('status from the runner', () => {
  it('is listening while a runner is around, working while a fork is answered', () => {
    const { runs, ask, clock, explorationId, mainForkId } = setup();
    expect(runs.status(explorationId)).toBe('detached');
    runs.runnerSeen();
    expect(runs.status(explorationId)).toBe('listening');
    ask('A question');
    const lease = runs.claim(mainForkId, 'runner-a')!;
    expect(runs.status(explorationId)).toBe('answering');
    runs.finishTurn(mainForkId, lease.leaseId, runs.pendingInput(mainForkId, lease.leaseId)[0]!.id);
    runs.release(mainForkId, lease.leaseId);
    expect(runs.status(explorationId)).toBe('listening');
    clock.now += 120_000;
    expect(runs.status(explorationId)).toBe('detached');
  });
});
