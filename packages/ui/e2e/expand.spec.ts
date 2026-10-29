import { expect, test, type Locator, type Page } from '@playwright/test';
import { clearReply, openSeededExploration } from './helpers';

const shots = process.env.EXPAND_SHOTS;

async function freeSpace(page: Page) {
  const header = await page.locator('[data-sticky-header]').boundingBox();
  return page.viewportSize()!.height - header!.y - header!.height;
}

async function heightOf(locator: Locator) {
  return (await locator.boundingBox())!.height;
}

async function selectFirstParagraph(page: Page) {
  await page
    .locator('.message.assistant .content p')
    .first()
    .evaluate((paragraph) => {
      const range = document.createRange();
      range.setStart(paragraph.firstChild!, 0);
      range.setEnd(paragraph.firstChild!, 7);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
}

test('expands the reply box into the free space and back', async ({ page }) => {
  await openSeededExploration(page);
  const reply = page.getByPlaceholder('Reply to Claude');
  await reply.fill('A long thought');
  const collapsed = await heightOf(reply);

  await page.locator('.reply-bar').getByRole('button', { name: 'Expand' }).click();
  await expect(reply).toBeFocused();
  expect(await heightOf(page.locator('.reply-bar'))).toBeCloseTo(await freeSpace(page), -1);
  if (shots) await page.screenshot({ path: `${shots}/reply-expanded.png` });

  await page.locator('.reply-bar').getByRole('button', { name: 'Shrink' }).click();
  expect(await heightOf(reply)).toBeCloseTo(collapsed, 0);
  await clearReply(page);
});

test('expands a comment being written between the header and the reply box', async ({ page }) => {
  await openSeededExploration(page);
  await selectFirstParagraph(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const editor = page.locator('.comment-editor');
  await editor.getByRole('button', { name: 'Expand' }).click();

  const header = (await page.locator('[data-sticky-header]').boundingBox())!;
  const dock = (await page.locator('[data-dock]').boundingBox())!;
  const box = (await editor.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(header.y + header.height);
  expect(box.y + box.height).toBeLessThanOrEqual(dock.y);
  expect(box.height).toBeGreaterThan((dock.y - header.y - header.height) * 0.9);
  if (shots) await page.screenshot({ path: `${shots}/comment-expanded.png` });
  await editor.getByRole('button', { name: 'Cancel' }).click();
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('expands the reply box to the full width of the page', async ({ page }) => {
    await openSeededExploration(page);
    await page.getByPlaceholder('Reply to Claude').fill('From the phone');
    await page.locator('.reply-bar').getByRole('button', { name: 'Expand' }).click();
    expect(await heightOf(page.locator('.reply-bar'))).toBeCloseTo(await freeSpace(page), -1);
    if (shots) await page.screenshot({ path: `${shots}/reply-expanded-phone.png` });
    await page.locator('.reply-bar').getByRole('button', { name: 'Shrink' }).click();
    await clearReply(page);
  });
});
