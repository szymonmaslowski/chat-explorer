import { expect } from '@playwright/test';
import { attachFakeSession, deliverAndAnswer, detachFakeSession, test } from './helpers';

const answer = [
  'Cache the **list** of users.',
  '```ts\nconst cache = new Map();\ncache.set(1, 2);\n```',
  '| Key | TTL |\n| --- | --- |\n| users | 60 |',
].join('\n\n');

test('copies a whole answer as Markdown and a picked block as its own text', async ({
  page,
  context,
  request,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'How do I cache?' } })
  ).json();
  await attachFakeSession(request, explorationId);
  await deliverAndAnswer(request, explorationId, answer);
  await detachFakeSession(request);
  await page.goto(`/e/${explorationId}`);
  const message = page.locator('.message.assistant');
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

  await message.getByRole('button', { name: 'Copy the answer' }).click();
  await expect(message.getByRole('button', { name: 'Copied' })).toBeVisible();
  await expect.poll(clipboard).toBe(answer);

  await message.locator('pre').click();
  await page.getByRole('button', { name: 'Copy this block' }).click();
  await expect.poll(clipboard).toBe('const cache = new Map();\ncache.set(1, 2);\n');

  await message.locator('td').first().click();
  await page.getByRole('button', { name: 'Copy this block' }).click();
  await expect.poll(clipboard).toBe('users');

  await message.locator('p').first().click();
  await expect(page.getByRole('button', { name: 'Comment', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Read aloud from here' })).toBeVisible();
  await page.getByRole('button', { name: 'Copy this block' }).click();
  await expect.poll(clipboard).toBe('Cache the list of users.');
});

test('a tapped table cell is picked on its own, for a comment on that cell', async ({
  page,
  request,
}) => {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'How do I cache?' } })
  ).json();
  await attachFakeSession(request, explorationId);
  await deliverAndAnswer(request, explorationId, answer);
  await detachFakeSession(request);
  await page.goto(`/e/${explorationId}`);
  const message = page.locator('.message.assistant');
  const users = message.locator('td', { hasText: 'users' });
  const ttl = message.locator('td', { hasText: '60' });

  await users.click();
  await expect(users).toHaveClass('picked');
  await expect(message.locator('table')).not.toHaveClass('picked');
  await ttl.click();
  await expect(ttl).toHaveClass('picked');
  await expect(users).not.toHaveClass('picked');

  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.locator('.comment-editor .quote')).toHaveText('60');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('offers comment, play and copy as icons big enough to tap', async ({ page, request }) => {
    const { explorationId } = await (
      await request.post('/api/explorations', { data: { message: 'How do I cache?' } })
    ).json();
    await attachFakeSession(request, explorationId);
    await deliverAndAnswer(request, explorationId, answer);
    await detachFakeSession(request);
    await page.goto(`/e/${explorationId}`);
    await page.locator('.message.assistant p').first().tap();
    for (const name of ['Comment', 'Read aloud from here', 'Copy this block']) {
      const box = (await page.getByRole('button', { name, exact: true }).boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
    if (process.env.COPY_SHOTS) {
      await page.screenshot({ path: `${process.env.COPY_SHOTS}/copy-phone.png` });
    }
  });
});
