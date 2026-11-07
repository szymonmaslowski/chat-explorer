import { expect } from '@playwright/test';
import { answeredChat, attachFakeSession, detachFakeSession, test } from './helpers';

test('asks to wake Claude in its terminal when it stopped listening with messages queued', async ({
  page,
  request,
}) => {
  const explorationId = await answeredChat(request);
  await attachFakeSession(request, explorationId);
  await page.goto(`/e/${explorationId}`);
  const status = page.locator('.status .label');
  await expect(status).toHaveText('paused');

  await page.getByPlaceholder('Reply to Claude').fill('Are you there?');
  await page.getByRole('button', { name: 'Submit' }).click();

  await expect(status).toContainText('tell Claude in its terminal to continue');
  await detachFakeSession(request);
});
