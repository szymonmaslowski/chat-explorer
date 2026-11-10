import { expect } from '@playwright/test';
import type { Snapshot } from '@shared/types';
import { attachFakeSession, deliverAndAnswer, detachFakeSession, test } from './helpers';

test('collapses a fork and the forks below it out of the map, and brings them back', async ({
  page,
  request,
}) => {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'How do I cache responses?' } })
  ).json();
  await attachFakeSession(request, explorationId);
  await deliverAndAnswer(request, explorationId, 'Use HTTP caching.');
  const forks = async () =>
    ((await (await request.get(`/api/explorations/${explorationId}`)).json()) as Snapshot).forks;
  const forkFrom = async (forkId: string, message: string) => {
    await request.post(`/api/explorations/${explorationId}/submit`, {
      data: { forkId, globalMessage: message, newFork: true },
    });
    await deliverAndAnswer(request, explorationId, 'Answered.');
    return (await forks()).find((fork) => fork.summary === message)!;
  };
  const [main] = await forks();
  const child = await forkFrom(main!.id, 'What about Redis?');
  await forkFrom(child.id, 'And Memcached?');
  await detachFakeSession(request);

  await page.goto(`/e/${explorationId}/map`);
  await expect(page.locator('.fork-box')).toHaveCount(3);
  await page.getByRole('button', { name: 'Collapse What about Redis?' }).click();
  await expect(page.locator('.fork-box')).toHaveCount(1);
  const chip = page.getByRole('button', { name: 'Show 2 collapsed forks' });
  await expect(chip).toHaveText('+2');

  await page.reload();
  await expect(page.locator('.fork-box')).toHaveCount(1);
  await chip.click();
  await expect(page.locator('.fork-box')).toHaveCount(3);
  await expect(chip).toHaveCount(0);
});
