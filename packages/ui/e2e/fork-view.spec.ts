import { expect, test, type Page } from '@playwright/test';

async function openSeededExploration(page: Page) {
  const [exploration] = await (await page.request.get('/api/explorations')).json();
  await page.goto(`/e/${exploration.id}`);
  await expect(page.locator('.message').first()).toBeVisible();
  return exploration.id as string;
}

async function selectText(page: Page, paragraph: string, length: number) {
  const box = (await page.locator('.content p', { hasText: paragraph }).first().boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + length, box.y + 10, { steps: 5 });
  await page.mouse.up();
}

const summary = (page: Page) => page.locator('.reply-bar .summary');

test('creates, reveals and deletes a draft comment', async ({ page }) => {
  await openSeededExploration(page);
  await expect(summary(page)).toHaveText('1 comment');

  await selectText(page, 'There are three common ways', 160);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByPlaceholder('Your comment').fill('Which one is cheapest?');
  await page.keyboard.press('ControlOrMeta+Enter');

  const card = page.locator('.comment-card.draft', { hasText: 'Which one is cheapest?' });
  await expect(card).toBeVisible();
  await expect(summary(page)).toHaveText('2 comments');

  await card.hover();
  await expect(card).toHaveCSS('opacity', '0.2');
  await expect(card).toHaveCSS('opacity', '1', { timeout: 3_000 });
  await card.getByRole('button', { name: 'Delete' }).click();
  await expect(card).toHaveCount(0);
  await expect(summary(page)).toHaveText('1 comment');
});

test('queues a submit, scrolls to it and cancels it back into drafts', async ({ page }) => {
  await openSeededExploration(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByPlaceholder('Reply to Claude').fill('Can you compare costs?');
  await page.getByRole('button', { name: 'Submit' }).click();

  const queued = page.locator('.queued-submission');
  await expect(queued).toContainText('Can you compare costs?');
  await expect(queued).toBeInViewport();
  await expect(page.locator('.comment-card.queued')).toHaveCount(1);

  await queued.getByRole('button', { name: 'Cancel' }).click();
  await expect(queued).toHaveCount(0);
  await expect(page.getByPlaceholder('Reply to Claude')).toHaveValue('Can you compare costs?');
  await expect(summary(page)).toHaveText('1 comment, message');
  await page.getByPlaceholder('Reply to Claude').fill('');
});

test('navigates through the map and back and forward with [ and ]', async ({ page }) => {
  const explorationId = await openSeededExploration(page);
  await page.getByRole('link', { name: 'Map' }).click();
  await expect(page).toHaveURL(new RegExp(`/e/${explorationId}/map`));
  await page.locator('.fork-box', { hasText: 'Purging cached responses' }).click();
  await expect(page.locator('.fork-title')).toHaveText('Purging cached responses on a CDN');
  await expect(page.locator('.fork-point')).toContainText('Forked from');

  await page.keyboard.press('[');
  await expect(page).toHaveURL(/\/map/);
  await page.keyboard.press(']');
  await expect(page.locator('.fork-title')).toHaveText('Purging cached responses on a CDN');
});

test('opens the fork created by a submitted fork comment', async ({ page }) => {
  await openSeededExploration(page);
  const card = page.locator('.comment-card.submitted.fork');
  await card.hover();
  await expect(card).toHaveCSS('opacity', '1', { timeout: 3_000 });
  await card.click();
  await expect(page.locator('.fork-title')).toHaveText('Purging cached responses on a CDN');
});
