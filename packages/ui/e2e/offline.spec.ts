import { expect, type APIRequestContext } from '@playwright/test';
import type { Snapshot } from '@shared/types';
import { answeredChat, clickQuotedText, selectAnswer, test } from './helpers';

const snapshotOf = async (request: APIRequestContext, explorationId: string) =>
  (await (await request.get(`/api/explorations/${explorationId}`)).json()) as Snapshot;

test('keeps comments and a submit made offline and sends them when the connection is back', async ({
  page,
  context,
  request,
}) => {
  const explorationId = await answeredChat(request);
  await page.goto(`/e/${explorationId}`);
  await expect(page.locator('.message.assistant')).toBeVisible();

  await context.setOffline(true);
  await selectAnswer(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByPlaceholder('Your comment').fill('Written on the train');
  await page.keyboard.press('ControlOrMeta+Enter');
  const card = page.locator('.comment-card', { hasText: 'Written on the train' });
  await expect(card).toContainText('not sent yet');

  await page.getByPlaceholder('Reply to Claude').fill('And this too');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.locator('.queued-submission')).toContainText('waits for the connection');
  await expect(page.locator('.status')).toContainText(/\d waiting/);
  expect((await snapshotOf(request, explorationId)).comments).toEqual([]);

  await context.setOffline(false);
  await expect(page.locator('.queued-submission')).toContainText('sent when Claude is free', {
    timeout: 10_000,
  });
  await expect(page.locator('.status')).not.toContainText('waiting');
  await expect(card).not.toContainText('not sent yet');
  const snapshot = await snapshotOf(request, explorationId);
  expect(snapshot.comments).toMatchObject([{ body: 'Written on the train', status: 'queued' }]);
  expect(snapshot.queuedSubmissions).toMatchObject([{ globalMessage: 'And this too' }]);

  await page.locator('.queued-submission').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByPlaceholder('Reply to Claude')).toHaveValue('And this too');
  await expect
    .poll(async () => (await snapshotOf(request, explorationId)).queuedSubmissions)
    .toEqual([]);
  await page.getByPlaceholder('Reply to Claude').fill('');
});

test('sends changes made offline when the page opens again', async ({ page, context, request }) => {
  const explorationId = await answeredChat(request);
  await page.goto(`/e/${explorationId}`);
  await expect(page.locator('.message.assistant')).toBeVisible();

  await context.setOffline(true);
  await selectAnswer(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByPlaceholder('Your comment').fill('Saved before the page closed');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('.comment-card')).toContainText('not sent yet');
  await page.close();

  await context.setOffline(false);
  const reopened = await context.newPage();
  await reopened.goto(`/e/${explorationId}`);
  await clickQuotedText(reopened, 'Caching');
  await expect(reopened.locator('.comment-card')).toContainText('Saved before the page closed');
  await expect
    .poll(async () => (await snapshotOf(request, explorationId)).comments.map(({ body }) => body))
    .toEqual(['Saved before the page closed']);
});

test('keeps an edit started offline open when the connection is back', async ({
  page,
  context,
  request,
}) => {
  const explorationId = await answeredChat(request);
  await page.goto(`/e/${explorationId}`);
  await selectAnswer(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByPlaceholder('Your comment').fill('First version');
  await page.keyboard.press('ControlOrMeta+Enter');
  const card = page.locator('.comment-card.draft');
  await expect
    .poll(async () => (await snapshotOf(request, explorationId)).comments)
    .toHaveLength(1);

  await context.setOffline(true);
  await page.mouse.move(0, 0);
  await card.hover();
  await card.getByRole('button', { name: 'Edit' }).click();
  await card.locator('textarea').fill('Second version, typed offline');
  await page.waitForTimeout(1_500);

  await context.setOffline(false);
  await expect(page.locator('.status')).not.toContainText(/reconnecting|waiting/i, {
    timeout: 10_000,
  });
  await expect(card.locator('textarea')).toHaveValue('Second version, typed offline');
  await card.getByRole('button', { name: 'Cancel' }).click();
});
