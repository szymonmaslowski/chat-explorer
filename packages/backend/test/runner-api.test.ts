import { describe, expect, it } from 'vitest';
import { createTestApp, seedConversation, testMachineToken } from './helpers.js';

function setup() {
  const context = createTestApp();
  const conversation = seedConversation(context.store);
  const runner = async (path: string, json: object, token = testMachineToken) => {
    const response = await context.request(`/api/runner/${path}`, {
      method: 'POST',
      json,
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: response.status, body: await response.json() };
  };
  return { ...context, ...conversation, runner };
}

describe('runner API', () => {
  it('refuses a runner without the machine token', async () => {
    const { runner } = setup();
    expect((await runner('claim', { runnerId: 'r' }, 'wrong')).status).toBe(401);
  });

  it('waits for a submit, claims its fork, delivers the message and stores the answer', async () => {
    const { runner, store, explorationId, mainForkId } = setup();
    const claim = runner('claim', { runnerId: 'runner-a', waitMs: 5_000 });
    store.submit(explorationId, mainForkId, 'How long to keep them?');
    const { body } = await claim;
    expect(body.lease).toMatchObject({ forkId: mainForkId, attempt: 1 });
    const { leaseId } = body.lease;

    const input = await runner(`forks/${mainForkId}/input`, { leaseId });
    expect(input.body.messages).toEqual([
      { id: expect.any(String), text: 'How long to keep them?' },
    ]);
    expect(store.queuedSubmissions(explorationId)).toEqual([]);

    const answered = await runner(`forks/${mainForkId}/answer`, { leaseId, content: 'A minute.' });
    expect(answered.status).toBe(201);
    await runner(`forks/${mainForkId}/turn/finish`, {
      leaseId,
      upToMessageId: input.body.messages[0].id,
    });
    expect((await runner(`forks/${mainForkId}/input`, { leaseId })).body.messages).toEqual([]);
    expect(store.readFork(mainForkId).messages.at(-1)).toMatchObject({ text: 'A minute.' });
  });

  it('hands a message sent during a turn to the runner waiting for input', async () => {
    const { runner, store, explorationId, mainForkId } = setup();
    store.submit(explorationId, mainForkId, 'First');
    const { leaseId } = (await runner('claim', { runnerId: 'runner-a' })).body.lease;
    const first = await runner(`forks/${mainForkId}/input`, { leaseId });
    await runner(`forks/${mainForkId}/turn/finish`, {
      leaseId,
      upToMessageId: first.body.messages[0].id,
    });

    const waiting = runner(`forks/${mainForkId}/input`, { leaseId, waitMs: 5_000 });
    store.submit(explorationId, mainForkId, 'Second, mid-turn');
    expect((await waiting).body.messages).toMatchObject([{ text: 'Second, mid-turn' }]);
  });

  it('rejects a stale lease', async () => {
    const { runner, store, explorationId, mainForkId } = setup();
    store.submit(explorationId, mainForkId, 'Hello');
    await runner('claim', { runnerId: 'runner-a' });
    const stale = await runner(`forks/${mainForkId}/heartbeat`, { leaseId: 'not-mine' });
    expect(stale).toMatchObject({ status: 409, body: { error: 'stale_lease' } });
  });

  it('claims only the forks of one chat for a runner that asks so', async () => {
    const { runner, store, explorationId, mainForkId } = setup();
    const other = store.createExploration({ messages: [{ role: 'user', content: 'Other' }] });
    store.submit(explorationId, mainForkId, 'Mine');
    const { body } = await runner('claim', { runnerId: 'r', explorationId });
    expect(body.lease).toMatchObject({ forkId: mainForkId });
    const none = await runner('claim', { runnerId: 'r', explorationId });
    expect(none.body.lease).toBeNull();
    expect((await runner('claim', { runnerId: 'r' })).body.lease).toMatchObject({
      forkId: other.mainFork.id,
    });
  });
});
