import { describe, expect, it } from 'vitest';
import { FeedbackHub } from '../src/store/feedback-hub.js';
import { leaseMs } from '../src/store/runs.js';
import { createTestStore, seedConversation } from './helpers.js';

function setup() {
  const context = createTestStore();
  const conversation = seedConversation(context.store);
  const hub = new FeedbackHub(
    context.store,
    context.bus,
    () => context.clock.now,
    context.sessions,
    context.runs,
  );
  context.store.attach({
    explorationId: conversation.explorationId,
    shimId: 'shim-a',
    sessionId: 'session-a',
    takeover: false,
  });
  const feedback = () =>
    hub.waitForFeedback({
      explorationId: conversation.explorationId,
      shimId: 'shim-a',
      waitMs: 10,
    });
  return { ...context, ...conversation, hub, feedback };
}

describe('an attached terminal session as the runner of its chat', () => {
  it('holds the forks it was handed until it answers them', async () => {
    const { store, runs, feedback, explorationId, mainForkId } = setup();
    store.submit(explorationId, mainForkId, 'For the session');
    const result = await feedback();
    expect(result).toMatchObject({ status: 'feedback', forks: [{ forkId: mainForkId }] });
    expect(runs.claimable()).toEqual([]);
    expect(store.snapshot(explorationId).forkRuns[0]).toMatchObject({
      status: 'answering',
      heldByTerminal: true,
    });
    expect(runs.requestStop(mainForkId)).toBe(false);

    const handedAgain = await feedback();
    expect(handedAgain).toMatchObject({ forks: [{ forkId: mainForkId }] });

    const fork = result.status === 'feedback' ? result.forks[0]! : null;
    store.addAssistantMessage({
      shimId: 'shim-a',
      forkId: mainForkId,
      inReplyTo: fork!.inReplyTo,
      content: 'Answered.',
    });
    runs.finishShimTurn(mainForkId, 'shim-a', fork!.inReplyTo);
    expect(store.snapshot(explorationId).forkRuns[0]).toMatchObject({
      status: 'idle',
      heldByTerminal: false,
    });
    expect(await feedback()).toEqual({ status: 'timeout' });
  });

  it('keeps its leases while it heartbeats, and leaves them to a runner once it is gone', async () => {
    const { store, runs, clock, feedback, explorationId, mainForkId } = setup();
    store.submit(explorationId, mainForkId, 'Then it went away');
    await feedback();
    clock.now += leaseMs - 1;
    runs.renewShimLeases('shim-a');
    clock.now += leaseMs - 1;
    expect(runs.claimable('shim-a')).toEqual([]);

    store.detach('shim-a');
    clock.now += leaseMs + 1;
    expect(runs.claimable()).toEqual([{ forkId: mainForkId, explorationId }]);
  });
});
