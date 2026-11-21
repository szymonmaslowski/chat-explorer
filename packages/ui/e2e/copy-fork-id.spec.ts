import { expect } from '@playwright/test';
import type { Snapshot } from '@shared/types';
import {
  answeredChat,
  attachFakeSession,
  deliverAndAnswer,
  detachFakeSession,
  test,
} from './helpers';

test('copies a fork id from under its name and from its card on the board', async ({
  page,
  context,
  request,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  const explorationId = await answeredChat(request);
  const [main] = (
    (await (await request.get(`/api/explorations/${explorationId}`)).json()) as Snapshot
  ).forks;
  await attachFakeSession(request, explorationId);
  await request.post(`/api/explorations/${explorationId}/submit`, {
    data: { forkId: main!.id, globalMessage: 'What about Redis?', newFork: true },
  });
  await deliverAndAnswer(request, explorationId, 'Answered.');
  await detachFakeSession(request);
  const { forks } = (await (
    await request.get(`/api/explorations/${explorationId}`)
  ).json()) as Snapshot;
  const redis = forks.find((fork) => fork.summary === 'What about Redis?')!;

  // Under the fork's name in its header.
  await page.goto(`/e/${explorationId}/f/${redis.id}`);
  const idRow = page.locator('.exploration-header .fork-id');
  await expect(idRow.locator('code')).toHaveText(redis.id);
  await idRow.getByRole('button', { name: 'Copy Fork ID' }).click();
  await expect(idRow.getByRole('button', { name: 'Copied' })).toBeVisible();
  await expect.poll(clipboard).toBe(redis.id);

  // From the card's menu on the board, the main fork's card included.
  await page.goto(`/e/${explorationId}/map`);
  await page.getByRole('button', { name: 'Board view' }).click();
  const mainCard = page.locator('.main-row .board-card');
  await mainCard.getByRole('button', { name: 'Fork actions' }).click();
  await page.getByRole('menuitem', { name: 'Copy id' }).click();
  await expect.poll(clipboard).toBe(main!.id);
  await expect(page.getByRole('menu')).toHaveCount(0);

  const card = page.locator('.board-card', { hasText: 'What about Redis?' });
  await card.getByRole('button', { name: 'Fork actions' }).click();
  await page.getByRole('menuitem', { name: 'Copy id' }).click();
  await expect.poll(clipboard).toBe(redis.id);
});
