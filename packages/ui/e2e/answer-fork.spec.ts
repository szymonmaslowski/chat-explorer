import { expect } from '@playwright/test';
import { answeredChat, attachFakeSession, detachFakeSession, shimId, test } from './helpers';

test("starts an empty fork after one of Claude's answers and replies there", async ({
  page,
  request,
}) => {
  const explorationId = await answeredChat(request);
  await page.goto(`/e/${explorationId}`);
  const answer = page.locator('.message.assistant').last();
  await answer.getByRole('button', { name: 'Fork from here' }).click();

  await expect(page).toHaveURL(new RegExp(`/e/${explorationId}/f/[a-z0-9]+$`));
  const forkId = page.url().split('/').at(-1)!;
  await expect(page.locator('.message').last()).toContainText(
    'Caching keeps a copy of a response nearby.',
  );
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Caching keeps a copy of a response nearby.',
  );

  await page.getByPlaceholder('Reply to Claude').fill('Where should the copy live?');
  await page.getByRole('button', { name: 'Submit' }).click();
  await attachFakeSession(request, explorationId);
  const feedback = await (
    await request.post(`/api/internal/explorations/${explorationId}/feedback`, {
      data: { shimId, waitMs: 1_000 },
    })
  ).json();
  await detachFakeSession(request);
  const [fork] = feedback.forks;
  expect(fork.forkId).toBe(forkId);
  expect(fork.isNewFork).toBe(true);
  expect(fork.userMessages[0].text).toBe('Where should the copy live?');

  await page.getByRole('link', { name: 'Map' }).click();
  await expect(page.locator('.fork-box')).toHaveCount(2);
});
