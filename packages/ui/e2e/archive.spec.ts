import { expect } from '@playwright/test';
import { test } from './helpers';

test('archives, restores and deletes an exploration', async ({ page }) => {
  const response = await page.request.post('/api/explorations', {
    data: { message: 'What is a monad?' },
  });
  const { explorationId } = await response.json();
  const item = page.locator('.exploration', { hasText: explorationId });

  await page.goto('/');
  await item.getByRole('button', { name: 'Archive' }).click();
  await item.getByRole('button', { name: 'Confirm' }).click();
  await expect(item).toHaveCount(0);

  await page.getByRole('link', { name: 'Archived' }).click();
  await expect(page.getByRole('heading', { name: 'Archived' })).toBeVisible();
  await expect(item).toBeVisible();

  await page.goto(`/e/${explorationId}`);
  const banner = page.locator('.exploration-header .archived');
  await expect(banner).toContainText('Archived.');
  await expect(page.getByPlaceholder('Reply to Claude')).toBeVisible();
  await page.getByRole('button', { name: 'Restore' }).click();
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(banner).toHaveCount(0);

  await page.goto('/');
  await item.getByRole('button', { name: 'Archive' }).click();
  await item.getByRole('button', { name: 'Confirm' }).click();
  await expect(item).toHaveCount(0);
  await page.goto('/archived');
  await item.getByRole('button', { name: 'Delete' }).click();
  await item.getByRole('button', { name: 'Confirm' }).click();
  await expect(item).toHaveCount(0);

  await page.reload();
  await expect(page.getByText('Nothing archived.')).toBeVisible();
  await page.goto(`/e/${explorationId}`);
  await expect(page.getByText('This chat does not exist.')).toBeVisible();
});

test('takes back an archive that is not confirmed', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  const item = page.locator('.exploration').first();
  await item.getByRole('button', { name: 'Archive' }).click();
  await expect(item.getByRole('button', { name: 'Confirm' })).toBeVisible();
  await page.clock.fastForward(3_100);
  await expect(item.getByRole('button', { name: 'Archive' })).toBeVisible();
  await expect(item.getByRole('button', { name: 'Confirm' })).toHaveCount(0);

  await item.getByRole('button', { name: 'Archive' }).click();
  await page.getByRole('heading', { name: 'Chats' }).click();
  await expect(item.getByRole('button', { name: 'Archive' })).toBeVisible();
});

test('starts a chat archived and keeps writing in it', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder(/Start a new chat/).fill('A quick throwaway question');
  const toggle = page.getByRole('button', { name: 'Archive right away' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Start' }).click();

  await expect(page).toHaveURL(/\/e\/\w+$/);
  const explorationId = page.url().split('/').at(-1)!;
  await expect(page.locator('.exploration-header .archived')).toContainText('Archived.');
  const reply = page.getByPlaceholder('Reply to Claude');
  await reply.fill('And a follow-up');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.locator('.queued-submission')).toHaveCount(2);

  await page.goto('/');
  await expect(page.locator(`.exploration a[href="/e/${explorationId}"]`)).toHaveCount(0);
  await page.goto('/archived');
  await expect(page.locator(`.exploration a[href="/e/${explorationId}"]`)).toBeVisible();
});
