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
  const coding = settings.getByRole('checkbox', { name: /Coding:/ });
  await expect(coding).not.toBeChecked();
  await coding.check();
  await expect(forkSettings).toContainText('Takes effect from your next message');
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/explorations/${explorationId}`)).json()).forks[0].coding,
    )
    .toBe(true);
  const network = async () =>
    (await (await request.get(`/api/explorations/${explorationId}`)).json()).forks[0].network;
  await forkSettings.getByLabel('Rust: crates.io and rustup').check();
  await expect.poll(network).toMatchObject({ registries: ['rust'] });
  await forkSettings.getByLabel('npm', { exact: true }).check();
  await expect.poll(network).toMatchObject({ registries: ['rust', 'npm'] });
  await forkSettings.getByLabel('Rust: crates.io and rustup').uncheck();
  await expect.poll(network).toMatchObject({ registries: ['npm'] });
  const hosts = forkSettings.getByLabel(/Other allowed hosts/);
  await hosts.fill('GitHub.com:443\n192.168.1.1:22');
  await expect(forkSettings.getByRole('alert')).toHaveText('Not a host and port: 192.168.1.1:22');
  await expect(forkSettings.getByRole('button', { name: 'Save hosts' })).toBeDisabled();
  await hosts.fill('GitHub.com:443\n\ngit.example.com:2222');
  await forkSettings.getByRole('button', { name: 'Save hosts' }).click();
  await expect.poll(network).toEqual({
    hosts: ['github.com:443', 'git.example.com:2222'],
    registries: ['npm'],
    credentials: [],
  });
  await expect(forkSettings.getByRole('button', { name: 'Save hosts' })).toHaveCount(0);
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
