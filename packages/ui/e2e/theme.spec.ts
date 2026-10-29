import { expect } from '@playwright/test';
import { test } from './helpers';

test.use({ colorScheme: 'light' });

test('switches the theme and keeps it after a reload', async ({ page }) => {
  await page.goto('/');
  const body = page.locator('body');
  await expect(body).toHaveCSS('background-color', 'rgb(251, 251, 250)');

  await page.getByRole('button', { name: 'Theme: System' }).click();
  await page.getByRole('button', { name: 'Theme: Light' }).click();
  await expect(body).toHaveCSS('background-color', 'rgb(22, 22, 21)');
  await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute(
    'content',
    'rgb(22, 22, 21)',
  );

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(body).toHaveCSS('background-color', 'rgb(22, 22, 21)');

  await page.getByRole('button', { name: 'Theme: Dark' }).click();
  await expect(body).toHaveCSS('background-color', 'rgb(251, 251, 250)');
});
