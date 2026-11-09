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
  const activity = page.locator('.activity-group');
  await expect(activity).toContainText('Working · 2 steps');
  await expect(activity.locator('li')).toHaveText([
    'Searching the web for "caching"',
    'Reading report.pdf',
  ]);
  await expect(page.getByRole('button', { name: /sonnet-5-5 · 84k \/ 1M/ })).toBeVisible();

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
