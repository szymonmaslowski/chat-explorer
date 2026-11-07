import { expect } from '@playwright/test';
import { attachFakeSession, deliverAndAnswer, detachFakeSession, shimId, test } from './helpers';

test('shows the comments an answer part answers as cards above it', async ({ page, request }) => {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'How do I cache responses?' } })
  ).json();
  await attachFakeSession(request, explorationId);
  const firstAnswer = 'Use Redis for the cache keys.';
  await deliverAndAnswer(request, explorationId, firstAnswer);
  const snapshot = await (await request.get(`/api/explorations/${explorationId}`)).json();
  const answer = snapshot.messages.at(-1);
  const quote = 'cache keys';
  const startOffset = firstAnswer.indexOf(quote);
  const comment = await (
    await request.post(`/api/explorations/${explorationId}/comments`, {
      data: {
        messageId: answer.id,
        viewForkId: answer.forkId,
        quote,
        startOffset,
        endOffset: startOffset + quote.length,
        body: 'Why these?',
      },
    })
  ).json();
  await request.post(`/api/explorations/${explorationId}/submit`, {
    data: { forkId: answer.forkId, globalMessage: 'And how long to keep them?' },
  });

  const feedback = await (
    await request.post(`/api/internal/explorations/${explorationId}/feedback`, {
      data: { shimId, waitMs: 1_000 },
    })
  ).json();
  const [fork] = feedback.forks;
  const [question] = fork.userMessages;
  expect(question.text).toContain(`[c:${comment.id}]\n> cache keys\nWhy these?`);
  expect(question.text).toContain(`[m:${question.id}]\nAnd how long to keep them?`);
  await request.post(`/api/internal/forks/${fork.forkId}/messages`, {
    data: {
      shimId,
      inReplyTo: question.id,
      content: `[c:${comment.id}]\nThey repeat on every request.\n\n[m:${question.id}]\nA minute is enough.`,
    },
  });
  await detachFakeSession(request);

  await page.goto(`/e/${explorationId}`);
  const reply = page.locator('.message.assistant').last();
  const cards = reply.locator('.answer-card');
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toHaveAttribute('data-quote', 'cache keys');
  await expect(cards.first()).toHaveAttribute('data-text', 'Why these?');
  await expect(cards.last()).toHaveAttribute('data-text', 'And how long to keep them?');
  const text = await reply.locator('.content').evaluate((element) => element.textContent);
  expect(text!.replace(/\s+/g, ' ').trim()).toBe(
    'They repeat on every request. A minute is enough.',
  );

  await cards.first().click();
  await expect(page).toHaveURL(new RegExp(`/f/${answer.forkId}$`));
});
