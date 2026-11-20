import { describe, expect, it } from 'vitest';
import { FeedbackHub } from '../src/store/feedback-hub.js';
import { followUpIdleMs, leaseMs, RunStore } from '../src/store/runs.js';
import { supervisorMessagePrefix } from '../src/store/store.js';
import { createTestStore, seedConversation } from './helpers.js';

function setup() {
  const context = createTestStore();
  const conversation = seedConversation(context.store);
  const hub = new FeedbackHub(
    context.store,
    context.bus,
    () => context.clock.now,
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

const forkIds = (result: Awaited<ReturnType<ReturnType<typeof setup>['feedback']>>) =>
  result.status === 'feedback' ? result.forks.map((fork) => fork.forkId) : [];

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
    runs.finishShimTurn(mainForkId, 'shim-a', fork!.inReplyTo, 'answer-id');
    // It keeps the fork while it works on after answering.
    expect(store.snapshot(explorationId).forkRuns[0]).toMatchObject({
      status: 'answering',
      heldByTerminal: true,
    });
    runs.releaseShimFollowUps('shim-a');
    expect(store.snapshot(explorationId).forkRuns[0]).toMatchObject({
      status: 'idle',
      heldByTerminal: false,
    });
    expect(await feedback()).toEqual({ status: 'timeout' });
  });

  it('lets go of a fork it answered when it stops making steps or goes away', async () => {
    const { store, runs, clock, feedback, explorationId, mainForkId } = setup();
    store.submit(explorationId, mainForkId, 'Long work');
    const result = await feedback();
    const inReplyTo = result.status === 'feedback' ? result.forks[0]!.inReplyTo : '';
    runs.finishShimTurn(mainForkId, 'shim-a', inReplyTo, 'answer-id');

    clock.now += followUpIdleMs - 1;
    runs.renewShimLeases('shim-a');
    runs.releaseStaleFollowUps();
    expect(runs.shimFollowUps(explorationId, 'shim-a')).toEqual([mainForkId]);
    clock.now += 2;
    runs.releaseStaleFollowUps();
    expect(runs.shimFollowUps(explorationId, 'shim-a')).toEqual([]);
    expect(store.snapshot(explorationId).forkRuns[0]).toMatchObject({ status: 'idle' });

    store.submit(explorationId, mainForkId, 'More');
    const again = await feedback();
    runs.finishShimTurn(
      mainForkId,
      'shim-a',
      again.status === 'feedback' ? again.forks[0]!.inReplyTo : '',
      'answer-2',
    );
    clock.now += leaseMs + 1;
    runs.releaseStaleFollowUps();
    expect(runs.shimFollowUps(explorationId, 'shim-a')).toEqual([]);
    expect(runs.claimable()).toEqual([]);
  });

  it('lets go of an answered fork whose follow-up a daemon restart forgot', async () => {
    const context = setup();
    const { store, feedback, explorationId, mainForkId, database, bus, clock } = context;
    store.submit(explorationId, mainForkId, 'Before the restart');
    const result = await feedback();
    const inReplyTo = result.status === 'feedback' ? result.forks[0]!.inReplyTo : '';
    context.runs.finishShimTurn(mainForkId, 'shim-a', inReplyTo, 'answer-id');

    const restarted = new RunStore(database, bus, store, () => clock.now);
    restarted.releaseStaleFollowUps();
    expect(store.snapshot(explorationId).forkRuns[0]).toMatchObject({
      status: 'idle',
      heldByTerminal: false,
    });
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

  it('answers only the main fork while a runner is online, and leaves the others to it', async () => {
    const { store, runs, feedback, explorationId, mainForkId, answer } = setup();
    const side = store.forkAtAnswer(answer.id);
    store.submit(explorationId, side.id, 'For the runner');
    store.submit(explorationId, mainForkId, 'For the session');
    runs.runnerSeen();

    expect(forkIds(await feedback())).toEqual([mainForkId]);
    expect(runs.claimable()).toEqual([{ forkId: side.id, explorationId }]);
  });

  it('takes all forks of its chat while no runner is online', async () => {
    const { store, feedback, explorationId, mainForkId, answer } = setup();
    const side = store.forkAtAnswer(answer.id);
    store.submit(explorationId, side.id, 'Nobody else is here');
    store.submit(explorationId, mainForkId, 'Main too');

    expect(forkIds(await feedback()).toSorted()).toEqual([mainForkId, side.id].toSorted());
  });
});

describe('the main fork overseeing the other forks', () => {
  it('sends a fork a message the runner picks up, marked as coming from the main fork', () => {
    const { store, runs, explorationId, answer } = setup();
    const side = store.forkAtAnswer(answer.id);
    runs.runnerSeen();
    store.addSupervisorMessage(side.id, 'Look at the second option too.');

    expect(store.readFork(side.id).messages.at(-1)).toMatchObject({
      role: 'user',
      text: `${supervisorMessagePrefix}\n\nLook at the second option too.`,
    });
    expect(runs.claimable()).toEqual([{ forkId: side.id, explorationId }]);
  });

  it('refuses to message the main fork', () => {
    const { store, mainForkId } = setup();
    expect(() => store.addSupervisorMessage(mainForkId, 'Hi')).toThrow(/main fork/);
  });

  it("shows each fork's run on the map", async () => {
    const { store, feedback, explorationId, mainForkId } = setup();
    store.submit(explorationId, mainForkId, 'Working on it');
    await feedback();
    expect(store.forkMap(explorationId)[0]?.run).toMatchObject({
      status: 'answering',
      heldByTerminal: true,
    });
  });
});
