import { expect } from '@playwright/test';
import {
  clearReply,
  openSeededExploration,
  seededDraftQuote,
  tapQuotedText,
  test,
} from './helpers';

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
  await clearReply(page);
});

test('continues a dictation from where the last one ended', async ({ page }) => {
  await openSeededExploration(page);
  const reply = page.getByPlaceholder('Reply to Claude');
  await reply.fill('Start. End.');
  await reply.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(6, 6));

  for (let part = 0; part < 2; part++) {
    await page.locator('.reply-bar').getByRole('button', { name: 'Dictate' }).click();
    await expect(page.locator('.reply-bar .clock')).toHaveText('0:01');
    await page.getByRole('button', { name: 'Stop dictation' }).click();
    await expect(page.locator('.reply-bar').getByRole('button', { name: 'Dictate' })).toBeVisible();
  }

  await expect(reply).toHaveValue(
    'Start. Dictated by the fake whisper. Dictated by the fake whisper. End.',
  );
  await clearReply(page);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('dictates into a comment being edited', async ({ page }) => {
    await openSeededExploration(page);
    await tapQuotedText(page, seededDraftQuote);
    const card = page.locator('.opened-comments .comment-card.draft');
    await card.getByRole('button', { name: 'Edit' }).click();
    const editor = card.locator('textarea');
    const before = await editor.inputValue();

    await card.getByRole('button', { name: 'Dictate' }).click();
    await expect(card.locator('.clock')).toHaveText('0:01');
    await card.getByRole('button', { name: 'Stop dictation' }).click();

    await expect(editor).toHaveValue(`${before} Dictated by the fake whisper.`);
    await card.getByRole('button', { name: 'Cancel', exact: true }).click();
  });
});

test('throws a recording away on cancel', async ({ page }) => {
  await page.goto('/');
  const box = page.getByPlaceholder('Start a new chat');
  await page.locator('.new-exploration').getByRole('button', { name: 'Dictate' }).click();
  await page.locator('.new-exploration').getByRole('button', { name: 'Cancel dictation' }).click();
  await expect(
    page.locator('.new-exploration').getByRole('button', { name: 'Dictate' }),
  ).toBeVisible();
  await expect(box).toHaveValue('');
});
