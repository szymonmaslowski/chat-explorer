import { expect } from '@playwright/test';
import type { Snapshot } from '@shared/types';
import {
  answeredChat,
  attachFakeSession,
  chooseCommentType,
  clickQuotedText,
  deliverAndAnswer,
  detachFakeSession,
  selectAnswer,
  test,
} from './helpers';

test('a fork comment picks the board group of the fork it starts', async ({ page, request }) => {
  const explorationId = await answeredChat(request);
  await request.post(`/api/explorations/${explorationId}/board-columns`, {
    data: { name: 'research' },
  });
  const snapshot = async () =>
    (await (await request.get(`/api/explorations/${explorationId}`)).json()) as Snapshot;
  const research = (await snapshot()).exploration.boardColumns[0]!;

  await page.goto(`/e/${explorationId}`);
  await selectAnswer(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await chooseCommentType(page, 'Fork');
  const picker = page.getByLabel('Board group of the new fork');
  // Its parent is the main fork, which is not on the board: the default is Ungrouped, first.
  await expect(picker).toHaveValue('ungrouped');
  await expect(picker.locator('option')).toHaveText(['Ungrouped', 'research', 'New group']);
  await picker.selectOption({ label: 'research' });
  await page.getByPlaceholder('Your comment').fill('Look into Redis');
  await page.keyboard.press('ControlOrMeta+Enter');

  // The saved draft keeps the choice, also after a reload, and can still change it.
  await page.reload();
  await clickQuotedText(page, 'Caching');
  const card = page.locator('.opened-comments .comment-card.draft');
  await expect(card.getByLabel('Board group of the new fork')).toHaveValue(research.id);

  await page.getByRole('button', { name: 'Submit' }).click();
  await attachFakeSession(request, explorationId);
  await deliverAndAnswer(request, explorationId, 'Redis is a fine cache.');
  await detachFakeSession(request);
  await expect
    .poll(async () => (await snapshot()).forks.find((fork) => fork.parentForkId)?.boardColumnId)
    .toBe(research.id);
});

test('a fork comment can ask for a new group, made with the fork', async ({ page, request }) => {
  const explorationId = await answeredChat(request);
  await page.goto(`/e/${explorationId}`);
  await selectAnswer(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await chooseCommentType(page, 'Fork');
  await page.getByLabel('Board group of the new fork').selectOption({ label: 'New group' });
  await page.getByPlaceholder('Your comment').fill('A new direction');
  await page.keyboard.press('ControlOrMeta+Enter');
  // Nothing is made until Submit, so a comment never sent leaves no empty group behind.
  const columns = async () =>
    ((await (await request.get(`/api/explorations/${explorationId}`)).json()) as Snapshot)
      .exploration.boardColumns;
  expect(await columns()).toHaveLength(0);

  await page.getByRole('button', { name: 'Submit' }).click();
  await attachFakeSession(request, explorationId);
  await deliverAndAnswer(request, explorationId, 'Sure.');
  await detachFakeSession(request);
  await expect
    .poll(async () => (await columns()).map((column) => column.name))
    .toEqual(['Group 1']);
});
