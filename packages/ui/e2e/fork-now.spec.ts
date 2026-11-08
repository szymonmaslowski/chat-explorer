import { expect } from '@playwright/test';
import {
  answeredChat,
  attachFakeSession,
  chooseCommentType,
  deliverAndAnswer,
  detachFakeSession,
  selectAnswer,
  test,
} from './helpers';

test('starts a fork from a comment at once, leaving the other drafts and the reply', async ({
  page,
  request,
}) => {
  const explorationId = await answeredChat(request);
  await page.goto(`/e/${explorationId}`);
  await selectAnswer(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByPlaceholder('Your comment').fill('Keep this inline');
  await page.keyboard.press('ControlOrMeta+Enter');
  await page.getByPlaceholder('Reply to Claude').fill('Still typing');

  await page.mouse.move(0, 0);
  await selectAnswer(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await chooseCommentType(page.locator('.comment-editor'), 'Fork');
  await expect(
    page.locator('.comment-editor').getByRole('button', { name: 'Fork now' }),
  ).toHaveCount(0);
  await page.getByPlaceholder('Your comment').fill('Try it this way');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const card = page.locator('.comment-card.draft', { hasText: 'Try it this way' });
  await card.hover();
  await card.getByRole('button', { name: 'Fork now' }).click();

  await expect(page.locator('.queued-submission')).toContainText('1 comment');
  await expect(page.locator('.reply-bar .summary')).toHaveText('1 comment, message');
  await expect(page.getByPlaceholder('Reply to Claude')).toHaveValue('Still typing');

  await attachFakeSession(request, explorationId);
  await request.post(`/api/internal/explorations/${explorationId}/feedback`, {
    data: { shimId: 'e2e-shim', waitMs: 1_000 },
  });
  await detachFakeSession(request);

  await expect(page.locator('.queued-submission')).toHaveCount(0);
  await expect(page.locator('.comment-card.submitted')).toHaveCount(0);
  await expect(page.getByRole('link', { name: '↳ Fork: Try it this way' })).toBeVisible();
  await expect(page.locator('.reply-bar .summary')).toHaveText('1 comment, message');
});

test('starts a fork from a saved fork comment at once', async ({ page, request }) => {
  await page.goto(`/e/${await answeredChat(request)}`);
  await selectAnswer(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByPlaceholder('Your comment').fill('Later fork');
  await chooseCommentType(page.locator('.comment-editor'), 'Fork');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const card = page.locator('.comment-card.draft');

  await page.mouse.move(0, 0);
  await card.hover();
  await card.getByRole('button', { name: 'Unfork' }).click();
  await expect(card.getByRole('button', { name: 'Fork now' })).toHaveCount(0);
  await card.getByRole('button', { name: 'Fork', exact: true }).click();
  await card.getByRole('button', { name: 'Fork now' }).click();

  await expect(page.locator('.comment-card.queued')).toContainText('· queued');
  await expect(page.locator('.queued-submission')).toContainText('1 comment');
});

test('joins comments into one fork, unlinks one and ungroups the rest', async ({
  page,
  request,
}) => {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'Explain caching' } })
  ).json();
  await attachFakeSession(request, explorationId);
  await deliverAndAnswer(
    request,
    explorationId,
    'Alpha paragraph here.\n\nBravo paragraph here.\n\nCharlie paragraph here.',
  );
  await detachFakeSession(request);
  const snapshot = await (await request.get(`/api/explorations/${explorationId}`)).json();
  const answer = snapshot.messages.at(-1);
  for (const [quote, startOffset, type] of [
    ['Bravo', 22, 'fork'],
    ['Alpha', 0, 'inline'],
    ['Charlie', 44, 'fork'],
  ] as const) {
    await request.post(`/api/explorations/${explorationId}/comments`, {
      data: {
        messageId: answer.id,
        viewForkId: answer.forkId,
        quote,
        startOffset,
        endOffset: startOffset + quote.length,
        body: `About ${quote}`,
        type,
      },
    });
  }
  await page.goto(`/e/${explorationId}`);
  const card = (name: string) => page.locator('.comment-card', { hasText: `About ${name}` });
  const summary = page.locator('.reply-bar .summary');
  await expect(summary).toHaveText('2 forks, 1 comment');

  await card('Bravo').getByRole('button', { name: 'Join', exact: true }).click();
  await card('Alpha').getByLabel('Join into one fork').check();
  await card('Charlie').getByLabel('Join into one fork').check();
  await card('Bravo').getByRole('button', { name: 'Confirm' }).click();

  const group = page.locator('.fork-group');
  await expect(group.locator('.comment-card .body')).toHaveText([
    'About Alpha',
    'About Bravo',
    'About Charlie',
  ]);
  await expect(group.locator('.comment-card .label').first()).toContainText('Comment');
  await expect(
    group.locator('.comment-card').getByRole('button', { name: 'Fork now' }),
  ).toHaveCount(0);
  await expect(summary).toHaveText('1 fork');

  await card('Alpha').getByRole('button', { name: 'Unlink' }).click();
  await expect(group.locator('.comment-card .body')).toHaveText(['About Bravo', 'About Charlie']);
  await expect(summary).toHaveText('1 fork, 1 comment');

  await group.getByRole('button', { name: 'Add comments' }).click();
  await card('Alpha').getByLabel('Join into one fork').check();
  await group.getByRole('button', { name: 'Cancel' }).click();
  await expect(group.locator('.comment-card .body')).toHaveText(['About Bravo', 'About Charlie']);

  await group.getByRole('button', { name: 'Ungroup' }).click();
  await expect(group).toHaveCount(0);
  await expect(summary).toHaveText('2 forks, 1 comment');
});
