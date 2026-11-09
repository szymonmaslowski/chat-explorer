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
    await expect(headerLinks(page)).toHaveText(/^Map\s*·\s*Notes$/);

    await page.locator(`.main-column .fork-box[href="/e/${explorationId}/f/${forkId}"]`).click();
    await expect(page).toHaveURL(`/e/${explorationId}/f/${forkId}`);
    await expect(chatsColumn(page)).toBeVisible();
    await expect(mapColumn(page).locator('.fork-box.current')).toHaveAttribute(
      'href',
      `/e/${explorationId}/f/${forkId}`,
    );
    await expect(headerLinks(page)).toHaveText('Notes');
    await expect(mapColumn(page).locator('.controls')).toHaveCount(0);

    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page).toHaveURL(`/e/${explorationId}/map`);
    await expect(mapColumn(page)).toHaveCount(0);
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
    await headerLinks(page).getByRole('link', { name: 'Map' }).click();
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
    await expect(headerLinks(page)).toHaveText(/^Chats\s*·\s*Notes$/);

    await page.goto(`/e/${explorationId}/map`);
    await expect(mapColumn(page)).toHaveCount(0);
    await expect(page.locator('.main-column .fork-box')).toHaveCount(2);
  });
});
