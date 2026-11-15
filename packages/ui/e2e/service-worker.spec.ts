import { expect } from '@playwright/test';
import { attachFakeSession, deliverAndAnswer, detachFakeSession, test } from './helpers';

test.use({ serviceWorkers: 'allow' });

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('opens with no network, with the chats and their images kept on the device', async ({
  page,
  context,
  request,
}) => {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'Show me the chart' } })
  ).json();
  const upload = await request.post('/api/files', {
    multipart: { file: { name: 'chart.png', mimeType: 'image/png', buffer: png } },
  });
  const image = await upload.json();
  await attachFakeSession(request, explorationId);
  await deliverAndAnswer(request, explorationId, `Here it is:\n\n![Chart](/api/files/${image.id})`);
  await detachFakeSession(request);

  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.locator('.exploration', { hasText: explorationId }).click();
  await expect(page.locator('.message.assistant img')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async (fileId) => !!(await caches.match(`/api/files/${fileId}`)), image.id),
    )
    .toBe(true);
  await page.waitForTimeout(1_500);

  await context.setOffline(true);
  await page.goto('/');
  await expect(page.locator('.exploration', { hasText: explorationId })).toBeVisible();
  await page.locator('.exploration', { hasText: explorationId }).click();
  await expect(page.getByText('Here it is:')).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator('.message.assistant img')
        .evaluate((element: HTMLImageElement) => element.naturalWidth),
    )
    .toBe(1);
  await context.setOffline(false);
});
