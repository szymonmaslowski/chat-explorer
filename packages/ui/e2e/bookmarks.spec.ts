import { expect } from '@playwright/test';
import { answeredChat, selectAnswer, test } from './helpers';

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
