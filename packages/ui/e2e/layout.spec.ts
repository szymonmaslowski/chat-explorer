import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { answeredChat, test } from './helpers';

// A chat with its main fork and one fork from its answer.
async function chatWithFork(request: APIRequestContext) {
  const explorationId = await answeredChat(request);
  const snapshot = await (await request.get(`/api/explorations/${explorationId}`)).json();
  const answer = snapshot.messages.find(
    (message: { role: string }) => message.role === 'assistant',
  );
  const fork = await (await request.post(`/api/messages/${answer.id}/fork`, { data: {} })).json();
  return { explorationId, forkId: fork.id as string };
}

const chatsColumn = (page: Page) => page.locator('.chats-column');
const mapColumn = (page: Page) => page.locator('.map-column');
const headerLinks = (page: Page) => page.locator('.main-column .exploration-header .links');

test.describe('on a wide screen', () => {
  test.use({ viewport: { width: 1700, height: 900 } });

  test('opens the chats list, then its map beside it, then a fork beside both', async ({
    page,
    request,
  }) => {
    const { explorationId, forkId } = await chatWithFork(request);
    await page.goto('/');
    await expect(chatsColumn(page)).toHaveCount(0);

    await page.locator(`.main-column .exploration a[href="/e/${explorationId}/map"]`).click();
    await expect(page).toHaveURL(`/e/${explorationId}/map`);
    await expect(chatsColumn(page).locator('.exploration.current')).toHaveCount(1);
    await expect(headerLinks(page)).toHaveText(/^Chat\s*·\s*Notes$/);

    await page.locator(`.main-column .fork-box[data-fork-id="${forkId}"]`).click();
    await expect(page).toHaveURL(`/e/${explorationId}/f/${forkId}`);
    await expect(chatsColumn(page)).toBeVisible();
    await expect(mapColumn(page).locator('.fork-box.current .card-link')).toHaveAttribute(
      'href',
      `/e/${explorationId}/f/${forkId}`,
    );
    await expect(headerLinks(page)).toHaveText('');
    const conversation = await page.locator('.main-column .conversation').boundingBox();
    expect(conversation!.width).toBeGreaterThan(800);
    await expect(mapColumn(page).locator('.controls')).toHaveCount(0);

    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page).toHaveURL(`/e/${explorationId}/map`);
    await expect(mapColumn(page)).toHaveCount(0);
  });

  test('keeps the column widths dragged in a chat on this device', async ({ page, request }) => {
    const explorationId = await answeredChat(request);
    const otherId = await answeredChat(request);
    const width = async (column: ReturnType<typeof chatsColumn>) =>
      Math.round((await column.boundingBox())!.width);
    const drag = async (name: string, by: number) => {
      const box = (await page.getByRole('separator', { name }).boundingBox())!;
      const y = box.y + 200;
      await page.mouse.move(box.x + box.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + by, y, { steps: 5 });
      await page.mouse.up();
    };

    await page.goto(`/e/${explorationId}`);
    await expect(mapColumn(page)).toBeVisible();
    const defaults = { chats: await width(chatsColumn(page)), map: await width(mapColumn(page)) };
    await drag('Resize the chats list', 100);
    await drag('Resize the map', -150);
    const dragged = { chats: defaults.chats + 100, map: defaults.map - 250 };
    expect(await width(chatsColumn(page))).toBeCloseTo(dragged.chats, -1);
    expect(await width(mapColumn(page))).toBeCloseTo(dragged.map, -1);

    await page.reload();
    await expect(mapColumn(page)).toBeVisible();
    expect(await width(chatsColumn(page))).toBeCloseTo(dragged.chats, -1);
    expect(await width(mapColumn(page))).toBeCloseTo(dragged.map, -1);

    await page.goto(`/e/${otherId}`);
    await expect(mapColumn(page)).toBeVisible();
    expect(await width(chatsColumn(page))).toBe(defaults.chats);
    expect(await width(mapColumn(page))).toBe(defaults.map);

    await page.goto(`/e/${explorationId}`);
    await page.getByRole('separator', { name: 'Resize the map' }).dblclick();
    await expect
      .poll(async () => Math.abs((await width(mapColumn(page))) - (defaults.map - 100)))
      .toBeLessThanOrEqual(2);
    await page.getByRole('separator', { name: 'Resize the chats list' }).focus();
    await page.keyboard.press('ArrowLeft');
    expect(await width(chatsColumn(page))).toBeCloseTo(dragged.chats - 16, -1);
  });

  test('opens all three at once for a chat with only its main fork', async ({ page, request }) => {
    const explorationId = await answeredChat(request);
    await page.goto('/');
    await page.locator(`.main-column .exploration a[href="/e/${explorationId}"]`).click();
    await expect(chatsColumn(page)).toBeVisible();
    await expect(mapColumn(page).locator('.fork-box.current')).toHaveCount(1);
    await expect(page.locator('.main-column .conversation')).toContainText('Caching keeps');
  });

  test('shows the notes beside the chats list, with a link back to the map', async ({
    page,
    request,
  }) => {
    const { explorationId } = await chatWithFork(request);
    await page.goto(`/e/${explorationId}/notes`);
    await expect(chatsColumn(page)).toBeVisible();
    await expect(mapColumn(page)).toHaveCount(0);
    const notes = await page.locator('.main-column .notes-view').boundingBox();
    expect(notes!.width).toBeGreaterThan(1300);
    await headerLinks(page).getByRole('link', { name: 'Chat', exact: true }).click();
    await expect(page).toHaveURL(`/e/${explorationId}/map`);
  });
});

test.describe('on a medium screen', () => {
  test.use({ viewport: { width: 1300, height: 900 } });

  test('shows the map beside an open fork and keeps the chats in the header', async ({
    page,
    request,
  }) => {
    const { explorationId, forkId } = await chatWithFork(request);
    await page.goto(`/e/${explorationId}/f/${forkId}`);
    await expect(chatsColumn(page)).toHaveCount(0);
    await expect(mapColumn(page)).toBeVisible();
    await expect(headerLinks(page)).toHaveText('');
    await expect(headerLinks(page).getByRole('link', { name: 'Chats' })).toBeVisible();

    await page.goto(`/e/${explorationId}/map`);
    await expect(mapColumn(page)).toHaveCount(0);
    await expect(page.locator('.main-column .fork-box')).toHaveCount(2);
  });
});

test('keeps the reply box at the bottom of the screen in a short chat', async ({
  page,
  request,
}) => {
  await page.goto(`/e/${await answeredChat(request)}`);
  const submit = page.getByRole('button', { name: 'Submit' });
  await expect(submit).toBeVisible();
  const viewport = page.viewportSize()!;
  const box = (await submit.boundingBox())!;
  expect(viewport.height - (box.y + box.height)).toBeLessThan(40);
});
