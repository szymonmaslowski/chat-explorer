import { expect } from '@playwright/test';
import { attachFakeSession, deliverAndAnswer, detachFakeSession, test } from './helpers';

test('opens a chat on the page its settings name, and shows the fork model there', async ({
  page,
  context,
  request,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'How do I cache?' } })
  ).json();
  await attachFakeSession(request, explorationId);
  await deliverAndAnswer(request, explorationId, 'Use HTTP caching.');
  await detachFakeSession(request);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Chats' })).toHaveCount(0);
  const chat = page.locator('.exploration').filter({ hasText: explorationId });
  await chat.getByRole('link').first().click();
  await expect(page).toHaveURL(`/e/${explorationId}`);

  const settings = page.getByRole('region', { name: 'Chat settings' });
  await expect(settings).toHaveCount(0);
  await page.getByRole('button', { name: 'Chat settings' }).click();
  await expect(settings.locator('code').first()).toHaveText(explorationId);
  await settings.getByRole('button', { name: 'Copy Chat ID' }).click();
  await expect(settings.getByRole('button', { name: 'Copied' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(explorationId);
  const forkSettings = settings.getByRole('region', { name: 'This fork' });
  await expect(forkSettings).toContainText('Model:');
  const { forks } = await (await request.get(`/api/explorations/${explorationId}`)).json();
  await expect(forkSettings.locator('code')).toHaveText(forks[0].id);
  await expect(forkSettings.getByRole('button', { name: 'Copy Fork ID' })).toBeVisible();
  await expect(settings.getByLabel("Hears about the chat's other forks")).toBeChecked();
  await settings.getByLabel('Default page').selectOption('notes');

  await page.getByRole('link', { name: 'Chats' }).click();
  await expect(page).toHaveURL('/');
  await chat.getByRole('link').first().click();
  await expect(page).toHaveURL(`/e/${explorationId}/notes`);

  await page.getByRole('button', { name: 'Chat settings' }).click();
  await expect(settings.getByLabel('Default page')).toHaveValue('notes');
  await expect(settings.getByRole('region', { name: 'This fork' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Chat', exact: true }).click();
  await expect(page).toHaveURL(`/e/${explorationId}/map`);
});
