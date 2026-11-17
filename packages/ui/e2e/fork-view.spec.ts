import { expect, type Page } from '@playwright/test';
import {
  attachFakeSession,
  clearReply,
  clickQuotedText,
  deliverAndAnswer,
  detachFakeSession,
  openSeededExploration,
  seededDraftQuote,
  test,
} from './helpers';

const paragraphBox = async (page: Page, paragraph: string) => {
  const locator = page.locator('.content p', { hasText: paragraph }).first();
  // Centred, so the sticky header does not cover it.
  await locator.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  return (await locator.boundingBox())!;
};

async function selectText(page: Page, paragraph: string, length: number) {
  const box = await paragraphBox(page, paragraph);
  await page.mouse.move(box.x + 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + length, box.y + 10, { steps: 5 });
  await page.mouse.up();
}

const commentButton = (page: Page) => page.getByRole('button', { name: 'Comment', exact: true });

const summary = (page: Page) => page.locator('.reply-bar .summary');

test('creates, reveals and deletes a draft comment', async ({ page }) => {
  await openSeededExploration(page);
  await expect(summary(page)).toHaveText('1 comment');

  await selectText(page, 'There are three common ways', 160);
  await commentButton(page).click();
  await page.getByPlaceholder('Your comment').fill('Which one is cheapest?');
  await page.keyboard.press('ControlOrMeta+Enter');

  const card = page.locator('.comment-card.draft', { hasText: 'Which one is cheapest?' });
  await expect(card).toBeVisible();
  await expect(summary(page)).toHaveText('2 comments');

  await card.getByRole('button', { name: 'Delete' }).click();
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Confirm' }).click();
  await expect(card).toHaveCount(0);
  await expect(summary(page)).toHaveText('1 comment');
});

test('offers a comment for a triple-clicked paragraph', async ({ page }) => {
  await openSeededExploration(page);
  const box = await paragraphBox(page, "For most apps I'd start");
  await page.mouse.click(box.x + 20, box.y + 10, { clickCount: 3 });
  await commentButton(page).click();
  await expect(page.locator('.comment-editor')).toContainText(
    "For most apps I'd start with HTTP caching for public data and a shared cache for per-user data.",
  );
  await page.keyboard.press('Escape');
});

test('offers a comment when the drag ends outside the conversation', async ({ page }) => {
  await openSeededExploration(page);
  const box = await paragraphBox(page, 'There are three common ways');
  await page.mouse.move(box.x + 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 120, box.y + 10, { steps: 5 });
  await page.mouse.up();
  await expect(commentButton(page)).toBeVisible();
});

test('queues a submit, scrolls to it and cancels it back into drafts', async ({ page }) => {
  await openSeededExploration(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByPlaceholder('Reply to Claude').fill('Can you compare costs?');
  await page.getByRole('button', { name: 'Submit' }).click();

  const queued = page.locator('.queued-submission');
  await expect(queued).toContainText('Can you compare costs?');
  await expect(queued).toBeInViewport();
  await clickQuotedText(page, seededDraftQuote);
  await expect(page.locator('.comment-card.queued')).toHaveCount(1);

  await queued.getByRole('button', { name: 'Cancel' }).click();
  await expect(queued).toHaveCount(0);
  await expect(page.getByPlaceholder('Reply to Claude')).toHaveValue('Can you compare costs?');
  await expect(summary(page)).toHaveText('1 comment, message');
  await clearReply(page);
});

test('navigates through the map and back and forward with [ and ]', async ({ page }) => {
  const explorationId = await openSeededExploration(page);
  await page.getByRole('link', { name: 'Chat', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/e/${explorationId}/map`));
  await page.locator('.fork-box', { hasText: 'Purging cached responses' }).click();
  await expect(page.locator('.fork-title')).toHaveText('Purging cached responses on a CDN');
  await expect(page.locator('.fork-point')).toContainText('Forked from');

  await page.keyboard.press('[');
  await expect(page).toHaveURL(/\/map/);
  await page.keyboard.press(']');
  await expect(page.locator('.fork-title')).toHaveText('Purging cached responses on a CDN');
});

test('opens an exploration from the list on its map', async ({ page }) => {
  const explorationId = await openSeededExploration(page);
  await page.goto('/');
  await page.locator('.exploration', { hasText: 'Caching API responses' }).click();
  await expect(page).toHaveURL(new RegExp(`/e/${explorationId}/map$`));
  await expect(page.locator('.fork-box')).toHaveCount(2);
});

test('opens a chat without forks on its conversation', async ({ page, request }) => {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'Only the main fork' } })
  ).json();
  await page.goto('/');
  await page.locator('.exploration', { hasText: explorationId }).click();
  await expect(page).toHaveURL(new RegExp(`/e/${explorationId}$`));
  await expect(page.locator('.message').first()).toContainText('Only the main fork');
});

test('opens a fork from the map at its end', async ({ page }) => {
  const explorationId = await openSeededExploration(page);
  await page.goto(`/e/${explorationId}/map`);
  await page.locator('.fork-box', { hasText: 'Caching options and invalidation' }).click();
  await expect(page.locator('.fork-title')).toHaveText('Caching options and invalidation');
  await expect(page.getByPlaceholder('Reply to Claude')).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
});

test('links the fork of a sent fork comment under its message, with no card', async ({ page }) => {
  await openSeededExploration(page);
  await expect(page.locator('.comment-card.submitted')).toHaveText([
    /sent\s*Keep the answers short\.$/,
  ]);
  await page.getByRole('link', { name: '↳ Fork: Purging cached responses on a CDN' }).click();
  await expect(page.locator('.fork-title')).toHaveText('Purging cached responses on a CDN');
});

test('shows the date and time of every message', async ({ page }) => {
  await openSeededExploration(page);
  const time = page.locator('.message .role time').first();
  await expect(time).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
  await expect(time).toHaveText(/\d{4}.*\d{1,2}:\d{2}/);
  await expect(page.locator('.message .role time')).toHaveCount(
    await page.locator('.message').count(),
  );
  if (process.env.TIME_SHOTS) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${process.env.TIME_SHOTS}/message-times-phone.png` });
  }
});

test('jumps to the end of a long answer and back to its start', async ({ page, request }) => {
  const paragraphs = Array.from({ length: 40 }, (_, index) => `Paragraph ${index + 1}.`);
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'Explain it at length' } })
  ).json();
  await attachFakeSession(request, explorationId);
  await deliverAndAnswer(request, explorationId, paragraphs.join('\n\n'));
  await detachFakeSession(request);
  await page.goto(`/e/${explorationId}`);
  const answer = page.locator('.message.assistant');
  await answer.locator('.role').scrollIntoViewIfNeeded();

  await answer.getByRole('button', { name: 'Go to the end of the answer' }).click();
  await expect(answer.getByText('Paragraph 40.')).toBeInViewport();
  await expect(answer.getByText('Paragraph 1.', { exact: true })).not.toBeInViewport();

  await answer.getByRole('button', { name: 'Go to the start of the answer' }).click();
  await expect(answer.getByText('Paragraph 1.', { exact: true })).toBeInViewport();
  await expect(answer.getByText('Paragraph 40.')).not.toBeInViewport();
});

test("keeps an answer's header in view under the page's header, and a click on it goes to the answer's start", async ({
  page,
  request,
}) => {
  const paragraphs = Array.from({ length: 40 }, (_, index) => `Paragraph ${index + 1}.`);
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'Explain it at length' } })
  ).json();
  await attachFakeSession(request, explorationId);
  await deliverAndAnswer(request, explorationId, paragraphs.join('\n\n'));
  await detachFakeSession(request);
  await page.goto(`/e/${explorationId}`);
  const answer = page.locator('.message.assistant');
  const header = answer.locator('.role');
  const pageHeaderBottom = async () =>
    (await page.locator('[data-sticky-header]').boundingBox())!.y +
    (await page.locator('[data-sticky-header]').boundingBox())!.height;

  await answer.getByText('Paragraph 30.').scrollIntoViewIfNeeded();
  await expect(answer.getByText('Paragraph 1.', { exact: true })).not.toBeInViewport();
  await expect(header).toBeInViewport();
  expect(Math.round((await header.boundingBox())!.y)).toBe(Math.round(await pageHeaderBottom()));
  await expect(answer.locator('.message-actions')).not.toBeInViewport();

  await header.click();
  await expect(answer.getByText('Paragraph 1.', { exact: true })).toBeInViewport();
  await expect(answer.locator('.message-actions')).toBeInViewport();
  await expect
    .poll(async () => (await header.boundingBox())!.y - (await pageHeaderBottom()))
    .toBeGreaterThan(8);
});

test('scrolls to the bottom of the fork from its header', async ({ page, request }) => {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'Tell me a lot' } })
  ).json();
  await attachFakeSession(request, explorationId);
  const answer = Array.from({ length: 60 }, (_, index) => `Paragraph ${index + 1}.`).join('\n\n');
  await deliverAndAnswer(request, explorationId, answer);
  await detachFakeSession(request);

  await page.goto(`/e/${explorationId}`);
  await expect(page.getByText('Paragraph 60.')).toBeAttached();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole('button', { name: 'Scroll to the bottom' }).click();
  await expect(page.getByText('Paragraph 60.')).toBeInViewport();
});

test("numbers Claude's answers back from the newest, which is [0]", async ({ page, request }) => {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'First question' } })
  ).json();
  await attachFakeSession(request, explorationId);
  await deliverAndAnswer(request, explorationId, 'First answer.');
  for (const turn of [1, 2]) {
    const snapshot = await (await request.get(`/api/explorations/${explorationId}`)).json();
    await request.post(`/api/explorations/${explorationId}/submit`, {
      data: {
        forkId: snapshot.forks[0].id,
        globalMessage: `Question ${turn}`,
        id: `answerxd0${turn}`,
        newFork: false,
        fileIds: [],
      },
    });
    await deliverAndAnswer(request, explorationId, `Answer ${turn}.`);
  }
  await detachFakeSession(request);

  await page.goto(`/e/${explorationId}`);
  await expect(page.locator('.message.assistant .answer-index')).toHaveText([
    '[-2]',
    '[-1]',
    '[0]',
  ]);
  await expect(page.locator('.message.user .answer-index')).toHaveCount(0);
});

test('opens a link in an answer to another page of the app without loading the app again', async ({
  page,
  request,
}) => {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'Link me' } })
  ).json();
  await attachFakeSession(request, explorationId);
  await deliverAndAnswer(request, explorationId, `See [the notes](/e/${explorationId}/notes).`);
  await detachFakeSession(request);

  await page.goto(`/e/${explorationId}`);
  await page.evaluate(() => Object.assign(window, { loadedOnce: true }));
  await page.locator('.conversation').getByRole('link', { name: 'the notes' }).click();
  await expect(page).toHaveURL(`/e/${explorationId}/notes`);
  expect(await page.evaluate(() => 'loadedOnce' in window)).toBe(true);
});
