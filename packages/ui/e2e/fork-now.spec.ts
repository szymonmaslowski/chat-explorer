import { expect } from '@playwright/test';
import { answeredChat, attachFakeSession, detachFakeSession, selectAnswer, test } from './helpers';

test('starts a fork from a new comment at once, leaving the other drafts and the reply', async ({
  page,
  request,
}) => {
  const explorationId = await answeredChat(request);
  await page.goto(`/e/${explorationId}`);
  await selectAnswer(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByPlaceholder('Your comment').fill('Keep this inline');
  await page.keyboard.press('ControlOrMeta+Enter');
  await page.getByPlaceholder('Reply to Claude').fill('Still typing');

  await page.mouse.move(0, 0);
  await selectAnswer(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Fork now' })).toHaveCount(0);
  await page.locator('.comment-editor').getByLabel('Fork', { exact: true }).check();
  await page.getByPlaceholder('Your comment').fill('Try it this way');
  await page.getByRole('button', { name: 'Fork now' }).click();

  await expect(page.locator('.queued-submission')).toContainText('1 comment');
  await expect(page.locator('.reply-bar .summary')).toHaveText('1 comment, message');
  await expect(page.getByPlaceholder('Reply to Claude')).toHaveValue('Still typing');

  await attachFakeSession(request, explorationId);
  await request.post(`/api/internal/explorations/${explorationId}/feedback`, {
    data: { shimId: 'e2e-shim', waitMs: 1_000 },
  });
  await detachFakeSession(request);

  await expect(page.locator('.queued-submission')).toHaveCount(0);
  await expect(page.locator('.comment-card.submitted')).toContainText('Try it this way');
  await expect(page.locator('.reply-bar .summary')).toHaveText('1 comment, message');
});

test('starts a fork from a saved fork comment at once', async ({ page, request }) => {
  await page.goto(`/e/${await answeredChat(request)}`);
  await selectAnswer(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByPlaceholder('Your comment').fill('Later fork');
  await page.locator('.comment-editor').getByLabel('Fork', { exact: true }).check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const card = page.locator('.comment-card.draft');

  await page.mouse.move(0, 0);
  await card.hover();
  await card.getByRole('button', { name: 'Unfork' }).click();
  await expect(card.getByRole('button', { name: 'Fork now' })).toHaveCount(0);
  await card.getByRole('button', { name: 'Fork', exact: true }).click();
  await card.getByRole('button', { name: 'Fork now' }).click();

  await expect(page.locator('.comment-card.queued')).toContainText('· queued');
  await expect(page.locator('.queued-submission')).toContainText('1 comment');
});
