import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type APIRequestContext } from '@playwright/test';
import { test } from './helpers';

// Plays a runner against the daemon's runner API, with the machine token the daemon made.
function fakeRunner(request: APIRequestContext) {
  const token = readFileSync(
    join(tmpdir(), 'chat-explorer-e2e', 'runner', 'machine-token'),
    'utf8',
  ).trim();
  const call = async (path: string, data: object) =>
    (
      await request.post(`/api/runner/${path}`, {
        data,
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
  return { call };
}

test('shows what the runner does in a fork, its usage, and stops it on request', async ({
  page,
  request,
}) => {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'Research caching' } })
  ).json();
  const runner = fakeRunner(request);
  const { lease } = await runner.call('claim', {
    runnerId: 'e2e-runner',
    explorationId,
    waitMs: 5_000,
  });
  const fork = `forks/${lease.forkId}`;
  const { messages } = await runner.call(`${fork}/input`, { leaseId: lease.leaseId });
  await runner.call(`${fork}/turn/start`, { leaseId: lease.leaseId });
  for (const text of ['Searching the web for "caching"', 'Reading report.pdf']) {
    await runner.call(`${fork}/activity`, {
      leaseId: lease.leaseId,
      afterMessageId: messages[0].id,
      kind: 'tool',
      text,
    });
  }
  await runner.call(`${fork}/usage`, {
    leaseId: lease.leaseId,
    model: 'claude-sonnet-5-5',
    contextTokens: 84_000,
    contextWindow: 1_000_000,
  });

  await page.goto(`/e/${explorationId}`);
  const status = page.locator('.exploration-header .status');
  await expect(status).toHaveText('working');
  const activity = page.locator('.activity-group');
  await expect(activity).toContainText('Working · 2 steps');
  await expect(activity.locator('li')).toHaveText([
    'Searching the web for "caching"',
    'Reading report.pdf',
  ]);
  await page.getByRole('button', { name: 'Chat settings' }).click();
  const forkSettings = page.getByRole('region', { name: 'This fork' });
  await expect(forkSettings).toContainText('Model: claude-sonnet-5-5');
  await expect(forkSettings).toContainText('Context: 84,000 tokens of 1,000,000 (8%)');

  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const input = await runner.call(`${fork}/input`, {
    leaseId: lease.leaseId,
    after: messages[0].id,
    waitMs: 5_000,
  });
  expect(input.stop).toBe(true);
  await runner.call(`${fork}/stopped`, { leaseId: lease.leaseId, upToMessageId: messages[0].id });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await expect(activity).toContainText('Worked');
  await expect(activity.locator('li')).toHaveCount(0);
  await expect(status).toHaveText('done');

  // A finished attempt's steps load when it is opened, after a fresh load of the chat.
  await page.reload();
  await expect(activity).toContainText('Worked · 2 steps');
  await activity.getByRole('button').click();
  await expect(activity.locator('li')).toHaveText([
    'Searching the web for "caching"',
    'Reading report.pdf',
  ]);

  // The map is about the whole chat, where one fork's state would mislead.
  await page.goto(`/e/${explorationId}/map`);
  await expect(page.locator('.fork-box')).toHaveCount(1);
  await expect(status).toHaveCount(0);
});

test('offers Retry on a fork whose runner failed too often', async ({ page, request }) => {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'Fail please' } })
  ).json();
  const runner = fakeRunner(request);
  for (let attempt = 0; attempt < 3; attempt++) {
    const { lease } = await runner.call('claim', {
      runnerId: 'e2e-runner',
      explorationId,
      waitMs: 5_000,
    });
    await runner.call(`forks/${lease.forkId}/fail`, {
      leaseId: lease.leaseId,
      reason: 'Docker is not running.',
    });
  }
  await page.goto(`/e/${explorationId}`);
  const alert = page.getByRole('alert').filter({ hasText: 'Claude could not answer' });
  await expect(alert).toContainText('Docker is not running.');
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(alert).toHaveCount(0);
});

test('says before sending when a coding fork would wait for memory, and while it waits', async ({
  page,
  request,
}) => {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'Build the app' } })
  ).json();
  const runner = fakeRunner(request);
  const { lease } = await runner.call('claim', {
    runnerId: 'e2e-runner',
    explorationId,
    waitMs: 5_000,
  });
  await request.patch(`/api/forks/${lease.forkId}/coding`, { data: { coding: true } });
  const capacity = { slots: 1, memory: '6656m', forkIds: ['fork_0therf0rk'] };
  await runner.call('capacity', { capacity });

  await page.goto(`/e/${explorationId}`);
  const hint = page.locator('.coding-room');
  await expect(hint).toHaveText(
    "Docker's memory for coding is taken: another coding fork is using it (6656m). A message sent now waits until one of them goes idle.",
  );

  const fork = `forks/${lease.forkId}`;
  const reason = 'Another coding fork is using the memory Docker has for coding (6656m).';
  await runner.call(`${fork}/waiting-memory`, { leaseId: lease.leaseId, reason });
  await expect(page.locator('.run-status')).toContainText(
    `Waiting for memory: ${reason} It starts once a coding fork goes idle.`,
  );
  await expect(page.locator('.exploration-header .status')).toHaveText('waiting for memory');
  await expect(hint).toHaveCount(0);

  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect
    .poll(async () => (await runner.call(`${fork}/heartbeat`, { leaseId: lease.leaseId })).stop)
    .toBe(true);
  await runner.call(`${fork}/stopped`, { leaseId: lease.leaseId, upToMessageId: null });
  await expect(page.locator('.run-status')).toHaveCount(0);
  await runner.call('capacity', { capacity: null });
});

test("offers a coding fork the runner's credentials and hosts, and restarts its container", async ({
  page,
  request,
}) => {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'Push the fix' } })
  ).json();
  const runner = fakeRunner(request);
  await runner.call('capabilities', {
    capabilities: {
      coding: true,
      codingOff: null,
      allowedHosts: ['registry.npmjs.org:443', '*.githubusercontent.com:443'],
      privateHosts: [],
      credentials: [
        { name: 'GitHub token', type: 'token', hosts: ['github.com:443', 'api.github.com:443'] },
      ],
      limits: { memory: '6656m', slots: 1, cpus: null, processes: 512, workspaceLimitGb: 10 },
      configHash: 'abc',
    },
  });
  const { forks } = await (await request.get(`/api/explorations/${explorationId}`)).json();
  const forkId = forks[0].id;
  await request.patch(`/api/forks/${forkId}/coding`, { data: { coding: true } });
  const network = async () =>
    (await (await request.get(`/api/explorations/${explorationId}`)).json()).forks[0].network;

  await page.goto(`/e/${explorationId}`);
  await page.getByRole('button', { name: 'Chat settings' }).click();
  const forkSettings = page.getByRole('region', { name: 'This fork' });
  await expect(forkSettings).toContainText(
    'This runner allows registry.npmjs.org:443, *.githubusercontent.com:443.',
  );
  await forkSettings.getByLabel(/Other allowed hosts/).fill('github.com:443');
  await expect(forkSettings.getByRole('alert')).toHaveText(
    'Not allowed by this runner, unless it keeps them hidden: github.com:443',
  );

  await forkSettings.getByRole('checkbox', { name: /GitHub token/ }).check();
  await expect.poll(network).toMatchObject({ credentials: ['GitHub token'] });
  await expect(forkSettings.getByRole('note')).toContainText(
    'Claude can read these credentials and use them anywhere on their hosts',
  );
  await forkSettings.getByLabel("A hidden credential's name").fill('Home git');
  await forkSettings.getByRole('button', { name: 'Add' }).click();
  await expect.poll(network).toMatchObject({ credentials: ['GitHub token', 'Home git'] });
  await expect(forkSettings).toContainText('Home git (kept hidden by the runner)');

  await forkSettings.getByRole('button', { name: 'Restart container' }).click();
  await expect(forkSettings.getByRole('status')).toHaveText(
    'No container is running. Your next message starts a fresh one.',
  );
});
