import { expect } from '@playwright/test';
import type { Snapshot } from '@shared/types';
import { attachFakeSession, deliverAndAnswer, detachFakeSession, test } from './helpers';

test('moves a message and the ones after it into a new fork', async ({ page, request }) => {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'How do I cache responses?' } })
  ).json();
  await attachFakeSession(request, explorationId);
  await deliverAndAnswer(request, explorationId, 'Use HTTP caching.');
  const snapshot = async () =>
    (await (await request.get(`/api/explorations/${explorationId}`)).json()) as Snapshot;
  const [main] = (await snapshot()).forks;
  await request.post(`/api/explorations/${explorationId}/submit`, {
    data: { forkId: main!.id, globalMessage: 'And the coding forks?' },
  });
  await deliverAndAnswer(request, explorationId, 'They run in Docker.');
  await detachFakeSession(request);
  await page.goto(`/e/${explorationId}`);

  const messages = page.locator('.message');
  const first = messages.filter({ hasText: 'How do I cache responses?' });
  const second = messages.filter({ hasText: 'And the coding forks?' });
  const split = { name: 'Move from here into a new fork' };
  await expect(first.getByRole('button', split)).toHaveCount(0);
  await expect(
    messages.filter({ hasText: 'Use HTTP caching.' }).getByRole('button', split),
  ).toHaveCount(0);

  await second.getByRole('button', split).click();
  await second.getByRole('button', { name: 'Confirm' }).click();

  await expect(page).toHaveURL(/\/f\/\w+#m-/);
  await expect(page.locator('.message.shared')).toHaveCount(2);
  await expect(page.locator('.message:not(.shared)')).toHaveCount(2);
  const forks = (await snapshot()).forks;
  expect(forks).toHaveLength(2);
  expect(forks[1]).toMatchObject({ parentForkId: main!.id, summary: 'And the coding forks?' });

  await page.goto(`/e/${explorationId}`);
  await expect(messages).toHaveCount(2);
  await expect(page.getByText('They run in Docker.')).toHaveCount(0);
});
