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

test.describe('with nothing chosen yet', () => {
  test.use({ graphByDefault: false });

  test('the map opens as the board, with its button first', async ({ page, request }) => {
    const { explorationId } = await chatWithTwoForks(request);
    await page.goto(`/e/${explorationId}/map`);
    await expect(page.locator('div.board')).toBeVisible();
    await expect(page.locator('.fork-box')).toHaveCount(0);
    const buttons = page.locator('.map-toolbar .segmented button');
    await expect(buttons).toHaveText(['', '']);
    await expect(buttons.first()).toHaveAccessibleName('Board view');
    await expect(buttons.first()).toHaveAttribute('aria-pressed', 'true');
    await expect(buttons.last()).toHaveAccessibleName('Graph view');
    // Choosing the graph is kept for the next visit.
    await buttons.last().click();
    await expect(page.locator('.fork-box')).toHaveCount(3);
    await page.reload();
    await expect(page.locator('.fork-box')).toHaveCount(3);
  });
});

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
    await page.getByRole('button', { name: 'New group' }).click();
    await page.getByLabel('New column name').fill(name);
    await page.getByLabel('New column name').press('Enter');
    await expect(page.locator('.column-heading h2', { hasText: name })).toBeVisible();
  }

  // Menu: move Redis to "system".
  await card(page, 'What about Redis?').getByRole('button', { name: 'Fork actions' }).click();
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
  await card(page, 'And Memcached?').getByRole('button', { name: 'Fork actions' }).click();
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

test('saves or cancels a column name with buttons, with no error after Enter', async ({
  page,
  request,
}) => {
  const { explorationId } = await chatWithTwoForks(request);
  await page.goto(`/e/${explorationId}/map`);
  await page.getByRole('button', { name: 'Board view' }).click();

  await page.getByRole('button', { name: 'New group' }).click();
  await page.getByLabel('New column name').fill('Prio');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByLabel('New column name')).toHaveCount(0);
  await expect(page.locator('.column-heading')).toHaveCount(0);

  await page.getByRole('button', { name: 'New group' }).click();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  await page.getByLabel('New column name').fill('Prio');
  await page.getByLabel('New column name').press('Enter');
  await expect(page.locator('.column-heading h2')).toHaveText(['Prio']);
  await expect(page.getByRole('alert')).toHaveCount(0);

  // Delete shows only while editing the name.
  const column = page.locator('[data-column="Prio"]');
  await expect(column.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await column.getByRole('button', { name: 'Rename column' }).click();
  await column.getByLabel('Column name').fill('Other');
  await column.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.column-heading h2')).toHaveText(['Prio']);
  await column.getByRole('button', { name: 'Rename column' }).click();
  await column.getByLabel('Column name').fill('Other');
  await column.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.column-heading h2')).toHaveText(['Other']);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('renames, reorders and deletes a column; its forks go to Ungrouped', async ({
  page,
  request,
}) => {
  const { explorationId } = await chatWithTwoForks(request);
  await page.goto(`/e/${explorationId}/map`);
  await page.getByRole('button', { name: 'Board view' }).click();
  for (const name of ['system', 'UX']) {
    await page.getByRole('button', { name: 'New group' }).click();
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

  await card(page, 'What about Redis?').getByRole('button', { name: 'Fork actions' }).click();
  await page.getByRole('menuitem', { name: 'platform', exact: true }).click();
  await expect(page.locator('.ungrouped .board-card')).toHaveCount(1);
  const column = page.locator('[data-column="platform"]');
  await column.getByRole('button', { name: 'Rename column' }).click();
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
  // Archived cards can't be moved; their menu only copies the id.
  await card(page, 'What about Redis?').getByRole('button', { name: 'Fork actions' }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Copy id']);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Show only archived forks (1)' }).click();
  await expect(page.locator('.board-card.archived')).toHaveCount(0);
  // Archiving kept its column: it is back in "research" once restored.
  await request.post(`/api/forks/${redis.id}/unarchive`);
  await expect(page.locator('[data-column="research"] .board-card')).toContainText(
    'What about Redis?',
  );
});

test('a dragged card shows in the proposed place and the other cards make room', async ({
  page,
  request,
}) => {
  const { explorationId, redis, memcached } = await chatWithTwoForks(request);
  for (const name of ['system', 'UX']) {
    await request.post(`/api/explorations/${explorationId}/board-columns`, { data: { name } });
  }
  const columns = (
    (await (await request.get(`/api/explorations/${explorationId}`)).json()) as Snapshot
  ).exploration.boardColumns;
  await request.post(`/api/forks/${redis.id}/move`, {
    data: { columnId: columns[0]!.id, afterForkId: null },
  });
  await request.post(`/api/forks/${memcached.id}/move`, {
    data: { columnId: columns[0]!.id, afterForkId: redis.id },
  });

  await page.goto(`/e/${explorationId}/map`);
  await page.getByRole('button', { name: 'Board view' }).click();
  const system = page.locator('[data-column="system"]');
  await expect(system.locator('.board-card')).toHaveCount(2);

  const box = (await card(page, 'And Memcached?').boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.down();
  // Over the empty "UX" column: the placeholder is there, the first column has closed up.
  const target = (await page.locator('[data-column="UX"] .column-body').boundingBox())!;
  await page.mouse.move(target.x + 40, target.y + 40, { steps: 8 });
  await expect(page.locator('[data-column="UX"] .drop-placeholder')).toContainText(
    'And Memcached?',
  );
  await expect(system.locator('.board-card:not(.drag-source)')).toHaveCount(1);
  // A real hand keeps moving a little; the browser accepts a drop after a dragover on the new layout.
  await page.mouse.move(target.x + 44, target.y + 46, { steps: 3 });
  await page.mouse.up();
  await expect(page.locator('[data-column="UX"] .board-card')).toContainText('And Memcached?');
  await expect(page.locator('.drop-placeholder')).toHaveCount(0);
});

test('the card menu is not cut off by the columns area', async ({ page, request }) => {
  const { explorationId, redis } = await chatWithTwoForks(request);
  await request.post(`/api/explorations/${explorationId}/board-columns`, {
    data: { name: 'system' },
  });
  const columnId = (
    (await (await request.get(`/api/explorations/${explorationId}`)).json()) as Snapshot
  ).exploration.boardColumns[0]!.id;
  await request.post(`/api/forks/${redis.id}/move`, { data: { columnId, afterForkId: null } });
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(`/e/${explorationId}/map`);
  await page.getByRole('button', { name: 'Board view' }).click();
  await card(page, 'What about Redis?').getByRole('button', { name: 'Fork actions' }).click();
  const items = page.getByRole('menuitem');
  await expect(items).toHaveCount(6);
  for (const index of [0, 5]) {
    const box = (await items.nth(index).boundingBox())!;
    const hit = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('[role="menuitem"]')?.textContent,
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );
    expect(hit?.trim()).toBe((await items.nth(index).textContent())!.trim());
  }
});

test('columns stretch to the tallest, and an empty column shows the placeholder under the pointer', async ({
  page,
  request,
}) => {
  const { explorationId, redis } = await chatWithTwoForks(request);
  for (const name of ['system', 'UX']) {
    await request.post(`/api/explorations/${explorationId}/board-columns`, { data: { name } });
  }
  const columns = (
    (await (await request.get(`/api/explorations/${explorationId}`)).json()) as Snapshot
  ).exploration.boardColumns;
  await request.post(`/api/forks/${redis.id}/move`, {
    data: { columnId: columns[0]!.id, afterForkId: null },
  });
  await page.goto(`/e/${explorationId}/map`);
  await page.getByRole('button', { name: 'Board view' }).click();

  const system = (await page.locator('[data-column="system"]').boundingBox())!;
  const ux = (await page.locator('[data-column="UX"]').boundingBox())!;
  expect(ux.height).toBeCloseTo(system.height, 0);

  // Drag the ungrouped card into the empty column, low in it: the placeholder is under the pointer,
  // inside the column.
  const source = (await card(page, 'And Memcached?').boundingBox())!;
  await page.mouse.move(source.x + 30, source.y + 30);
  await page.mouse.down();
  const pointerY = ux.y + ux.height - 90;
  await page.mouse.move(ux.x + 40, pointerY, { steps: 8 });
  await page.mouse.move(ux.x + 44, pointerY + 2, { steps: 3 });
  const placeholder = page.locator('[data-column="UX"] .drop-placeholder');
  await expect(placeholder).toContainText('And Memcached?');
  const held = (await placeholder.boundingBox())!;
  expect(held.y).toBeLessThanOrEqual(pointerY);
  expect(held.y + held.height).toBeGreaterThanOrEqual(pointerY);
  expect(held.y + held.height).toBeLessThanOrEqual(ux.y + ux.height + 1);
  await page.mouse.up();
  await expect(page.locator('[data-column="UX"] .board-card')).toContainText('And Memcached?');
});

test('the card menu archives a fork after a second press, on the board and the graph', async ({
  page,
  request,
}) => {
  const { explorationId, redis, memcached } = await chatWithTwoForks(request);
  const archivedAt = async (forkId: string) =>
    (
      (await (await request.get(`/api/explorations/${explorationId}`)).json()) as Snapshot
    ).forks.find((fork) => fork.id === forkId)!.archivedAt;
  const archiveFrom = async (box: import('@playwright/test').Locator) => {
    await box.getByRole('button', { name: 'Fork actions' }).click();
    await page.getByRole('menuitem', { name: 'Archive', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Confirm' }).click();
  };

  await page.goto(`/e/${explorationId}/map`);
  await page.getByRole('button', { name: 'Board view' }).click();
  await archiveFrom(card(page, 'What about Redis?'));
  await expect(card(page, 'What about Redis?')).toHaveCount(0);
  expect(await archivedAt(redis.id)).not.toBeNull();

  await page.getByRole('button', { name: 'Graph view' }).click();
  await archiveFrom(page.locator('.fork-box', { hasText: 'And Memcached?' }));
  await expect(page.locator('.fork-box', { hasText: 'And Memcached?' })).toHaveCount(0);
  expect(await archivedAt(memcached.id)).not.toBeNull();
});
