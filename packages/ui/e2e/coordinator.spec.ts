import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type APIRequestContext } from '@playwright/test';
import { test } from './helpers';

// A new chat, and its main fork from the chat's snapshot.
async function newChat(request: APIRequestContext, message: string) {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message } })
  ).json();
  const snapshot = await (await request.get(`/api/explorations/${explorationId}`)).json();
  const mainForkId: string = snapshot.forks.find(
    (fork: { parentForkId: string | null }) => fork.parentForkId === null,
  ).id;
  return { explorationId, mainForkId };
}

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
  const tool = async (toolsToken: string, name: string, args: object) =>
    (
      await request.post('/api/tools/mcp', {
        headers: {
          authorization: `Bearer ${toolsToken}`,
          accept: 'application/json, text/event-stream',
        },
        data: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        },
      })
    ).json();
  return { call, tool };
}

test("approves a fork the coordinator requested, with the user's edit", async ({
  page,
  request,
}) => {
  const { explorationId, mainForkId } = await newChat(request, 'Plan the settings page');

  // Coordination is the user's setting, on the main fork's settings page.
  await page.goto(`/e/${explorationId}/f/${mainForkId}/settings`);
  const requestSettings = page.getByRole('region', { name: 'Requests' });
  const coordination = requestSettings.getByRole('checkbox', { name: 'Coordination' });
  await coordination.check();
  await expect(coordination).toBeChecked();

  const runner = fakeRunner(request);
  const { lease } = await runner.call('claim', {
    runnerId: 'e2e-runner',
    explorationId,
    waitMs: 5_000,
  });
  expect(lease.forkId).toBe(mainForkId);
  await runner.call(`forks/${mainForkId}/input`, { leaseId: lease.leaseId });
  await runner.call(`forks/${mainForkId}/turn/start`, { leaseId: lease.leaseId });
  const asked = await runner.tool(lease.toolsToken, 'request_fork', {
    title: 'Settings page',
    brief: 'Build the settings page.',
    coding: true,
    registries: ['npm'],
  });
  expect(asked.result.isError).toBeFalsy();
  const { forkId } = JSON.parse(asked.result.content[0].text);

  await page.goto(`/e/${explorationId}/f/${mainForkId}`);
  const card = page.locator('.request-card.waiting');
  await expect(card).toContainText('Start a new fork "Settings page"');
  const bar = page.locator('.request-bar');
  await expect(bar).toContainText('1 request waiting');

  await card.getByRole('button', { name: 'Show and edit the details' }).click();
  await card.getByLabel("Brief: the fork's first message").fill('Build a smaller settings page.');
  await expect(card.locator('.edited')).toBeVisible();

  const approve = card.getByRole('button', { name: 'Approve 1' });
  await approve.click();
  await expect(card.getByRole('button', { name: 'Sure?' })).toBeVisible();
  await card.getByRole('button', { name: 'Sure?' }).click();

  const record = page.locator(`#r-${asked.result.content[0].text.match(/req_\w+/)[0]}`);
  await expect(record).toContainText('Approved 1 of 1');
  await expect(record).toContainText('Edited brief. Claude asked for:');
  await expect(bar).toHaveCount(0);

  await record.getByRole('link', { name: 'Open the fork' }).click();
  await expect(page).toHaveURL(new RegExp(`/f/${forkId}`));
  await expect(page.locator('.conversation')).toContainText('Build a smaller settings page.');
});

test('shows a dot on the chats list and the map while a request waits', async ({
  page,
  request,
}) => {
  const { explorationId, mainForkId } = await newChat(request, 'Plan the work');
  await request.patch(`/api/forks/${mainForkId}/coordination`, { data: { coordination: true } });
  const runner = fakeRunner(request);
  const { lease } = await runner.call('claim', {
    runnerId: 'e2e-runner',
    explorationId,
    waitMs: 5_000,
  });
  await runner.call(`forks/${mainForkId}/input`, { leaseId: lease.leaseId });
  await runner.tool(lease.toolsToken, 'request_fork', { title: 'Research', brief: 'Look it up.' });

  await page.goto('/');
  const row = page
    .locator('.exploration')
    .filter({ has: page.locator(`code:text("${explorationId}")`) });
  await expect(row.locator('.attention-dot.request')).toBeVisible();
  await page.goto(`/e/${explorationId}/map`);
  await expect(page.locator('.attention-dot.request').first()).toBeVisible();
});
