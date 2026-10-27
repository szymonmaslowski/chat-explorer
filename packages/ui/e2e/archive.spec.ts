import { expect, test } from '@playwright/test';

test('archives, restores and deletes an exploration', async ({ page }) => {
  const response = await page.request.post('/api/explorations', {
    data: { message: 'What is a monad?' },
  });
  const { explorationId } = await response.json();
  const item = page.locator('.exploration', { hasText: explorationId });

  await page.goto('/');
  await item.getByRole('button', { name: 'Archive' }).click();
  await expect(item).toHaveCount(0);

  await page.getByRole('link', { name: 'Archived' }).click();
  await expect(page.getByRole('heading', { name: 'Archived' })).toBeVisible();
  await expect(item).toBeVisible();

  await page.goto(`/e/${explorationId}`);
  await expect(page.getByText('Archived, read only.')).toBeVisible();
  await expect(page.getByPlaceholder('Reply to Claude')).toHaveCount(0);
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText('Archived, read only.')).toHaveCount(0);
  await expect(page.getByPlaceholder('Reply to Claude')).toBeVisible();

  await page.goto('/');
  await item.getByRole('button', { name: 'Archive' }).click();
  await page.goto('/archived');
  await item.getByRole('button', { name: 'Delete' }).click();
  await item.getByRole('button', { name: 'Keep' }).click();
  await item.getByRole('button', { name: 'Delete' }).click();
  await item.getByRole('button', { name: 'Delete' }).click();
  await expect(item).toHaveCount(0);

  await page.reload();
  await expect(page.getByText('Nothing archived.')).toBeVisible();
  await page.goto(`/e/${explorationId}`);
  await expect(page.getByText('This exploration does not exist.')).toBeVisible();
});
