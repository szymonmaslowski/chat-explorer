import { expect, test } from '@playwright/test';
import { openSeededExploration } from './helpers';

test('dictates a reply into the text box', async ({ page }) => {
  await openSeededExploration(page);
  const reply = page.getByPlaceholder('Reply to Claude');
  await reply.fill('First thought.');

  await page.locator('.reply-bar').getByRole('button', { name: 'Dictate' }).click();
  const stop = page.getByRole('button', { name: 'Stop dictation' });
  await expect(stop).toBeVisible();
  await expect(page.locator('.reply-bar .clock')).toHaveText('0:01');
  await stop.click();

  await expect(reply).toHaveValue('First thought. Dictated by the fake whisper.');
  await expect(page.locator('.reply-bar').getByRole('button', { name: 'Dictate' })).toBeVisible();
});

test('throws a recording away on cancel', async ({ page }) => {
  await page.goto('/');
  const box = page.getByPlaceholder('Start a new exploration');
  await page.locator('.new-exploration').getByRole('button', { name: 'Dictate' }).click();
  await page.locator('.new-exploration').getByRole('button', { name: 'Cancel dictation' }).click();
  await expect(
    page.locator('.new-exploration').getByRole('button', { name: 'Dictate' }),
  ).toBeVisible();
  await expect(box).toHaveValue('');
});
