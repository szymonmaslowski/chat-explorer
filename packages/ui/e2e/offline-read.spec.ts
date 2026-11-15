import { expect, type Page } from '@playwright/test';
import { attachFakeSession, deliverAndAnswer, detachFakeSession, test } from './helpers';

const storedTexts = (page: Page, explorationId: string) =>
  page.evaluate(
    (id) =>
      new Promise<number>((resolve) => {
        const request = indexedDB.open('chat-explorer');
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('bodies')) return resolve(0);
          const keys = db
            .transaction('bodies')
            .objectStore('bodies')
            .index('byChat')
            .getAllKeys(id);
          keys.onsuccess = () => resolve(keys.result.length);
        };
        request.onerror = () => resolve(0);
      }),
    explorationId,
  );

test('reads every chat offline from the device, also one never opened', async ({
  page,
  context,
  request,
}) => {
  const chats: string[] = [];
  for (const question of ['First offline chat', 'Second offline chat']) {
    const { explorationId } = await (
      await request.post('/api/explorations', { data: { message: question } })
    ).json();
    await attachFakeSession(request, explorationId);
    await deliverAndAnswer(request, explorationId, `The answer to the ${question.toLowerCase()}.`);
    await detachFakeSession(request);
    chats.push(explorationId);
  }

  await page.goto('/');
  for (const explorationId of chats) {
    await expect.poll(() => storedTexts(page, explorationId), { timeout: 30_000 }).toBe(2);
  }

  await context.setOffline(true);
  await page.locator('.exploration', { hasText: chats[1]! }).click();
  await expect(page.getByText('The answer to the second offline chat.')).toBeVisible();
  await page.getByRole('link', { name: 'Chats' }).click();
  await page.locator('.exploration', { hasText: chats[0]! }).click();
  await expect(page.getByText('The answer to the first offline chat.')).toBeVisible();
  await context.setOffline(false);
});
