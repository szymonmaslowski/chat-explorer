import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { attachFakeSession, deliverAndAnswer, detachFakeSession, test } from './helpers';

// A fork of 2 × rounds messages, each answer a few paragraphs long.
async function longChat(request: APIRequestContext, rounds: number) {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'Question 1' } })
  ).json();
  await attachFakeSession(request, explorationId);
  const answer = (round: number) =>
    [`Answer ${round}.`, 'More about it.', 'And the end of it.'].join('\n\n');
  await deliverAndAnswer(request, explorationId, answer(1));
  const { forks } = await (await request.get(`/api/explorations/${explorationId}`)).json();
  for (let round = 2; round <= rounds; round++) {
    await request.post(`/api/explorations/${explorationId}/submit`, {
      data: { forkId: forks[0].id, globalMessage: `Question ${round}` },
    });
    await deliverAndAnswer(request, explorationId, answer(round));
  }
  await detachFakeSession(request);
  const snapshot = await (await request.get(`/api/explorations/${explorationId}`)).json();
  const messages: { id: string; role: string; content: string }[] = snapshot.messages;
  // Read, so the fork opens at its end and not at its first unread answer.
  await request.post(`/api/explorations/${explorationId}/read`, {
    data: {
      messageIds: messages
        .filter((message) => message.role === 'assistant')
        .map((message) => message.id),
    },
  });
  return { explorationId, messages };
}

const shownCount = (page: Page) => page.locator('.conversation .message').count();

test('opens a long fork on its newest messages and loads older ones above, keeping the place', async ({
  page,
  request,
}) => {
  const { explorationId } = await longChat(request, 60);
  await page.goto(`/e/${explorationId}`);
  await expect(page.getByText('Answer 60.')).toBeVisible();
  expect(await shownCount(page)).toBeLessThanOrEqual(80);
  await expect(page.getByText('Answer 1.', { exact: true })).toHaveCount(0);

  // Older batches come in ahead of the reader, while the message on screen stays where it is. The
  // reader's own scrolling ends the hold on the end of the fork the page opened at.
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(400);
  const reading = page.locator('.message', { hasText: 'Answer 45.' });
  await reading.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  const before = (await reading.boundingBox())!.y;
  await expect.poll(() => shownCount(page)).toBeGreaterThan(40);
  await page.waitForTimeout(300);
  expect(Math.abs((await reading.boundingBox())!.y - before)).toBeLessThan(2);

  // At the top, batch after batch comes in until the fork's first message.
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.scrollTo(0, 0));
        return shownCount(page);
      },
      { timeout: 15_000 },
    )
    .toBe(120);
  await expect(page.locator('.older')).toHaveCount(0);
});

test('shows everything down from an old message a link points at', async ({ page, request }) => {
  const { explorationId, messages } = await longChat(request, 40);
  const oldAnswer = messages.find((message) => message.content.startsWith('Answer 3.'))!;
  await page.goto(`/e/${explorationId}#m-${oldAnswer.id}`);
  await expect(page.locator(`#m-${oldAnswer.id}`)).toBeInViewport();
  await expect(page.getByText('Answer 40.')).toBeAttached();
});
