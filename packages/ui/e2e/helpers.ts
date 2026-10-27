import { expect, type Page } from '@playwright/test';

export async function openSeededExploration(page: Page) {
  const explorations: { id: string; title: string }[] = await (
    await page.request.get('/api/explorations')
  ).json();
  const seeded = explorations.find((exploration) => exploration.title === 'Caching API responses')!;
  await page.goto(`/e/${seeded.id}`);
  await expect(page.locator('.message').first()).toBeVisible();
  return seeded.id;
}
