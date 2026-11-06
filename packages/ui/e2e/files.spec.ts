import { expect, type Page } from '@playwright/test';
import { attachFakeSession, deliverAndAnswer, detachFakeSession, test } from './helpers';

// A 1×1 PNG, so the thumbnail really decodes.
const pngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function pasteImage(page: Page, placeholder: string, name: string) {
  await page.getByPlaceholder(placeholder).evaluate(
    (textarea, { base64, name }) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], name, { type: 'image/png' }));
      textarea.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
    },
    { base64: pngBase64, name },
  );
}

test('sends pasted and picked files with a reply, and Claude gets their paths', async ({
  page,
  request,
}) => {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'Look at my files' } })
  ).json();
  await attachFakeSession(request, explorationId);
  await deliverAndAnswer(request, explorationId, 'Send them.');
  await page.goto(`/e/${explorationId}`);

  await pasteImage(page, 'Reply to Claude', 'screenshot.png');
  await page.locator('.reply-bar input[type=file]').setInputFiles([
    { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes') },
    { name: 'archive.zip', mimeType: 'application/zip', buffer: Buffer.from([80, 75, 3, 4, 0]) },
  ]);
  const drafts = page.locator('.reply-bar .file-drafts li');
  await expect(drafts).toHaveCount(3);
  await expect(drafts.filter({ hasText: 'archive.zip' })).toContainText('not an image, a PDF');
  await page.getByRole('button', { name: 'Remove archive.zip' }).click();
  await expect(page.locator('.reply-bar .summary')).toHaveText('2 files');

  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.locator('.queued-submission')).toContainText('2 files');
  await expect(drafts).toHaveCount(0);
  await page.locator('.queued-submission').getByRole('button', { name: 'Cancel' }).click();
  await expect(drafts).toHaveCount(2);

  await page.getByPlaceholder('Reply to Claude').fill('What do these show?');
  await page.getByRole('button', { name: 'Submit' }).click();
  const feedback = JSON.stringify(await deliverAndAnswer(request, explorationId, 'A pixel.'));
  expect(feedback).toMatch(
    /Attached files \(open them with the Read tool\):\\n- \/\S+\/screenshot\.png\\n- \/\S+\/notes\.md/,
  );

  const message = page.locator('.message.user').last();
  const thumbnail = message.locator('.files img');
  await expect(thumbnail).toHaveAttribute('alt', 'screenshot.png');
  await expect
    .poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(1);
  await expect(message.locator('.files a.text')).toHaveText('notes.md');

  await thumbnail.click();
  const viewer = page.getByRole('dialog', { name: 'Image' });
  await expect(viewer.locator('img')).toHaveAttribute('src', /\/api\/files\/\w+/);
  await page.goBack();
  await expect(viewer).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/e/${explorationId}$`));

  await detachFakeSession(request);
});

test('starts a new chat with only a pasted image', async ({ page }) => {
  await page.goto('/');
  await pasteImage(page, 'Start a new chat', 'idea.png');
  await expect(page.locator('.new-exploration .file-drafts li')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Start' })).toBeEnabled();
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.queued-submission')).toContainText('1 file');
});

test('shows an upload in an answer once, in the text', async ({ page, request }) => {
  const png = Buffer.from(pngBase64, 'base64');
  const uploaded = await (
    await request.post('/api/files', {
      multipart: { file: { name: 'shot.png', mimeType: 'image/png', buffer: png } },
    })
  ).json();
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'Show me' } })
  ).json();
  await attachFakeSession(request, explorationId);
  await deliverAndAnswer(
    request,
    explorationId,
    `Here:\n\n![Screenshot](/api/files/${uploaded.id})`,
  );
  await detachFakeSession(request);
  await page.goto(`/e/${explorationId}`);

  const answer = page.locator('.message.assistant');
  await expect(answer.locator('.content img')).toHaveAttribute('src', `/api/files/${uploaded.id}`);
  await expect
    .poll(() =>
      answer.locator('.content img').evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(1);
  await expect(answer.locator('.files')).toHaveCount(0);

  await answer.locator('.content img').click();
  const viewer = page.getByRole('dialog', { name: 'Image' });
  await expect(viewer.locator('img')).toHaveAttribute('src', `/api/files/${uploaded.id}`);
  await expect(page).toHaveURL(new RegExp(`\\?image=${uploaded.id}$`));
  await viewer.getByRole('button', { name: 'Zoom in' }).click();
  await expect(viewer.locator('img')).toHaveAttribute('style', /scale\(1\.5\)/);
  await viewer.locator('.stage').dblclick();
  await expect(viewer.locator('img')).toHaveAttribute('style', /scale\(1\)/);
  await viewer.getByRole('button', { name: 'Back' }).click();
  await expect(viewer).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/e/${explorationId}$`));

  await page.goto(`/e/${explorationId}?image=${uploaded.id}`);
  await viewer.getByRole('button', { name: 'Back' }).click();
  await expect(viewer).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/e/${explorationId}$`));
});
