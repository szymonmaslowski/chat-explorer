import { expect } from '@playwright/test';
import type { Snapshot } from '@shared/types';
import { attachFakeSession, deliverAndAnswer, detachFakeSession, test } from './helpers';

test('archives a fork out of sight and restores it', async ({ page, request }) => {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'How do I cache responses?' } })
  ).json();
  await attachFakeSession(request, explorationId);
  await deliverAndAnswer(request, explorationId, 'Use HTTP caching.');
  const forks = async () =>
    ((await (await request.get(`/api/explorations/${explorationId}`)).json()) as Snapshot).forks;
  const [main] = await forks();
  await request.post(`/api/explorations/${explorationId}/submit`, {
    data: { forkId: main!.id, globalMessage: 'What about Redis?', newFork: true },
  });
  await deliverAndAnswer(request, explorationId, 'Redis works too.');
  await detachFakeSession(request);
  const child = (await forks()).find((fork) => fork.parentForkId !== null)!;

  await page.goto(`/e/${explorationId}/f/${child.id}`);
  await page.getByRole('button', { name: 'Archive fork' }).click();
  await expect(page.locator('.fork-archive')).not.toContainText('Archived');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.locator('.fork-archive')).toContainText('Archived');
  await expect(page.getByPlaceholder('Reply to Claude')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Archive fork' })).toHaveCount(0);

  await page.getByRole('link', { name: 'Map' }).click();
  await expect(page.locator('.fork-box.archived')).toContainText('What about Redis?');
  await page.getByLabel('Show archived forks (1)').uncheck();
  await expect(page.locator('.fork-box')).toHaveCount(1);
  await page.getByRole('link', { name: 'Main' }).click();
  await expect(page.locator('.reply-fork')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Archive fork' })).toHaveCount(0);

  await page.goto(`/e/${explorationId}/f/${child.id}`);
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByPlaceholder('Reply to Claude')).toBeVisible();
  await page.goto(`/e/${explorationId}`);
  await expect(page.getByRole('link', { name: '↳ Fork: What about Redis?' })).toBeVisible();
});
