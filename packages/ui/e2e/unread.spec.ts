import { expect } from '@playwright/test';
import { attachFakeSession, deliverAndAnswer, detachFakeSession, test } from './helpers';

test('marks a new answer, clears it once seen, and marks it unread again', async ({
  page,
  request,
}) => {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'How do I cache responses?' } })
  ).json();
  await page.goto('/');
  const chat = page.locator('.exploration').filter({ hasText: explorationId });
  await expect(chat).toBeVisible();
  await expect(chat.getByRole('img', { name: 'New answer' })).toHaveCount(0);

  await attachFakeSession(request, explorationId);
  await deliverAndAnswer(request, explorationId, 'Use HTTP caching.');
  await detachFakeSession(request);
  await expect(chat.getByRole('img', { name: 'New answer' })).toBeVisible();

  await page.clock.install();
  await page.goto(`/e/${explorationId}`);
  const answer = page.locator('.message.assistant');
  await expect(answer).toHaveAttribute('data-unread', 'true');
  await expect(answer.locator('.new-label')).toHaveText('New');
  await page.clock.runFor(1_500);
  await page.goBack();
  await expect(chat.getByRole('img', { name: 'New answer' })).toBeVisible();

  await page.goto(`/e/${explorationId}`);
  await page.clock.runFor(3_500);
  await expect(answer).not.toHaveAttribute('data-unread');
  await expect(answer.locator('.new-label')).toHaveText('New');

  await answer.getByRole('button', { name: 'Mark unread from here' }).click();
  await expect(answer).toHaveAttribute('data-unread', 'true');
  await page.clock.runFor(5_000);
  await expect(answer).toHaveAttribute('data-unread', 'true');

  await page.goto('/');
  await expect(chat.getByRole('img', { name: 'New answer' })).toBeVisible();
  await page.goto(`/e/${explorationId}`);
  await page.clock.runFor(3_500);
  await expect(answer).not.toHaveAttribute('data-unread');
  await page.getByRole('button', { name: 'Mark unread', exact: true }).click();
  await expect(answer).toHaveAttribute('data-unread', 'true');
});

test('opens a fork at its first unread answer and marks forks with new answers', async ({
  page,
  request,
}) => {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'First question' } })
  ).json();
  await attachFakeSession(request, explorationId);
  await deliverAndAnswer(request, explorationId, `${'A long first answer. '.repeat(400)}`);
  const snapshot = await (await request.get(`/api/explorations/${explorationId}`)).json();
  const first = snapshot.messages.find((message: { role: string }) => message.role === 'assistant');
  await request.post(`/api/explorations/${explorationId}/read`, {
    data: { messageIds: [first.id] },
  });
  const main = snapshot.forks[0];
  await request.post(`/api/explorations/${explorationId}/submit`, {
    data: { forkId: main.id, globalMessage: 'Second question', newFork: false },
  });
  await deliverAndAnswer(request, explorationId, 'The second answer.');
  await request.post(`/api/explorations/${explorationId}/submit`, {
    data: { forkId: main.id, globalMessage: 'A side question', newFork: true },
  });
  await deliverAndAnswer(request, explorationId, 'The side answer.');
  await detachFakeSession(request);

  await page.goto(`/e/${explorationId}`);
  const second = page.locator('.message.assistant').filter({ hasText: 'The second answer.' });
  await expect(second).toBeInViewport();
  await expect(page.locator('.message.user').first()).not.toBeInViewport();
  await expect(page.locator('.reply-fork').getByRole('img', { name: 'New answer' })).toBeVisible();

  await page.getByRole('link', { name: 'Map' }).click();
  await expect(page.locator('.fork-box').getByRole('img', { name: 'New answer' })).toHaveCount(2);
});
