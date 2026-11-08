import { expect, type APIRequestContext } from '@playwright/test';
import {
  attachFakeSession,
  deliverAndAnswer,
  detachFakeSession,
  openSeededExploration,
  seededDraftQuote,
  tapQuotedText,
  test,
} from './helpers';

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

  test('outlines quoted text, lists no quoted comments and offers a comment for a selection', async ({
    page,
  }) => {
    await openSeededExploration(page);
    await expect(page.getByRole('link', { name: 'Map' })).toBeInViewport();
    await expect(page.locator('.comment-outlines path').first()).toBeAttached();
    await expect(page.locator('.message-comments .comment-card')).toHaveCount(0);
    await expect(page.locator('.comment-layer > .comment-card')).toHaveCount(0);

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

  test('opens the comments on tapped text inside it until they are closed', async ({ page }) => {
    await openSeededExploration(page);
    const opened = page.locator('.opened-comments .comment-card');

    await tapQuotedText(page, seededDraftQuote);
    await expect(opened.filter({ hasText: 'Where would the version numbers live?' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Comment', exact: true })).toBeVisible();

    await tapQuotedText(page, seededDraftQuote);
    await expect(page.getByRole('button', { name: 'Comment', exact: true })).toHaveCount(0);
    await expect(opened).toHaveCount(1);

    await opened.getByRole('button', { name: 'Close' }).click();
    await expect(opened).toHaveCount(0);
    await expect(page.locator('[data-inserted]')).toHaveCount(0);
  });

  test('writes a comment in the text after its quote and shows it there once saved', async ({
    page,
    request,
  }) => {
    const explorationId = await startAnsweredChat(
      request,
      'Use Redis.\n\nKeep the cache keys short.\n\nExpire them after an hour.',
    );
    await page.goto(`/e/${explorationId}`);
    await page.getByText('Keep the cache keys short.').tap();
    await page.getByRole('button', { name: 'Comment', exact: true }).click();

    const opened = page.locator('.opened-comments');
    const editor = opened.locator('.comment-editor');
    await expect(editor).toBeVisible();
    const order = await page.evaluate(() => {
      const top = (element: Element | null) => element!.getBoundingClientRect().top;
      const paragraph = (text: string) =>
        [...document.querySelectorAll('[data-anchor-root] > p')].find(
          (element) => element.firstChild?.textContent === text,
        ) ?? null;
      return [
        top(paragraph('Keep the cache keys short.')),
        top(document.querySelector('.opened-comments .comment-editor')),
        top(paragraph('Expire them after an hour.')),
      ];
    });
    expect(order).toEqual([...order].sort((first, second) => first - second));

    await editor.locator('textarea').fill('Why short?');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor).toHaveCount(0);
    await expect(opened.locator('.comment-card')).toContainText('Why short?');

    await opened.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('[data-inserted]')).toHaveCount(0);
  });

  test('keeps several new comments open and hides the reply box while typing one', async ({
    page,
    request,
  }) => {
    const explorationId = await startAnsweredChat(
      request,
      'Use Redis.\n\nKeep the cache keys short.\n\nExpire them after an hour.',
    );
    await page.goto(`/e/${explorationId}`);
    const replyBox = page.getByPlaceholder('Reply to Claude');
    await expect(replyBox).toBeVisible();

    await page.getByText('Use Redis.').tap();
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(page.locator('.comment-editor textarea')).toBeFocused();
    await expect(replyBox).toBeHidden();

    await page.getByText('Expire them after an hour.').tap();
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(page.locator('.opened-comments .comment-editor')).toHaveCount(2);

    await page.locator('.comment-editor').first().getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('.comment-editor')).toHaveCount(1);
    await page.locator('.comment-editor').getByRole('button', { name: 'Cancel' }).click();
    await expect(replyBox).toBeVisible();
  });

  test('puts the block buttons between the text and full-width comments', async ({
    page,
    request,
  }) => {
    const answer = [
      'Use Redis.',
      '- Keep the cache keys short and expire them after an hour.',
      ...Array.from(
        { length: 8 },
        () => 'A later paragraph keeps the reply box away from the card.',
      ),
    ].join('\n\n');
    const explorationId = await startAnsweredChat(request, answer);
    const snapshot = await (await request.get(`/api/explorations/${explorationId}`)).json();
    const message = snapshot.messages.at(-1);
    const quote = 'expire them after an hour.';
    const startOffset = answer.replaceAll('\n\n', '').indexOf(quote);
    await request.post(`/api/explorations/${explorationId}/comments`, {
      data: {
        messageId: message.id,
        viewForkId: message.forkId,
        quote,
        startOffset,
        endOffset: startOffset + quote.length,
        body: 'Why an hour?',
      },
    });

    await page.goto(`/e/${explorationId}`);
    await expect(page.locator('.comment-outlines path')).toHaveCount(1);
    await tapQuotedText(page, quote);
    const messageBox = (await page.locator('[data-anchor-root]').last().boundingBox())!;
    const card = (await page.locator('.opened-comments .comment-card').boundingBox())!;
    const actions = page.locator('.opened-comments .selection-actions');
    const actionsBox = (await actions.boundingBox())!;
    expect(actionsBox.y + actionsBox.height).toBeLessThanOrEqual(card.y);
    expect(card.x).toBeCloseTo(messageBox.x, 0);
    expect(card.width).toBeCloseTo(messageBox.width, 0);
    const labels = await actions
      .getByRole('button')
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
    expect(labels).toEqual(['Bookmark', 'Copy this block', 'Read aloud from here', 'Comment']);
  });
});

async function startAnsweredChat(request: APIRequestContext, answer: string) {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'How do I cache responses?' } })
  ).json();
  await attachFakeSession(request, explorationId);
  await deliverAndAnswer(request, explorationId, answer);
  await detachFakeSession(request);
  return explorationId as string;
}
