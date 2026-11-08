import {
  test as base,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';

// The page shows a change before the daemon has it. Each test waits until its changes are sent,
// so the next one starts from what the daemon really holds.
export const test = base.extend<{ sentChanges: void }>({
  sentChanges: [
    async ({ page }, use) => {
      await use();
      await expect
        .poll(() =>
          page
            .evaluate(
              () =>
                JSON.parse(localStorage.getItem('chat-explorer.outbox') ?? '{"queue":[]}').queue
                  .length,
            )
            .catch(() => 0),
        )
        .toBe(0);
    },
    { auto: true },
  ],
});

export async function openSeededExploration(page: Page) {
  const explorations: { id: string; title: string }[] = await (
    await page.request.get('/api/explorations')
  ).json();
  const seeded = explorations.find((exploration) => exploration.title === 'Caching API responses')!;
  await page.goto(`/e/${seeded.id}`);
  await expect(page.locator('.message').first()).toBeVisible();
  return seeded.id;
}

// Quoted comments open with a tap or a click on the text they quote.
export async function tapQuotedText(page: Page, quote: string) {
  const point = await quotedTextPoint(page, quote);
  await page.touchscreen.tap(point.x, point.y);
}

export async function clickQuotedText(page: Page, quote: string) {
  const point = await quotedTextPoint(page, quote);
  await page.mouse.click(point.x, point.y);
}

async function quotedTextPoint(page: Page, quote: string) {
  await page.waitForFunction((text) => document.body.innerText.includes(text), quote);
  return page.evaluate((text) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const at = node.data.indexOf(text);
      if (at === -1 || node.parentElement?.closest('[data-inserted]')) continue;
      node.parentElement!.scrollIntoView({ block: 'center' });
      const range = document.createRange();
      range.setStart(node, at + 2);
      range.setEnd(node, at + 3);
      const box = range.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }
    throw new Error(`"${text}" not found`);
  }, quote);
}

export const seededDraftQuote = 'store a version number per entity';

export async function chooseCommentType(scope: Page | Locator, label: 'Comment' | 'Fork' | 'Note') {
  await scope.getByRole('button', { name: /^Type:/ }).click();
  await scope.getByRole('menuitemradio', { name: label }).click();
  await expect(scope.getByRole('menuitemradio')).toHaveCount(0);
  await expect(scope.getByRole('button', { name: `Type: ${label}` })).toBeVisible();
}

export const shimId = 'e2e-shim';

// Stands in for Claude: attaches like the MCP shim does, takes the queued feedback and answers.
export async function attachFakeSession(request: APIRequestContext, explorationId: string) {
  await request.post(`/api/internal/explorations/${explorationId}/attach`, {
    data: { shimId, sessionId: 'e2e-session', takeover: true },
  });
}

export async function deliverAndAnswer(
  request: APIRequestContext,
  explorationId: string,
  answer: string,
) {
  const feedback = await (
    await request.post(`/api/internal/explorations/${explorationId}/feedback`, {
      data: { shimId, waitMs: 1_000 },
    })
  ).json();
  const snapshot = await (await request.get(`/api/explorations/${explorationId}`)).json();
  const tip = snapshot.messages.at(-1);
  await request.post(`/api/internal/forks/${tip.forkId}/messages`, {
    data: { shimId, inReplyTo: tip.id, content: answer },
  });
  return feedback;
}

export const detachFakeSession = (request: APIRequestContext) =>
  request.post('/api/internal/detach', { data: { shimId } });

// The reply box is saved on the daemon, so a test that types into a shared chat empties it again.
export async function clearReply(page: Page) {
  const saved = page.waitForResponse(
    (response) => response.url().endsWith('/reply-draft') && response.request().method() === 'PUT',
  );
  await page.getByPlaceholder('Reply to Claude').fill('');
  await saved;
}

export async function answeredChat(request: APIRequestContext) {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'Explain caching' } })
  ).json();
  await attachFakeSession(request, explorationId);
  await deliverAndAnswer(request, explorationId, 'Caching keeps a copy of a response nearby.');
  await detachFakeSession(request);
  return explorationId as string;
}

// Selects the first word of the answer, as a reader dragging over it would.
export async function selectAnswer(page: Page, paragraphIndex = 0) {
  await page
    .locator('.message.assistant .content p')
    .nth(paragraphIndex)
    .evaluate((paragraph) => {
      const range = document.createRange();
      range.setStart(paragraph.firstChild!, 0);
      range.setEnd(paragraph.firstChild!, 7);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
}
