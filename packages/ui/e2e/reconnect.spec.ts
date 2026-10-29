import { expect, test } from '@playwright/test';
import type { Snapshot } from '@shared/types';
import { openSeededExploration } from './helpers';

test('opens the live updates again after the daemon answered with an error page', async ({
  page,
}) => {
  // What Tailscale Serve answers while the daemon restarts; EventSource never retries after it.
  await page.route('**/events', (route) => route.fulfill({ status: 502, body: 'Bad gateway' }));
  const explorationId = await openSeededExploration(page);
  await expect(page.getByText('Reconnecting…')).toBeVisible();

  await page.unroute('**/events');
  await expect(page.getByText('Reconnecting…')).toHaveCount(0, { timeout: 10_000 });

  const snapshot: Snapshot = await (
    await page.request.get(`/api/explorations/${explorationId}`)
  ).json();
  const mainFork = snapshot.forks.find((fork) => fork.parentForkId === null)!;
  const drafts = snapshot.comments.filter(
    (comment) => comment.status === 'draft' && comment.viewForkId === mainFork.id,
  ).length;
  await expect(page.locator('.reply-bar .summary')).toHaveText(
    `${drafts} comment${drafts === 1 ? '' : 's'}`,
  );
  const comment = await page.request.post(`/api/explorations/${explorationId}/comments`, {
    data: {
      messageId: snapshot.messages.find((message) => message.role === 'assistant')!.id,
      viewForkId: mainFork.id,
      quote: 'cache',
      startOffset: 0,
      endOffset: 5,
      body: 'Arrived live',
    },
  });
  await expect(page.locator('.reply-bar .summary')).toHaveText(`${drafts + 1} comments`);
  await page.request.delete(`/api/comments/${(await comment.json()).id}`);
});
