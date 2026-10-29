import { expect, type Page } from '@playwright/test';
import { answeredChat, selectAnswer, test } from './helpers';

const saved = (page: Page, path: string) =>
  page.waitForResponse(
    (response) => response.url().includes(path) && response.request().method() !== 'GET',
  );

test('keeps the reply box, its fork tick and its files through a reload', async ({
  page,
  request,
}) => {
  await page.goto(`/e/${await answeredChat(request)}`);
  const reply = page.getByPlaceholder('Reply to Claude');
  await page.locator('.reply-bar input[type=file]').setInputFiles({
    name: 'notes.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Notes'),
  });
  await expect(page.locator('.reply-bar .file-drafts li')).not.toContainText('Uploading');
  await page.getByLabel('New fork').check();
  const save = saved(page, '/reply-draft');
  await reply.fill('Half a thought');
  await save;

  await page.reload();
  await expect(reply).toHaveValue('Half a thought');
  await expect(page.getByLabel('New fork')).toBeChecked();
  await expect(page.locator('.reply-bar .file-drafts li')).toHaveText(/notes\.md/);

  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.locator('.queued-submission')).toBeVisible();
  await page.reload();
  await expect(reply).toHaveValue('');
  await expect(page.locator('.reply-bar .file-drafts li')).toHaveCount(0);
});

test('reopens an unsaved new comment in its editor, and Cancel deletes it', async ({
  page,
  request,
}) => {
  await page.goto(`/e/${await answeredChat(request)}`);
  await selectAnswer(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const created = saved(page, '/comments');
  await page.getByPlaceholder('Your comment').fill('Not finished');
  await created;

  await page.reload();
  const card = page.locator('.comment-card', { has: page.locator('textarea') });
  await expect(card.locator('textarea')).toHaveValue('Not finished');
  await expect(page.locator('.reply-bar .summary')).toHaveText('1 comment being edited');
  await expect(page.getByRole('button', { name: 'Submit' })).toBeDisabled();

  await card.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.comment-card')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.comment-card')).toHaveCount(0);
});

test('keeps an edit of a saved comment apart from its saved text until Save', async ({
  page,
  request,
}) => {
  await page.goto(`/e/${await answeredChat(request)}`);
  await selectAnswer(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByPlaceholder('Your comment').fill('First version');
  await page.keyboard.press('ControlOrMeta+Enter');
  const card = page.locator('.comment-card.draft');
  await expect(card).toContainText('First version');
  await expect(page.locator('.reply-bar .summary')).toHaveText('1 comment');

  // A card fades while the cursor is near it, and the new one appears where the cursor is.
  await page.mouse.move(0, 0);
  await card.hover();
  await card.getByRole('button', { name: 'Edit' }).click();
  const edited = saved(page, '/api/comments/');
  await card.locator('textarea').fill('Second version');
  await edited;
  await page.reload();
  await expect(card.locator('textarea')).toHaveValue('Second version');
  await expect(page.locator('.reply-bar .summary')).toHaveText('1 comment being edited');

  await card.getByRole('button', { name: 'Cancel' }).click();
  await expect(card).toContainText('First version');
  await expect(page.locator('.reply-bar .summary')).toHaveText('1 comment');

  // A card fades while the cursor is near it, and the new one appears where the cursor is.
  await page.mouse.move(0, 0);
  await card.hover();
  await card.getByRole('button', { name: 'Edit' }).click();
  await card.locator('textarea').fill('Third version');
  await card.getByRole('button', { name: 'Save' }).click();
  await page.reload();
  await expect(card).toContainText('Third version');
  await expect(card.locator('textarea')).toHaveCount(0);
});
