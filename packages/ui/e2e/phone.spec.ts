import { expect, test } from '@playwright/test';
import { openSeededExploration } from './helpers';

test('starts a new exploration and reports a Claude that cannot start', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder('Start a new exploration').fill('Why is the sky blue?');
  await page.getByTitle('Model').selectOption('opus');
  await page.getByRole('button', { name: 'Start' }).click();

  await expect(page).toHaveURL(/\/e\/[a-z0-9]+$/);
  await expect(page.locator('.queued-submission')).toContainText('Why is the sky blue?');
  await expect(page.getByRole('alert')).toContainText('Claude could not be started');
  await expect(page.locator('.status select')).toHaveValue('opus');
});

test('changes the model of an exploration', async ({ page }) => {
  await openSeededExploration(page);
  const picker = page.locator('.status select');
  await expect(picker).toHaveValue('sonnet');
  await picker.selectOption('opus');
  await page.reload();
  await expect(page.locator('.status select')).toHaveValue('opus');
  await page.locator('.status select').selectOption('sonnet');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('lists comments under their message and offers a comment for a selection', async ({
    page,
  }) => {
    await openSeededExploration(page);
    const listed = page.locator('.message-comments .comment-card.listed');
    await expect(listed.first()).toBeVisible();
    await expect(page.locator('.comment-layer > .comment-card')).toHaveCount(0);
    await expect(
      page.locator('.message-comments', { hasText: 'Where would the version numbers live?' }),
    ).toContainText('store a version number per entity');

    await page.evaluate(() => {
      const paragraph = [...document.querySelectorAll('.content p')].find((element) =>
        element.textContent?.startsWith('There are three common ways'),
      )!;
      paragraph.scrollIntoView({ block: 'center' });
      const range = document.createRange();
      range.setStart(paragraph.firstChild!, 0);
      range.setEnd(paragraph.firstChild!, 20);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
    await expect(page.getByRole('button', { name: 'Comment', exact: true })).toBeVisible();
  });
});
