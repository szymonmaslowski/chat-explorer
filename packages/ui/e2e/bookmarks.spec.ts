import { expect } from '@playwright/test';
import {
  answeredChat,
  attachFakeSession,
  deliverAndAnswer,
  detachFakeSession,
  selectAnswer,
  test,
} from './helpers';

test('bookmarks a selection, lists it in the header and removes it', async ({ page, request }) => {
  const explorationId = await answeredChat(request);
  await page.goto(`/e/${explorationId}`);
  await expect(page.locator('.message.assistant')).toBeVisible();
  const headerButton = page.getByRole('button', { name: /^Bookmarks/ });
  await expect(headerButton).toHaveCount(0);

  await selectAnswer(page);
  await page.getByRole('button', { name: 'Bookmark', exact: true }).click();
  await expect(headerButton).toHaveAccessibleName('Bookmarks (1)');
  await expect.poll(() => page.evaluate(() => CSS.highlights.get('bookmark')?.size ?? 0)).toBe(1);

  await headerButton.click();
  const list = page.getByRole('list', { name: 'Bookmarks' });
  await expect(list.getByRole('link')).toHaveText(['Caching']);

  await page.reload();
  await expect(headerButton).toHaveAccessibleName('Bookmarks (1)');

  await selectAnswer(page);
  await page.getByRole('button', { name: 'Remove bookmark' }).click();
  await expect(headerButton).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.message.assistant')).toBeVisible();
  await expect(headerButton).toHaveCount(0);
});

test('counts the bookmarks of each fork on the map', async ({ page, request }) => {
  const explorationId = await answeredChat(request);
  const snapshot = await (await request.get(`/api/explorations/${explorationId}`)).json();
  const answer = snapshot.messages.find(
    (message: { role: string }) => message.role === 'assistant',
  );
  for (const [startOffset, endOffset] of [
    [0, 7],
    [8, 13],
  ]) {
    await request.post(`/api/explorations/${explorationId}/bookmarks`, {
      data: {
        forkId: answer.forkId,
        messageId: answer.id,
        quote: answer.content.slice(startOffset, endOffset),
        startOffset,
        endOffset,
      },
    });
  }
  await page.goto(`/e/${explorationId}/map`);
  await expect(page.locator('.fork-box .bookmarks')).toHaveText('2 bookmarks');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('scrolls to a bookmark far up a long fork', async ({ page, request }) => {
    const { explorationId } = await (
      await request.post('/api/explorations', { data: { message: 'Start' } })
    ).json();
    await attachFakeSession(request, explorationId);
    await deliverAndAnswer(request, explorationId, 'The bookmarked words are here.');
    const long = Array.from({ length: 12 }, (_, index) => `Line ${index + 1} of the answer.`).join(
      '\n\n',
    );
    for (let turn = 0; turn < 15; turn++) {
      const snapshot = await (await request.get(`/api/explorations/${explorationId}`)).json();
      await request.post(`/api/explorations/${explorationId}/submit`, {
        data: {
          forkId: snapshot.forks[0].id,
          globalMessage: `Question ${turn}`,
          id: `turn${String(turn).padStart(6, '0')}`,
          newFork: false,
          fileIds: [],
        },
      });
      await deliverAndAnswer(request, explorationId, long);
    }
    await detachFakeSession(request);
    const snapshot = await (await request.get(`/api/explorations/${explorationId}`)).json();
    const first = snapshot.messages.find(
      (message: { role: string }) => message.role === 'assistant',
    );
    await request.post(`/api/explorations/${explorationId}/bookmarks`, {
      data: {
        forkId: first.forkId,
        messageId: first.id,
        quote: 'bookmarked',
        startOffset: 4,
        endOffset: 14,
      },
    });

    await page.goto(`/e/${explorationId}`);
    await expect(page.getByText('The bookmarked words are here.')).toBeAttached();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.getByRole('button', { name: /^Bookmarks/ }).click();
    await page.getByRole('list', { name: 'Bookmarks' }).getByRole('link').click();
    await expect(page.getByText('The bookmarked words are here.')).toBeInViewport();
  });
});
