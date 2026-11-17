import { describe, expect, it } from 'vitest';
import type { Activity, LightSnapshot, MessageBody } from '@chat-explorer/shared/types.js';
import { createTestApp, seedConversation } from './helpers.js';

function answeredWithSteps() {
  const app = createTestApp();
  const { store, runs } = app;
  const conversation = seedConversation(store);
  const { explorationId, mainForkId } = conversation;
  const ask = (text: string) => {
    store.submit(explorationId, mainForkId, text);
    store.deliverQueued(explorationId);
    return store.readFork(mainForkId).messages.at(-1)!;
  };
  const first = ask('What about Redis?');
  const done = runs.claim(mainForkId, 'runner-a')!;
  runs.startTurn(mainForkId, done.leaseId);
  for (const text of ['Searching', 'Reading']) {
    runs.addActivity(mainForkId, done.leaseId, { afterMessageId: first.id, kind: 'tool', text });
  }
  runs.answer(mainForkId, done.leaseId, `[m:${first.id}]\nUse it for sessions.`);
  runs.finishTurn(mainForkId, done.leaseId, first.id);
  runs.release(mainForkId, done.leaseId);

  const second = ask('And for queues?');
  const running = runs.claim(mainForkId, 'runner-a')!;
  runs.startTurn(mainForkId, running.leaseId);
  runs.addActivity(mainForkId, running.leaseId, {
    afterMessageId: second.id,
    kind: 'tool',
    text: 'Thinking',
  });
  return { ...app, ...conversation, first, second };
}

describe('light chat load', () => {
  it('sends messages without their text, with what each answer answers', async () => {
    const { request, explorationId, first } = answeredWithSteps();
    const light: LightSnapshot = await (
      await request(`/api/explorations/${explorationId}?light`)
    ).json();
    expect(light.messages.every((message) => !('content' in message))).toBe(true);
    const answer = light.messages.find((message) => message.parentId === first.id)!;
    expect(answer).toMatchObject({ role: 'assistant', answers: [first.id] });
    expect(light.messages[0]).toMatchObject({ role: 'user', answers: [] });
  });

  it('counts the steps of finished attempts and sends those of running ones', async () => {
    const { request, explorationId, mainForkId, first, second } = answeredWithSteps();
    const light: LightSnapshot = await (
      await request(`/api/explorations/${explorationId}?light`)
    ).json();
    expect(light.activities.map((activity) => activity.text)).toEqual(['Thinking']);
    expect(light.activitySummaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ forkId: mainForkId, afterMessageId: first.id, count: 2 }),
        expect.objectContaining({ afterMessageId: second.id, count: 1, interrupted: false }),
      ]),
    );

    const summary = light.activitySummaries.find((each) => each.afterMessageId === first.id)!;
    const query = new URLSearchParams({
      forkId: summary.forkId,
      afterMessageId: summary.afterMessageId,
      attempt: String(summary.attempt),
    });
    const steps: Activity[] = await (
      await request(`/api/explorations/${explorationId}/activities?${query}`)
    ).json();
    expect(steps.map((step) => step.text)).toEqual(['Searching', 'Reading']);
  });

  it('sends the texts of the messages asked for, in that order, and only from this chat', async () => {
    const { request, store, explorationId, question, answer } = answeredWithSteps();
    const other = seedConversation(store);
    const bodies: MessageBody[] = await (
      await request(
        `/api/explorations/${explorationId}/message-bodies?ids=${answer.id},${question.id},${other.question.id}`,
      )
    ).json();
    expect(bodies).toEqual([
      { id: answer.id, content: 'Answer one with some text to quote' },
      { id: question.id, content: 'Question one' },
    ]);
    expect((await request(`/api/explorations/${explorationId}/message-bodies?ids=`)).status).toBe(
      400,
    );
  });
});
