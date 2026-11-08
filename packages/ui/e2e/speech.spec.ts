import { expect, type Locator, type Page } from '@playwright/test';
import { openSeededExploration, seededDraftQuote, tapQuotedText, test } from './helpers';

async function playFrom(page: Page, block: Locator) {
  await block.click();
  await page.getByRole('button', { name: 'Read aloud from here' }).click();
}

test('reads an answer aloud block by block', async ({ page }) => {
  await openSeededExploration(page);
  const answer = page.locator('.message.assistant').first();
  const player = page.getByRole('region', { name: 'Reading aloud' });
  const paragraph = (text: string) => answer.locator('.content p', { hasText: text });

  await playFrom(page, paragraph('In-memory cache'));
  await expect(player.locator('.block-count')).toHaveText('2/5');
  await expect(paragraph('In-memory cache')).toHaveClass('speaking');
  await expect(player.locator('.time')).toHaveText(/^0:00 \/ 0:\d[1-9]$|^0:00 \/ 0:[1-9]\d$/);
  await expect(paragraph('In-memory cache')).toBeInViewport();

  await player.getByRole('button', { name: 'Pause' }).click();
  await expect(player.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  const pausedAt = await player.locator('.time').textContent();
  await page.waitForTimeout(1_500);
  await expect(player.locator('.time')).toHaveText(pausedAt!);
  await player.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(player.getByRole('button', { name: 'Pause' })).toBeVisible();

  await player.getByRole('button', { name: 'Next block', exact: true }).click();
  await expect(player.locator('.block-count')).toHaveText('3/5');
  await expect(paragraph('Shared cache (Redis')).toHaveClass('speaking');
  await expect(paragraph('In-memory cache')).not.toHaveClass('speaking');
  await expect(player.locator('.time')).not.toHaveText('Preparing…');

  await player.getByRole('button', { name: 'Back 5 seconds' }).click();
  await expect(player.locator('.block-count')).toHaveText('2/5');

  const chain = player.getByRole('button', { name: 'Keep reading' });
  await expect(chain).toHaveAttribute('aria-pressed', 'true');
  await chain.click();
  await expect(chain).toHaveAttribute('aria-pressed', 'false');

  const speed = player.getByRole('button', { name: 'Reading speed' });
  await expect(speed).toHaveText('1×');
  await speed.click();
  await expect(speed).toHaveText('1.1×');
  await page.reload();
  await playFrom(page, paragraph('In-memory cache'));
  await expect(player.getByRole('button', { name: 'Reading speed' })).toHaveText('1.1×');

  await player.getByRole('button', { name: 'Stop reading' }).click();
  await expect(player).toHaveCount(0);
  await expect(answer.locator('.speaking')).toHaveCount(0);

  const speechRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/speech')) speechRequests.push(request.url());
  });
  await playFrom(page, paragraph('In-memory cache'));
  await expect(player.locator('.time')).not.toHaveText('Preparing…');
  expect(speechRequests).toEqual([]);
  await player.getByRole('button', { name: 'Stop reading' }).click();

  await page.reload();
  await page
    .locator('.message.assistant')
    .first()
    .getByRole('button', { name: 'Read aloud', exact: true })
    .click();
  await expect(player.locator('.block-count')).toHaveText('1/5');
  await expect(player.getByRole('button', { name: 'Keep reading' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});

test('continues into the next block and stops at the end of the answer', async ({ page }) => {
  await openSeededExploration(page);
  const answer = page.locator('.message.assistant').first();
  const player = page.getByRole('region', { name: 'Reading aloud' });

  await playFrom(page, answer.locator('.content p').nth(3));
  await expect(player.locator('.time')).not.toHaveText('Preparing…');
  const duration = Number((await player.getByRole('slider').getAttribute('max')) ?? 0);
  await player.getByRole('slider').fill(Math.max(0, duration - 1).toFixed(1));
  await expect(player.locator('.block-count')).toHaveText('5/5', { timeout: 10_000 });
  await expect(answer.locator('.content p').last()).toHaveClass('speaking');
  await expect(player).toHaveCount(0, { timeout: 20_000 });
});

test('a tapped block offers a comment on the whole block', async ({ page }) => {
  await openSeededExploration(page);
  const block = page.locator('.message.assistant [data-anchor-root] > p', {
    hasText: 'HTTP caching.',
  });
  const comment = page.getByRole('button', { name: 'Comment', exact: true });

  await block.click({ position: { x: 40, y: 8 } });
  await expect(block).toHaveClass('picked');
  await expect(page.getByRole('button', { name: 'Read aloud from here' })).toBeVisible();
  await block.click({ position: { x: 40, y: 8 } });
  await expect(block).not.toHaveClass('picked');
  await expect(comment).toHaveCount(0);

  await block.click({ position: { x: 40, y: 8 } });
  await comment.click();
  await expect(page.locator('.comment-editor')).toContainText(
    "you can only purge it through the CDN's API.",
  );
  await page.getByPlaceholder('Your comment').fill('Which CDNs?');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('.comment-card.draft', { hasText: 'Which CDNs?' })).toBeVisible();
  await expect(block).not.toHaveClass('picked');
});

test('announces code instead of reading it', async ({ page }) => {
  await openSeededExploration(page);
  const speech = await page.request.post('/api/speech', {
    data: {
      messageId: await page.locator('.message.assistant').first().getAttribute('data-message-id'),
      block: { kind: 'code', language: 'ts', lines: 1 },
    },
  });
  expect(speech.headers()['content-type']).toBe('audio/mp4');
  expect((await speech.body()).subarray(4, 8).toString('ascii')).toBe('ftyp');
});

test('reads aloud what is typed in the reply and in a comment', async ({ page }) => {
  await openSeededExploration(page);
  const player = page.getByRole('region', { name: 'Reading aloud' });
  const reply = page.getByPlaceholder('Reply to Claude');
  const replyBar = page.locator('form', { has: reply });
  await expect(replyBar.getByRole('button', { name: 'Listen' })).toHaveCount(0);

  await reply.fill('First paragraph.\n\nSecond paragraph.');
  await replyBar.getByRole('button', { name: 'Listen' }).click();
  await expect(player.locator('.block-count')).toHaveText('1/2');
  await expect(replyBar.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(reply).toBeFocused();
  await player.getByRole('button', { name: 'Stop reading' }).click();

  const paragraph = page.locator('.message.assistant .content p').first();
  await paragraph.click();
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByPlaceholder('Your comment').fill('Which one is fastest?');
  await page.locator('.comment-editor').getByRole('button', { name: 'Listen' }).click();
  await expect(player.locator('.block-count')).toHaveText('1/1');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('reads aloud a saved comment and the comment being edited', async ({ page }) => {
    await openSeededExploration(page);
    const player = page.getByRole('region', { name: 'Reading aloud' });
    await tapQuotedText(page, seededDraftQuote);
    const card = page.locator('.opened-comments .comment-card.draft');
    await card.getByRole('button', { name: 'Listen' }).click();
    await expect(player.locator('.block-count')).toHaveText('1/1');
    await player.getByRole('button', { name: 'Stop reading' }).click();

    await card.getByRole('button', { name: 'Edit' }).click();
    await card.locator('textarea').fill('First question.\n\nSecond question.');
    await card.getByRole('button', { name: 'Listen' }).click();
    await expect(player.locator('.block-count')).toHaveText('1/2');
  });
});
