import { expect, type Page } from '@playwright/test';
import { clearReply, openSeededExploration, test } from './helpers';

const paragraphBox = async (page: Page, paragraph: string) => {
  const locator = page.locator('.content p', { hasText: paragraph }).first();
  await locator.scrollIntoViewIfNeeded();
  return (await locator.boundingBox())!;
};

async function selectText(page: Page, paragraph: string, length: number) {
  const box = await paragraphBox(page, paragraph);
  await page.mouse.move(box.x + 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + length, box.y + 10, { steps: 5 });
  await page.mouse.up();
}

const commentButton = (page: Page) => page.getByRole('button', { name: 'Comment', exact: true });

const summary = (page: Page) => page.locator('.reply-bar .summary');

test('creates, reveals and deletes a draft comment', async ({ page }) => {
  await openSeededExploration(page);
  await expect(summary(page)).toHaveText('1 comment');

  await selectText(page, 'There are three common ways', 160);
  await commentButton(page).click();
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

test('offers a comment for a triple-clicked paragraph', async ({ page }) => {
  await openSeededExploration(page);
  const box = await paragraphBox(page, "For most apps I'd start");
  await page.mouse.click(box.x + 20, box.y + 10, { clickCount: 3 });
  await commentButton(page).click();
  await expect(page.locator('.comment-editor')).toContainText(
    "For most apps I'd start with HTTP caching for public data and a shared cache for per-user data.",
  );
  await page.keyboard.press('Escape');
});

test('offers a comment when the drag ends outside the conversation', async ({ page }) => {
  await openSeededExploration(page);
  const box = await paragraphBox(page, 'There are three common ways');
  await page.mouse.move(box.x + 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 120, box.y + 10, { steps: 5 });
  await page.mouse.up();
  await expect(commentButton(page)).toBeVisible();
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
  await clearReply(page);
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

test('opens an exploration from the list on its map', async ({ page }) => {
  const explorationId = await openSeededExploration(page);
  await page.goto('/');
  await page.locator('.exploration', { hasText: 'Caching API responses' }).click();
  await expect(page).toHaveURL(new RegExp(`/e/${explorationId}/map$`));
  await expect(page.locator('.fork-box')).toHaveCount(2);
});

test('opens a fork from the map at its end', async ({ page }) => {
  const explorationId = await openSeededExploration(page);
  await page.goto(`/e/${explorationId}/map`);
  await page.locator('.fork-box', { hasText: 'Caching options and invalidation' }).click();
  await expect(page.locator('.fork-title')).toHaveText('Caching options and invalidation');
  await expect(page.getByPlaceholder('Reply to Claude')).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
});

test('opens the fork created by a submitted fork comment', async ({ page }) => {
  await openSeededExploration(page);
  const card = page.locator('.comment-card.submitted.fork');
  await card.hover();
  await expect(card).toHaveCSS('opacity', '1', { timeout: 3_000 });
  await card.click();
  await expect(page.locator('.fork-title')).toHaveText('Purging cached responses on a CDN');
});

test('shows the date and time of every message', async ({ page }) => {
  await openSeededExploration(page);
  const time = page.locator('.message .role time').first();
  await expect(time).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
  await expect(time).toHaveText(/\d{4}.*\d{1,2}:\d{2}/);
  await expect(page.locator('.message .role time')).toHaveCount(
    await page.locator('.message').count(),
  );
  if (process.env.TIME_SHOTS) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${process.env.TIME_SHOTS}/message-times-phone.png` });
  }
});
