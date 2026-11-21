import { expect } from '@playwright/test';
import { attachFakeSession, deliverAndAnswer, detachFakeSession, test } from './helpers';

const answer = [
  'Round 1 passed in every fork.',
  '| Step | Time in each fork |\n| --- | --- |\n| clone | 1 to 2 s |\n| pnpm install | 13 to 33 s |',
  'Nothing was killed.',
].join('\n\n');

test.use({ viewport: { width: 390, height: 844 } });

test('the card of a comment on a table cell sits in the table right under its row', async ({
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
  await expect(message.locator('table')).toBeVisible();

  const comment = async (quoted: string, body: string) => {
    await page.evaluate((text) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const at = node.data.indexOf(text);
        if (at === -1) continue;
        node.parentElement!.scrollIntoView({ block: 'center' });
        window.getSelection()!.setBaseAndExtent(node, at, node, at + text.length);
        node.parentElement!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
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

  const table = message.locator('table');
  const cellCard = table.locator('.comment-card', { hasText: 'Why so slow?' });
  await expect(cellCard).toBeVisible();
  // Right under the quoted cell's row, in a row of its own, with all the rows still there.
  await expect(table.locator('tr')).toHaveCount(4);
  const cell = table.locator('td', { hasText: '13 to 33 s' });
  const [cellBox, cardBox, tableBox] = [
    (await cell.boundingBox())!,
    (await cellCard.boundingBox())!,
    (await table.boundingBox())!,
  ];
  expect(cardBox.y).toBeGreaterThanOrEqual(cellBox.y + cellBox.height - 1);
  expect(cardBox.y - (cellBox.y + cellBox.height)).toBeLessThan(24);
  // The card needs no quote next to its text, and is as wide as the table shows, no wider.
  await expect(cellCard.locator('.quote')).toHaveCount(0);
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(tableBox.x + tableBox.width + 1);
  // The table does not widen the page.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  const paragraphCard = message.locator('.comment-card', { hasText: 'Which round?' });
  await expect(paragraphCard).toBeVisible();
  await expect(paragraphCard.locator('.quote')).toHaveCount(0);
  await expect(table.locator('.comment-card')).toHaveCount(1);

  // Closing the card takes its row out.
  await cellCard.getByRole('button', { name: 'Close' }).click();
  await expect(table.locator('tr')).toHaveCount(3);
});
