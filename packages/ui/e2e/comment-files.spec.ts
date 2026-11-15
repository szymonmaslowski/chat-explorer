import { expect, type Page } from '@playwright/test';
import { answeredChat, clickQuotedText, selectAnswer, test } from './helpers';

const textFile = (name: string) => ({
  name,
  mimeType: 'text/plain',
  buffer: Buffer.from(`Contents of ${name}`),
});

const fileLink = (page: Page, name: string) =>
  page.locator('.comment-card .files a', { hasText: name });

test('attaches files to a new comment and shows them on its card, also once sent', async ({
  page,
  request,
}) => {
  const explorationId = await answeredChat(request);
  await page.goto(`/e/${explorationId}`);
  await selectAnswer(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const editor = page.locator('.comment-editor');
  await editor.locator('input[type=file]').setInputFiles(textFile('log.txt'));
  await expect(editor.locator('.file-drafts li')).toHaveText(/log\.txt/);
  await editor.locator('textarea').fill('See the log');
  await editor.getByRole('button', { name: 'Save' }).click();

  const card = page.locator('.comment-card.draft', { hasText: 'See the log' });
  await expect(card.locator('.files a')).toHaveText('log.txt');
  await page.reload();
  await clickQuotedText(page, 'Caching');
  await expect(fileLink(page, 'log.txt')).toBeVisible();

  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.locator('.comment-card.queued .files a')).toHaveText('log.txt');
});

test('adds and removes files while editing a comment, and Cancel keeps them as they were', async ({
  page,
  request,
}) => {
  const explorationId = await answeredChat(request);
  await page.goto(`/e/${explorationId}`);
  await selectAnswer(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.locator('.comment-editor input[type=file]').setInputFiles(textFile('first.txt'));
  await expect(page.locator('.comment-editor .file-drafts li')).not.toContainText('Uploading');
  await page.locator('.comment-editor textarea').fill('Look');
  await page.locator('.comment-editor').getByRole('button', { name: 'Save' }).click();
  const card = page.locator('.comment-card.draft');
  await expect(card.locator('.files a')).toHaveText('first.txt');

  await page.mouse.move(0, 0);
  await card.hover();
  await card.getByRole('button', { name: 'Edit' }).click();
  await card.getByRole('button', { name: 'Remove first.txt' }).click();
  await card.getByRole('button', { name: 'Cancel' }).click();
  await expect(card.locator('.files a')).toHaveText('first.txt');

  await page.mouse.move(0, 0);
  await card.hover();
  await card.getByRole('button', { name: 'Edit' }).click();
  await card.getByRole('button', { name: 'Remove first.txt' }).click();
  await card.locator('input[type=file]').setInputFiles(textFile('second.txt'));
  await expect(card.locator('.file-drafts li')).toHaveText([/second\.txt/]);
  await expect(card.locator('.file-drafts li')).not.toContainText('Uploading');
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(card.locator('.files a')).toHaveText(['second.txt']);
  await page.reload();
  await clickQuotedText(page, 'Caching');
  await expect(page.locator('.comment-card .files a')).toHaveText(['second.txt']);
});

test('moves the files of the reply box to the comment made from it', async ({
  page,
  request,
}) => {
  const explorationId = await answeredChat(request);
  await page.goto(`/e/${explorationId}`);
  await page.locator('.reply-bar input[type=file]').setInputFiles(textFile('notes.md'));
  await expect(page.locator('.reply-bar .file-drafts li')).not.toContainText('Uploading');
  await page.getByPlaceholder('Reply to Claude').fill('Keep this in mind');
  await page.getByRole('button', { name: 'Save as comment' }).click();

  const card = page.locator('.comment-card.draft', { hasText: 'Keep this in mind' });
  await expect(card.locator('.files a')).toHaveText('notes.md');
  await expect(page.locator('.reply-bar .file-drafts li')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.reply-bar .file-drafts li')).toHaveCount(0);
  await expect(fileLink(page, 'notes.md')).toBeVisible();
});
