import { expect, type Page } from '@playwright/test';
import {
  answeredChat,
  attachFakeSession,
  clickQuotedText,
  deliverAndAnswer,
  detachFakeSession,
  selectAnswer,
  test,
} from './helpers';

const saved = (page: Page, path: string) =>
  page.waitForResponse(
    (response) => response.url().includes(path) && response.request().method() !== 'GET',
  );

test('keeps the reply box, its fork tick and its files through a reload', async ({
  page,
  request,
}) => {
  await page.goto(`/e/${await answeredChat(request)}`);
  const reply = page.getByPlaceholder('Reply to Claude');
  await page.locator('.reply-bar input[type=file]').setInputFiles({
    name: 'notes.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Notes'),
  });
  await expect(page.locator('.reply-bar .file-drafts li')).not.toContainText('Uploading');
  await page.getByLabel('New fork').check();
  const save = saved(page, '/reply-draft');
  await reply.fill('Half a thought');
  await save;

  await page.reload();
  await expect(reply).toHaveValue('Half a thought');
  await expect(page.getByLabel('New fork')).toBeChecked();
  await expect(page.locator('.reply-bar .file-drafts li')).toHaveText(/notes\.md/);

  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.locator('.queued-submission')).toBeVisible();
  await page.reload();
  await expect(reply).toHaveValue('');
  await expect(page.locator('.reply-bar .file-drafts li')).toHaveCount(0);
});

test('reopens an unsaved new comment in its editor, and Cancel deletes it', async ({
  page,
  request,
}) => {
  await page.goto(`/e/${await answeredChat(request)}`);
  await selectAnswer(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const created = saved(page, '/comments');
  await page.getByPlaceholder('Your comment').fill('Not finished');
  await created;

  await page.reload();
  const card = page.locator('.comment-card', { has: page.locator('textarea') });
  await expect(card.locator('textarea')).toHaveValue('Not finished');
  await expect(page.locator('.reply-bar .summary')).toHaveText('1 comment being edited');
  await expect(page.getByRole('button', { name: 'Submit' })).toBeDisabled();

  await card.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.comment-card')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.comment-card')).toHaveCount(0);
});

test('keeps an edit of a saved comment apart from its saved text until Save', async ({
  page,
  request,
}) => {
  await page.goto(`/e/${await answeredChat(request)}`);
  await selectAnswer(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByPlaceholder('Your comment').fill('First version');
  await page.keyboard.press('ControlOrMeta+Enter');
  const card = page.locator('.comment-card.draft');
  await expect(card).toContainText('First version');
  await expect(page.locator('.reply-bar .summary')).toHaveText('1 comment');

  // A card fades while the cursor is near it, and the new one appears where the cursor is.
  await page.mouse.move(0, 0);
  await card.hover();
  await card.getByRole('button', { name: 'Edit' }).click();
  const edited = saved(page, '/api/comments/');
  await card.locator('textarea').fill('Second version');
  await edited;
  await page.reload();
  await expect(card.locator('textarea')).toHaveValue('Second version');
  await expect(page.locator('.reply-bar .summary')).toHaveText('1 comment being edited');

  await card.getByRole('button', { name: 'Cancel' }).click();
  await expect(card).toContainText('First version');
  await expect(page.locator('.reply-bar .summary')).toHaveText('1 comment');

  // A card fades while the cursor is near it, and the new one appears where the cursor is.
  await page.mouse.move(0, 0);
  await card.hover();
  await card.getByRole('button', { name: 'Edit' }).click();
  await card.locator('textarea').fill('Third version');
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await page.reload();
  await clickQuotedText(page, 'Caching');
  await expect(card).toContainText('Third version');
  await expect(card.locator('textarea')).toHaveCount(0);
});

test('links to a comment being edited from the reply bar', async ({ page, request }) => {
  const paragraphs = Array.from(
    { length: 30 },
    (_, index) => `Paragraph ${index + 1} of the answer.`,
  );
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'Explain it at length' } })
  ).json();
  await attachFakeSession(request, explorationId);
  await deliverAndAnswer(request, explorationId, paragraphs.join('\n\n'));
  await detachFakeSession(request);
  await page.goto(`/e/${explorationId}`);
  await page.locator('.message.assistant .content p').nth(9).scrollIntoViewIfNeeded();
  await selectAnswer(page, 9);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByPlaceholder('Your comment').fill('Still thinking');
  await page.keyboard.press('ControlOrMeta+Enter');
  const card = page.locator('.comment-card.draft');
  await card.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await page.mouse.move(0, 0);
  await card.hover();
  await card.getByRole('button', { name: 'Edit' }).click();

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(card.locator('textarea')).toHaveValue('Still thinking');
  await expect(card).not.toBeInViewport();

  await page
    .locator('.reply-bar .summary')
    .getByRole('link', { name: '1 comment being edited' })
    .click();
  await expect(card).toBeInViewport();
  await card.getByRole('button', { name: 'Cancel' }).click();
});

test('expands a long comment to read it whole, and offers nothing to expand on a short one', async ({
  page,
  request,
}) => {
  const explorationId = await answeredChat(request);
  await page.goto(`/e/${explorationId}`);
  const longComment = Array.from({ length: 12 }, (_, index) => `Line ${index + 1}`).join('\n');
  await selectAnswer(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByPlaceholder('Your comment').fill(longComment);
  await page.keyboard.press('ControlOrMeta+Enter');

  const card = page.locator('.comment-card.draft');
  const body = card.locator('.body');
  const bodyHeight = () => body.evaluate((element) => element.clientHeight);
  const fullHeight = await body.evaluate((element) => element.scrollHeight);
  await expect(card.getByRole('button', { name: 'Expand' })).toBeVisible();
  const clippedHeight = await bodyHeight();
  expect(clippedHeight).toBeLessThan(fullHeight);

  // Expanded, the card takes the free space and its body scrolls when it is still too long.
  await card.getByRole('button', { name: 'Expand' }).click();
  await expect(card).toHaveClass(/expanded/);
  expect(await bodyHeight()).toBeGreaterThan(clippedHeight);
  expect(await body.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto');
  await card.getByRole('button', { name: 'Shrink' }).click();
  await expect(card).not.toHaveClass(/expanded/);

  await card.getByRole('button', { name: 'Edit' }).click();
  await card.locator('textarea').fill('Short');
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(body).toHaveText('Short');
  await expect(card.getByRole('button', { name: 'Expand' })).toHaveCount(0);
});

test('saves the reply box text as a general comment, sent with the next Submit', async ({
  page,
  request,
}) => {
  const explorationId = await answeredChat(request);
  await page.goto(`/e/${explorationId}`);
  const reply = page.getByPlaceholder('Reply to Claude');
  const saveAsComment = page.getByRole('button', { name: 'Save as comment' });
  await expect(saveAsComment).toBeDisabled();

  await reply.fill('Keep the answers short');
  await saveAsComment.click();
  await expect(reply).toHaveValue('');
  const card = page.locator('.comment-card.draft', { hasText: 'Keep the answers short' });
  await expect(card).toBeVisible();
  await expect(card.locator('.quote')).toHaveCount(0);
  await expect(page.locator('.comment-outlines path')).toHaveCount(0);
  const lastLine = (await page.locator('.message.assistant .content p').last().boundingBox())!;
  const cardBox = (await card.boundingBox())!;
  expect(cardBox.y).toBeGreaterThan(lastLine.y + lastLine.height);

  await reply.fill('Save this for later');
  await reply.press('ControlOrMeta+Shift+Enter');
  const noteCard = page.locator('.comment-card.draft', { hasText: 'Save this for later' });
  await noteCard.getByRole('button', { name: 'Save as note' }).click();
  await expect(noteCard).toHaveClass(/note/);
  await expect(page.locator('.reply-bar .summary')).toHaveText('1 note, 1 comment');

  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.locator('.queued-submission')).toBeVisible();
  await page.goto(`/e/${explorationId}/notes`);
  await expect(page.locator('.note .description')).toContainText('Save this for later');
});

test('shows and hides every draft in the text from the menu above the reply box', async ({
  page,
  request,
}) => {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'Explain caching' } })
  ).json();
  await attachFakeSession(request, explorationId);
  const answer = 'Alpha paragraph here.\n\nBravo paragraph here.';
  await deliverAndAnswer(request, explorationId, answer);
  await detachFakeSession(request);
  const snapshot = await (await request.get(`/api/explorations/${explorationId}`)).json();
  const message = snapshot.messages.at(-1);
  for (const [quote, startOffset] of [
    ['Alpha', 0],
    ['Bravo', 21],
  ] as const) {
    await request.post(`/api/explorations/${explorationId}/comments`, {
      data: {
        messageId: message.id,
        viewForkId: message.forkId,
        quote,
        startOffset,
        endOffset: startOffset + quote.length,
        body: `About ${quote}`,
      },
    });
  }
  await page.goto(`/e/${explorationId}`);
  const cards = page.locator('.opened-comments .comment-card');
  await expect(page.locator('.comment-outlines path')).toHaveCount(2);
  await expect(cards).toHaveCount(0);

  await page.getByRole('button', { name: 'Drafts' }).click();
  await page.getByRole('menuitem', { name: 'Show all drafts' }).click();
  await expect(cards).toHaveText([/About Alpha/, /About Bravo/]);
  await expect(page.getByRole('menuitem')).toHaveCount(0);

  await page.getByRole('button', { name: 'Drafts' }).click();
  await page.getByRole('menuitem', { name: 'Hide all drafts' }).click();
  await expect(cards).toHaveCount(0);
  await expect(page.locator('[data-inserted]')).toHaveCount(0);
});

test('opens every comment on the clicked text after its own quote', async ({ page, request }) => {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'Explain caching' } })
  ).json();
  await attachFakeSession(request, explorationId);
  const answer = 'First sentence here. Middle sentence here. Last sentence here.';
  await deliverAndAnswer(request, explorationId, answer);
  await detachFakeSession(request);
  const snapshot = await (await request.get(`/api/explorations/${explorationId}`)).json();
  const message = snapshot.messages.at(-1);
  for (const [quote, body] of [
    [answer, 'About the section'],
    ['Middle sentence here.', 'About the middle'],
  ] as const) {
    const startOffset = answer.indexOf(quote);
    await request.post(`/api/explorations/${explorationId}/comments`, {
      data: {
        messageId: message.id,
        viewForkId: message.forkId,
        quote,
        startOffset,
        endOffset: startOffset + quote.length,
        body,
      },
    });
  }
  await page.goto(`/e/${explorationId}`);
  await clickQuotedText(page, 'Middle sentence');

  const order = await page.evaluate(() => {
    const content = document.querySelector('.message.assistant [data-anchor-root]')!;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const seen: string[] = [];
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent!;
      if (text.includes('Last sentence')) seen.push('last sentence');
      if (text.includes('About the middle')) seen.push('middle card');
      if (text.includes('About the section')) seen.push('section card');
    }
    return seen;
  });
  expect(order).toEqual(['middle card', 'last sentence', 'section card']);
});
