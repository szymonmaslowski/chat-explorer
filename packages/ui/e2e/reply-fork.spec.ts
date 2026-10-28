import { expect, test, type APIRequestContext } from '@playwright/test';

const shimId = 'reply-fork-shim';

async function deliverAndAnswer(request: APIRequestContext, explorationId: string, answer: string) {
  await request.post(`/api/internal/explorations/${explorationId}/feedback`, {
    data: { shimId, waitMs: 1_000 },
  });
  const snapshot = await (await request.get(`/api/explorations/${explorationId}`)).json();
  const tip = snapshot.messages.at(-1);
  await request.post(`/api/internal/forks/${tip.forkId}/messages`, {
    data: { shimId, inReplyTo: tip.id, content: answer },
  });
}

test('sends a reply to a new fork and leaves the current fork as it was', async ({
  page,
  request,
}) => {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'How do I cache responses?' } })
  ).json();
  await request.post(`/api/internal/explorations/${explorationId}/attach`, {
    data: { shimId, sessionId: 'reply-fork-session', takeover: true },
  });
  await deliverAndAnswer(request, explorationId, 'Use HTTP caching.');

  await page.goto(`/e/${explorationId}`);
  await page.getByPlaceholder('Reply to Claude').fill('What about Redis instead?');
  await page.getByLabel('New fork').check();
  await expect(page.locator('.reply-bar .summary')).toHaveText('new fork with message');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.locator('.queued-submission')).toContainText('Queued as a new fork');
  await expect(page.getByLabel('New fork')).not.toBeChecked();

  await deliverAndAnswer(request, explorationId, 'Redis works too.');

  await expect(page.locator('.queued-submission')).toHaveCount(0);
  const link = page.getByRole('link', { name: '↳ Fork: What about Redis instead?' });
  await expect(link).toBeVisible();
  await expect(page.locator('.message')).toHaveCount(2);
  await expect(page.locator('.conversation')).not.toContainText('Redis works too.');

  await link.click();
  await expect(page.locator('.conversation')).toContainText('What about Redis instead?');
  await expect(page.locator('.conversation')).toContainText('Redis works too.');
  await expect(page.locator('.fork-point')).toContainText('Forked from');

  await request.post('/api/internal/detach', { data: { shimId } });
});
