import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { fakeRunner, newChat } from './coordinator-helpers';
import { test } from './helpers';

// The page opens with no network only through its service worker.
test.use({ serviceWorkers: 'allow' });

async function chatWithCard(request: APIRequestContext) {
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
  return { explorationId, mainForkId };
}

// Opens the fork with the service worker in control, so it opens again offline.
async function openKeptOffline(page: Page, path: string) {
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.goto(path);
  await expect(page.locator('.request-card.waiting')).toBeVisible();
  // The device saves its copy of the chat a moment after it loads.
  await page.waitForTimeout(1_500);
}

const draftOf = async (request: APIRequestContext, explorationId: string) => {
  const snapshot = await (await request.get(`/api/explorations/${explorationId}`)).json();
  return snapshot.requests[0].draft;
};

test('keeps card edits made offline across a reload, and sends them when back online', async ({
  page,
  context,
  request,
  browser,
}) => {
  const { explorationId, mainForkId } = await chatWithCard(request);
  const path = `/e/${explorationId}/f/${mainForkId}`;
  await openKeptOffline(page, path);

  await context.setOffline(true);
  const card = page.locator('.request-card.waiting');
  await card.getByRole('button', { name: 'Show and edit the details' }).click();
  await card.getByLabel("Brief: the fork's first message").fill('Look it up, offline.');
  await card.getByLabel('Reason for rejecting').fill('Written on the train');
  // Autosave puts the draft in the outbox a second after the last change.
  await page.waitForTimeout(1_500);
  expect(await draftOf(request, explorationId)).toBeNull();

  await page.reload();
  const reloaded = page.locator('.request-card.waiting');
  await expect(reloaded.getByLabel('Reason for rejecting')).toHaveValue('Written on the train');
  await reloaded.getByRole('button', { name: 'Show and edit the details' }).click();
  await expect(reloaded.getByLabel("Brief: the fork's first message")).toHaveValue(
    'Look it up, offline.',
  );

  await context.setOffline(false);
  await expect
    .poll(() => draftOf(request, explorationId), { timeout: 15_000 })
    .toMatchObject({
      reason: 'Written on the train',
      items: [{ action: { brief: 'Look it up, offline.' } }],
    });
  const other = await (await browser.newContext()).newPage();
  await other.goto(path);
  const elsewhere = other.locator('.request-card.waiting');
  await expect(elsewhere.getByLabel('Reason for rejecting')).toHaveValue('Written on the train');
  await elsewhere.getByRole('button', { name: 'Show and edit the details' }).click();
  await expect(elsewhere.getByLabel("Brief: the fork's first message")).toHaveValue(
    'Look it up, offline.',
  );
  await other.close();
});

test('holds Approve and Reject while offline, and gives them back online', async ({
  page,
  context,
  request,
}) => {
  const { explorationId, mainForkId } = await chatWithCard(request);
  await openKeptOffline(page, `/e/${explorationId}/f/${mainForkId}`);
  const card = page.locator('.request-card.waiting');
  const approve = card.getByRole('button', { name: 'Approve 1' });
  await expect(approve).toBeEnabled();

  await context.setOffline(true);
  await expect(approve).toBeDisabled();
  await expect(card.getByRole('button', { name: 'Reject' })).toBeDisabled();
  await expect(card.locator('.offline-note')).toContainText('Approve and Reject wait');

  await context.setOffline(false);
  await expect(approve).toBeEnabled({ timeout: 15_000 });
  await approve.click();
  await card.getByRole('button', { name: 'Sure?' }).click();
  await expect(page.locator('.request-card')).toContainText('Approved 1 of 1');
});

test('keeps Coordination and Autonomous changed offline, and sends them when back online', async ({
  page,
  context,
  request,
  browser,
}) => {
  const { explorationId, mainForkId } = await newChat(request, 'Plan the work');
  const settingsPath = `/e/${explorationId}/f/${mainForkId}/settings`;
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.goto(settingsPath);
  const settings = page.getByRole('region', { name: 'Requests' });
  await expect(settings).toBeVisible();
  await page.waitForTimeout(1_500);

  await context.setOffline(true);
  const coordination = settings.getByRole('checkbox', { name: 'Coordination' });
  const notes = settings.getByRole('checkbox', { name: /^Notes:/ });
  await coordination.check();
  await notes.check();
  await expect(coordination).toBeChecked();
  await expect(notes).toBeChecked();
  await expect(settings).toContainText('Not sent yet');

  await page.reload();
  const reloaded = page.getByRole('region', { name: 'Requests' });
  await expect(reloaded.getByRole('checkbox', { name: 'Coordination' })).toBeChecked();
  await expect(reloaded.getByRole('checkbox', { name: /^Notes:/ })).toBeChecked();
  const forkOf = async () => {
    const snapshot = await (await request.get(`/api/explorations/${explorationId}`)).json();
    return snapshot.forks.find((fork: { id: string }) => fork.id === mainForkId);
  };
  expect(await forkOf()).toMatchObject({ coordination: false, autonomous: [] });

  await context.setOffline(false);
  await expect
    .poll(forkOf, { timeout: 15_000 })
    .toMatchObject({ coordination: true, autonomous: ['notes'] });
  const other = await (await browser.newContext()).newPage();
  await other.goto(settingsPath);
  const elsewhere = other.getByRole('region', { name: 'Requests' });
  await expect(elsewhere.getByRole('checkbox', { name: 'Coordination' })).toBeChecked();
  await expect(elsewhere.getByRole('checkbox', { name: /^Notes:/ })).toBeChecked();
  await other.close();
});
