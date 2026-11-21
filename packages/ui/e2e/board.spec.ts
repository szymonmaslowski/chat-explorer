import { expect } from '@playwright/test';
import type { Snapshot } from '@shared/types';
import { attachFakeSession, deliverAndAnswer, detachFakeSession, test } from './helpers';

async function chatWithTwoForks(request: Parameters<typeof attachFakeSession>[0]) {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'How do I cache responses?' } })
  ).json();
  await attachFakeSession(request, explorationId);
  await deliverAndAnswer(request, explorationId, 'Use HTTP caching.');
  const forks = async () =>
    ((await (await request.get(`/api/explorations/${explorationId}`)).json()) as Snapshot).forks;
  const [main] = await forks();
  for (const message of ['What about Redis?', 'And Memcached?']) {
    await request.post(`/api/explorations/${explorationId}/submit`, {
      data: { forkId: main!.id, globalMessage: message, newFork: true },
    });
    await deliverAndAnswer(request, explorationId, 'Answered.');
  }
  await detachFakeSession(request);
  const all = await forks();
  const byName = (summary: string) => all.find((fork) => fork.summary === summary)!;
  return { explorationId, redis: byName('What about Redis?'), memcached: byName('And Memcached?') };
}

const card = (page: import('@playwright/test').Page, text: string) =>
  page.locator('.board-card', { hasText: text });

test('files forks into columns by menu and by drag, and keeps the board after a reload', async ({
  page,
  request,
}) => {
  const { explorationId, redis, memcached } = await chatWithTwoForks(request);

  await page.goto(`/e/${explorationId}/map`);
  await page.getByRole('button', { name: 'Board view' }).click();
  await expect(page.locator('.main-row .board-card')).toHaveCount(1);
  // Forks with no column wait in the Ungrouped section, under the columns.
  await expect(page.locator('.ungrouped .board-card')).toHaveCount(2);

  for (const name of ['system', 'UX']) {
    await page.getByRole('button', { name: '+ New group' }).click();
    await page.getByLabel('New column name').fill(name);
    await page.getByLabel('New column name').press('Enter');
    await expect(page.locator('.column-heading h2', { hasText: name })).toBeVisible();
  }

  // Menu: move Redis to "system".
  await card(page, 'What about Redis?').getByRole('button', { name: 'Move this fork' }).click();
  await page.getByRole('menuitem', { name: 'system', exact: true }).click();
  await expect(page.locator('[data-column="system"] .board-card')).toContainText(
    'What about Redis?',
  );
  await expect(page.locator('.ungrouped .board-card')).toHaveCount(1);

  // Drag: Memcached onto the "UX" column.
  await card(page, 'And Memcached?').dragTo(page.locator('[data-column="UX"] .column-body'));
  await expect(page.locator('[data-column="UX"] .board-card')).toContainText('And Memcached?');
  await expect(page.locator('.ungrouped')).toHaveCount(0);

  // Drag within a column, to change priority: Memcached above Redis, both in "system".
  await card(page, 'And Memcached?').getByRole('button', { name: 'Move this fork' }).click();
  await page.getByRole('menuitem', { name: 'system', exact: true }).click();
  await expect(page.locator('[data-column="system"] .board-card').first()).toContainText(
    'What about Redis?',
  );
  await card(page, 'And Memcached?').dragTo(card(page, 'What about Redis?'), {
    targetPosition: { x: 20, y: 5 },
  });
  await expect(page.locator('[data-column="system"] .board-card').first()).toContainText(
    'And Memcached?',
  );

  // It is all kept: the columns and the places, and the view the device chose.
  await page.reload();
  await expect(page.locator('[data-column="system"] .board-card')).toHaveText([
    /And Memcached\?/,
    /What about Redis\?/,
  ]);
  const stored = (
    (await (await request.get(`/api/explorations/${explorationId}`)).json()) as Snapshot
  ).forks;
  expect(stored.find((fork) => fork.id === memcached.id)!.boardPosition).toBeLessThan(
    stored.find((fork) => fork.id === redis.id)!.boardPosition,
  );
});

test('renames, reorders and deletes a column; its forks go to Ungrouped', async ({
  page,
  request,
}) => {
  const { explorationId } = await chatWithTwoForks(request);
  await page.goto(`/e/${explorationId}/map`);
  await page.getByRole('button', { name: 'Board view' }).click();
  for (const name of ['system', 'UX']) {
    await page.getByRole('button', { name: '+ New group' }).click();
    await page.getByLabel('New column name').fill(name);
    await page.getByLabel('New column name').press('Enter');
    await expect(page.locator('.column-heading h2', { hasText: name })).toBeVisible();
  }

  await page
    .locator('[data-column="system"]')
    .getByRole('button', { name: 'Rename column' })
    .click();
  await page.getByLabel('Column name').fill('platform');
  await page.getByLabel('Column name').press('Enter');
  await expect(page.locator('.column-heading h2')).toHaveText(['platform', 'UX']);

  await page
    .locator('[data-column="UX"]')
    .getByRole('button', { name: 'Move column left' })
    .click();
  await expect(page.locator('.column-heading h2')).toHaveText(['UX', 'platform']);

  await card(page, 'What about Redis?').getByRole('button', { name: 'Move this fork' }).click();
  await page.getByRole('menuitem', { name: 'platform', exact: true }).click();
  await expect(page.locator('.ungrouped .board-card')).toHaveCount(1);
  const column = page.locator('[data-column="platform"]');
  await column.getByRole('button', { name: 'Delete' }).click();
  await column.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.locator('.column-heading h2')).toHaveText(['UX']);
  await expect(page.locator('.ungrouped .board-card')).toHaveCount(2);
});

test('shows archived forks only, in their own columns, in the board and the graph', async ({
  page,
  request,
}) => {
  const { explorationId, redis } = await chatWithTwoForks(request);
  await request.post(`/api/forks/${redis.id}/move`, {
    data: { columnId: null, afterForkId: null },
  });
  await request.post(`/api/explorations/${explorationId}/board-columns`, {
    data: { name: 'research' },
  });
  const columnId = (
    (await (await request.get(`/api/explorations/${explorationId}`)).json()) as Snapshot
  ).exploration.boardColumns[0]!.id;
  await request.post(`/api/forks/${redis.id}/move`, { data: { columnId, afterForkId: null } });
  await request.post(`/api/forks/${redis.id}/archive`);

  await page.goto(`/e/${explorationId}/map`);
  // Graph: the archived fork and the fork above it.
  await expect(page.locator('.fork-box')).toHaveCount(2);
  await page.getByRole('button', { name: 'Show only archived forks (1)' }).click();
  await expect(page.locator('.fork-box')).toHaveCount(2);
  await expect(page.locator('.fork-box.archived')).toHaveCount(1);

  await page.getByRole('button', { name: 'Board view' }).click();
  await expect(page.locator('[data-column="research"] .board-card.archived')).toContainText(
    'What about Redis?',
  );
  await expect(page.locator('.ungrouped')).toHaveCount(0);
  // Archived cards can't be moved.
  await expect(page.getByRole('button', { name: 'Move this fork' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Show only archived forks (1)' }).click();
  await expect(page.locator('.board-card.archived')).toHaveCount(0);
  // Archiving kept its column: it is back in "research" once restored.
  await request.post(`/api/forks/${redis.id}/unarchive`);
  await expect(page.locator('[data-column="research"] .board-card')).toContainText(
    'What about Redis?',
  );
});
