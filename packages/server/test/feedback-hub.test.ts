import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestStore, seedConversation } from './helpers.js';

function setup() {
  const context = createTestStore();
  const conversation = seedConversation(context.store);
  context.store.attach({
    explorationId: conversation.explorationId,
    shimId: 'shim-a',
    sessionId: 'session-a',
    takeover: false,
  });
  return { ...context, ...conversation };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('feedback hub', () => {
  it('returns pending forks immediately', async () => {
    const { store, hub, explorationId, mainForkId } = setup();
    store.submit(explorationId, mainForkId, 'hello');
    const result = await hub.waitForFeedback({ explorationId, shimId: 'shim-a', waitMs: 1000 });
    expect(result).toMatchObject({ status: 'feedback', forks: [{ forkId: mainForkId }] });
    hub.stop();
  });

  it('wakes a waiting call when a submission is queued, after the queued event', async () => {
    const { store, hub, events, explorationId, mainForkId } = setup();
    const waiting = hub.waitForFeedback({ explorationId, shimId: 'shim-a', waitMs: 60_000 });
    expect(hub.status(explorationId)).toBe('listening');
    store.submit(explorationId, mainForkId, 'hello');
    const result = await waiting;
    expect(result.status).toBe('feedback');
    const types = events.map((event) => event.type);
    expect(types.indexOf('submission.queued')).toBeLessThan(types.indexOf('submission.delivered'));
    hub.stop();
  });

  it('times out when nothing arrives', async () => {
    vi.useFakeTimers();
    const { hub, explorationId } = setup();
    const waiting = hub.waitForFeedback({ explorationId, shimId: 'shim-a', waitMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await waiting).toEqual({ status: 'timeout' });
    hub.stop();
  });

  it('tells the old session it was detached when another one takes over', async () => {
    const { store, hub, explorationId } = setup();
    const waiting = hub.waitForFeedback({ explorationId, shimId: 'shim-a', waitMs: 60_000 });
    store.attach({ explorationId, shimId: 'shim-b', sessionId: 'session-b', takeover: true });
    expect(await waiting).toEqual({ status: 'detached' });
    expect(await hub.waitForFeedback({ explorationId, shimId: 'shim-a', waitMs: 1000 })).toEqual({
      status: 'detached',
    });
    hub.stop();
  });

  it('tells the session the exploration was deleted', async () => {
    const { store, hub, explorationId } = setup();
    const waiting = hub.waitForFeedback({ explorationId, shimId: 'shim-a', waitMs: 60_000 });
    store.deleteExploration(explorationId);
    expect(await waiting).toEqual({ status: 'deleted' });
    hub.stop();
  });

  it('keeps reporting listening between two long-poll rounds', async () => {
    vi.useFakeTimers();
    const { hub, explorationId } = setup();
    const round = hub.waitForFeedback({ explorationId, shimId: 'shim-a', waitMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await round;
    expect(hub.status(explorationId)).toBe('listening');
    hub.stop();
  });

  it('stops reporting listening once feedback was handed over', async () => {
    const { store, hub, explorationId, mainForkId } = setup();
    const waiting = hub.waitForFeedback({ explorationId, shimId: 'shim-a', waitMs: 60_000 });
    store.submit(explorationId, mainForkId, 'hello');
    await waiting;
    expect(hub.status(explorationId)).toBe('answering');
    hub.stop();
  });

  it('reports answering while delivered forks wait for an answer', async () => {
    const { store, hub, explorationId, mainForkId } = setup();
    store.submit(explorationId, mainForkId, 'hello');
    store.deliverQueued(explorationId);
    expect(hub.status(explorationId)).toBe('answering');
    hub.stop();
  });

  it('reports detached when no session is attached', () => {
    const { store, hub, explorationId } = setup();
    store.detach('shim-a');
    expect(hub.status(explorationId)).toBe('detached');
    hub.stop();
  });
});
