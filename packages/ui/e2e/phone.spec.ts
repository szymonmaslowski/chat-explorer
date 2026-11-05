import { expect } from '@playwright/test';
import { openSeededExploration, test } from './helpers';

test('starts a new exploration and reports a Claude that cannot start', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder('Start a new chat').fill('Why is the sky blue?');
  await page.getByTitle('Model').selectOption('opus');
  await page.getByRole('button', { name: 'Start' }).click();

  await expect(page).toHaveURL(/\/e\/[a-z0-9]+$/);
  await expect(page.locator('.queued-submission')).toContainText('Why is the sky blue?');
  await expect(page.getByRole('alert')).toContainText('Claude could not be started');
  const explorationId = page.url().split('/').at(-1);
  const snapshot = await (await page.request.get(`/api/explorations/${explorationId}`)).json();
  expect(snapshot.exploration.model).toBe('opus');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('lists comments under their message and offers a comment for a selection', async ({
    page,
  }) => {
    await openSeededExploration(page);
    await expect(page.getByRole('link', { name: 'Map' })).toBeInViewport();
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

  test('wraps a long unbroken word instead of scrolling the page sideways', async ({ page }) => {
    await openSeededExploration(page);
    await page.evaluate(() => {
      const paragraph = document.createElement('p');
      paragraph.innerHTML =
        '<code>speechTranscriberWithAVeryLongNameAndNoPlaceToBreakTheLine.ts</code>';
      document.querySelector('.content')!.append(paragraph);
    });
    const pageWidths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(pageWidths.scroll).toBe(pageWidths.client);
  });

  test('shrinks a large image in an answer to fit the screen', async ({ page }) => {
    await openSeededExploration(page);
    await page.evaluate(() => {
      const image = document.createElement('img');
      image.src =
        'data:image/svg+xml,' +
        encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="700"/>');
      document.querySelector('.message.assistant .content')!.append(image);
    });
    const pageWidths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(pageWidths.scroll).toBe(pageWidths.client);
  });

  test('scrolls from a listed comment to the text it quotes', async ({ page }) => {
    await openSeededExploration(page);
    const card = page.locator('.message-comments .comment-card.listed').first();
    await card.scrollIntoViewIfNeeded();
    const quote = (await card.locator('.quoted').textContent())!;
    await card.locator('button.quote').tap();

    const flashedTop = () =>
      page.evaluate(() => {
        const flash = CSS.highlights.get('comment-flash');
        const range = flash && ([...flash][0] as Range | undefined);
        return range ? { text: range.toString(), top: range.getBoundingClientRect().top } : null;
      });
    await expect.poll(async () => (await flashedTop())?.text).toBe(quote);
    await expect
      .poll(async () => {
        const top = (await flashedTop())?.top ?? -1;
        return top > 0 && top < 844;
      })
      .toBe(true);
  });
});
