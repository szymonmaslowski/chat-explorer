import { expect, type APIRequestContext, type Page } from '@playwright/test';

export async function openSeededExploration(page: Page) {
  const explorations: { id: string; title: string }[] = await (
    await page.request.get('/api/explorations')
  ).json();
  const seeded = explorations.find((exploration) => exploration.title === 'Caching API responses')!;
  await page.goto(`/e/${seeded.id}`);
  await expect(page.locator('.message').first()).toBeVisible();
  return seeded.id;
}

const shimId = 'e2e-shim';

// Stands in for Claude: attaches like the MCP shim does, takes the queued feedback and answers.
export async function attachFakeSession(request: APIRequestContext, explorationId: string) {
  await request.post(`/api/internal/explorations/${explorationId}/attach`, {
    data: { shimId, sessionId: 'e2e-session', takeover: true },
  });
}

export async function deliverAndAnswer(
  request: APIRequestContext,
  explorationId: string,
  answer: string,
) {
  const feedback = await (
    await request.post(`/api/internal/explorations/${explorationId}/feedback`, {
      data: { shimId, waitMs: 1_000 },
    })
  ).json();
  const snapshot = await (await request.get(`/api/explorations/${explorationId}`)).json();
  const tip = snapshot.messages.at(-1);
  await request.post(`/api/internal/forks/${tip.forkId}/messages`, {
    data: { shimId, inReplyTo: tip.id, content: answer },
  });
  return feedback;
}

export const detachFakeSession = (request: APIRequestContext) =>
  request.post('/api/internal/detach', { data: { shimId } });

// The reply box is saved on the daemon, so a test that types into a shared chat empties it again.
export async function clearReply(page: Page) {
  const saved = page.waitForResponse(
    (response) => response.url().endsWith('/reply-draft') && response.request().method() === 'PUT',
  );
  await page.getByPlaceholder('Reply to Claude').fill('');
  await saved;
}
