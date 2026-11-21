import { expect } from '@playwright/test';
import {
  answeredChat,
  attachFakeSession,
  deliverAndAnswer,
  detachFakeSession,
  test,
} from './helpers';

test('ArrowUp brings back the messages sent in the fork, ArrowDown returns to the draft', async ({
  page,
  request,
}) => {
  const explorationId = await answeredChat(request);
  await page.goto(`/e/${explorationId}`);
  const box = page.getByPlaceholder('Reply to Claude');

  await attachFakeSession(request, explorationId);
  for (const message of ['First question', 'Second question']) {
    await box.fill(message);
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(box).toHaveValue('');
    await expect(page.locator('.message', { hasText: message })).toBeVisible();
    await deliverAndAnswer(request, explorationId, `About the ${message.toLowerCase()}.`);
  }
  await detachFakeSession(request);
  await expect(page.getByText('About the second question.')).toBeVisible();

  await box.fill('Half typed');
  await box.press('ArrowUp');
  await expect(box).toHaveValue('Second question');
  await box.press('ArrowUp');
  await expect(box).toHaveValue('First question');
  await box.press('ArrowDown');
  await expect(box).toHaveValue('Second question');
  await box.press('ArrowDown');
  await expect(box).toHaveValue('Half typed');

  // On a line below the first, ArrowUp moves the caret as usual.
  await box.fill('Line one\nLine two');
  await box.press('ArrowUp');
  await expect(box).toHaveValue('Line one\nLine two');
});

test('ArrowUp also brings back a message still queued for Claude', async ({ page, request }) => {
  const explorationId = await answeredChat(request);
  await page.goto(`/e/${explorationId}`);
  const box = page.getByPlaceholder('Reply to Claude');
  // No session is attached, so the message waits in the queue.
  await box.fill('Still waiting');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(box).toHaveValue('');
  await expect(page.locator('.message', { hasText: 'Still waiting' })).toBeVisible();

  await box.press('ArrowUp');
  await expect(box).toHaveValue('Still waiting');
});
