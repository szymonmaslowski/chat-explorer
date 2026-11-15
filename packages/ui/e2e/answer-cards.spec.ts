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

  await cards.first().getByRole('link', { name: 'Show the comment' }).click();
  await expect(page).toHaveURL(new RegExp(`/f/${answer.forkId}$`));
  const revealed = page.locator('.comment-card.submitted', { hasText: 'Why these?' });
  await expect(revealed).toBeVisible();

  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await revealed.getByRole('button', { name: 'Show the answer' }).click();
  await expect(cards.first()).toBeInViewport();

  await revealed.getByRole('button', { name: 'Close' }).click();
  await expect(revealed).toHaveCount(0);
});

test('keeps general comments and the reply text as sent cards the answer leads back to', async ({
  page,
  request,
}) => {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'How do I cache responses?' } })
  ).json();
  await attachFakeSession(request, explorationId);
  await deliverAndAnswer(request, explorationId, 'Use Redis for the cache keys.');
  const answer = (
    await (await request.get(`/api/explorations/${explorationId}`)).json()
  ).messages.at(-1);
  const general = await (
    await request.post(`/api/explorations/${explorationId}/comments`, {
      data: {
        messageId: answer.id,
        viewForkId: answer.forkId,
        quote: '',
        startOffset: 0,
        endOffset: 0,
        body: 'Mind the costs too.',
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
  await request.post(`/api/internal/forks/${fork.forkId}/messages`, {
    data: {
      shimId,
      inReplyTo: question.id,
      content: `[c:${general.id}]\nThey are cheap.\n\n[m:${question.id}]\nA minute is enough.`,
    },
  });
  await detachFakeSession(request);

  await page.goto(`/e/${explorationId}`);
  const sent = page.locator('.message-comments .comment-card.submitted');
  await expect(sent).toHaveText([
    /sent\s*Mind the costs too\.$/,
    /sent\s*And how long to keep them\?$/,
  ]);
  const userMessage = page.locator('.message.user').last();
  await expect(userMessage.locator('.quoted-comment')).toHaveCount(0);
  await userMessage.getByRole('button', { name: 'Show the message' }).click();
  await expect(userMessage.locator('.quoted-comment')).toHaveText('Mind the costs too.');
  await expect(userMessage.locator('.content')).toHaveText('And how long to keep them?');
  await userMessage.getByRole('button', { name: 'Hide the message' }).click();
  await expect(userMessage.locator('.content')).toHaveCount(0);

  const cards = page.locator('.message.assistant').last().locator('.answer-card');
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await cards.last().getByRole('link', { name: 'Show the comment' }).click();
  await expect(sent.last()).toBeInViewport();
  await sent.first().getByRole('button', { name: 'Show the answer' }).click();
  await expect(cards.first()).toBeInViewport();

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await cards.first().getByRole('button', { name: 'Copy the comment' }).click();
  await expect(cards.first().locator('.answer-copy.copied')).toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('Mind the costs too.');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('opens the comment in the text from its card in the answer', async ({ page, request }) => {
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
      data: { forkId: answer.forkId },
    });
    await deliverAndAnswer(request, explorationId, `[c:${comment.id}]\nThey repeat.`);
    await detachFakeSession(request);

    await page.goto(`/e/${explorationId}`);
    const card = page.locator('.message.assistant').last().locator('.answer-card');
    await card.getByRole('link', { name: 'Show the comment' }).click();
    const opened = page.locator('.opened-comments .comment-card', { hasText: 'Why these?' });
    await expect(opened).toBeVisible();

    await opened.getByRole('button', { name: 'Show the answer' }).click();
    await expect(card).toBeInViewport();
  });
});

test('shows a remote image in an answer as a link to it, and loads nothing', async ({
  page,
  request,
}) => {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'Draw it' } })
  ).json();
  await attachFakeSession(request, explorationId);
  await deliverAndAnswer(request, explorationId, '![A chart](https://example.com/chart.png)');
  await detachFakeSession(request);
  const remote = page.waitForRequest(/example\.com/, { timeout: 1000 }).catch(() => null);
  await page.goto(`/e/${explorationId}`);
  const link = page.getByRole('link', { name: 'Image from example.com: A chart' });
  await expect(link).toHaveAttribute('href', 'https://example.com/chart.png');
  await expect(page.locator('.message.assistant img')).toHaveCount(0);
  expect(await remote).toBeNull();
});

test('aligns the columns of a table in an answer under the Content-Security-Policy', async ({
  page,
  request,
}) => {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'Compare them' } })
  ).json();
  await attachFakeSession(request, explorationId);
  await deliverAndAnswer(request, explorationId, '| Name | Cost |\n|:--|--:|\n| Redis | 12 |');
  await detachFakeSession(request);
  await page.goto(`/e/${explorationId}`);
  const cost = page.locator('.message.assistant td', { hasText: '12' });
  await expect(cost).toHaveCSS('text-align', 'right');
  await expect(page.locator('.message.assistant th', { hasText: 'Name' })).toHaveCSS(
    'text-align',
    'left',
  );
});
