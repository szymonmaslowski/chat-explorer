import { expect, test } from '@playwright/test';
import { openSeededExploration } from './helpers';

test('reads an answer aloud block by block', async ({ page }) => {
  await openSeededExploration(page);
  const answer = page.locator('.message.assistant').first();
  const player = page.getByRole('region', { name: 'Reading aloud' });
  const paragraph = (text: string) => answer.locator('.content p', { hasText: text });

  await answer.getByRole('button', { name: 'Read aloud from block 2' }).click();
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
  await expect(player.locator('.time')).not.toHaveText('…');

  await player.getByRole('button', { name: 'Back 5 seconds' }).click();
  await expect(player.locator('.block-count')).toHaveText('2/5');

  const chain = player.getByRole('button', { name: 'Keep reading' });
  await expect(chain).toHaveAttribute('aria-pressed', 'true');
  await chain.click();
  await expect(chain).toHaveAttribute('aria-pressed', 'false');

  await player.getByRole('button', { name: 'Stop reading' }).click();
  await expect(player).toHaveCount(0);
  await expect(answer.locator('.speaking')).toHaveCount(0);

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

  await answer.getByRole('button', { name: 'Read aloud from block 4' }).click();
  await expect(player.locator('.time')).not.toHaveText('…');
  const duration = Number((await player.getByRole('slider').getAttribute('max')) ?? 0);
  await player.getByRole('slider').fill(Math.max(0, duration - 1).toFixed(1));
  await expect(player.locator('.block-count')).toHaveText('5/5', { timeout: 10_000 });
  await expect(answer.locator('.content p').last()).toHaveClass('speaking');
  await expect(player).toHaveCount(0, { timeout: 20_000 });
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
