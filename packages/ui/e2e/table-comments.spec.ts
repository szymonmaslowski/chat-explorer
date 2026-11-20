import { expect } from '@playwright/test';
import { attachFakeSession, deliverAndAnswer, detachFakeSession, test } from './helpers';

const answer = [
  'Round 1 passed in every fork.',
  '| Step | Time in each fork |\n| --- | --- |\n| clone | 1 to 2 s |\n| pnpm install | 13 to 33 s |',
  'Nothing was killed.',
].join('\n\n');

test.use({ viewport: { width: 390, height: 844 } });

test('the card of a comment on a table cell shows its quote, one on a paragraph does not', async ({
  page,
  request,
}) => {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'How did the test go?' } })
  ).json();
  await attachFakeSession(request, explorationId);
  await deliverAndAnswer(request, explorationId, answer);
  await detachFakeSession(request);
  await page.goto(`/e/${explorationId}`);
  const message = page.locator('.message.assistant');

  const comment = async (quoted: string, body: string) => {
    await page.evaluate((text) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const at = node.data.indexOf(text);
        if (at === -1) continue;
        node.parentElement!.scrollIntoView({ block: 'center' });
        window.getSelection()!.setBaseAndExtent(node, at, node, at + text.length);
        return;
      }
      throw new Error(`"${text}" not found`);
    }, quoted);
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    // The editor shows the quote while the comment is written.
    await expect(page.locator('.comment-editor .quote')).toHaveText(quoted);
    await page.getByPlaceholder('Your comment').fill(body);
    await page.keyboard.press('ControlOrMeta+Enter');
  };

  await comment('13 to 33 s', 'Why so slow?');
  await comment('Round 1', 'Which round?');

  const cellCard = message.locator('.comment-card', { hasText: 'Why so slow?' });
  await expect(cellCard).toBeVisible();
  await expect(cellCard.locator('.quote')).toHaveText(/13 to 33 s/);
  await expect(message.locator('table tr')).toHaveCount(3);
  await expect(message.locator('table .comment-card')).toHaveCount(0);

  const paragraphCard = message.locator('.comment-card', { hasText: 'Which round?' });
  await expect(paragraphCard).toBeVisible();
  await expect(paragraphCard.locator('.quote')).toHaveCount(0);

  await cellCard.locator('.quote').click();
  await expect(message.locator('td', { hasText: '13 to 33 s' })).toBeInViewport();
});
