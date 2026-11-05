import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { answeredChat, attachFakeSession, detachFakeSession, selectAnswer, test } from './helpers';

async function newChat(request: APIRequestContext) {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message: 'Plan the week' } })
  ).json();
  return explorationId as string;
}

async function addNote(page: Page, topic: string, description = '') {
  await page.getByRole('button', { name: '+ New note' }).click();
  await page.getByLabel('Topic').fill(topic);
  await page.getByLabel('Topic').press('Enter');
  await expect(page.getByLabel('Description')).toBeFocused();
  if (description) await page.getByLabel('Description').fill(description);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
}

const topics = (page: Page) => page.locator('.note .topic');

test('adds, edits and deletes notes, starting the General group', async ({ page, request }) => {
  const explorationId = await newChat(request);
  await page.goto(`/e/${explorationId}`);
  await page.getByRole('link', { name: 'Notes' }).click();
  await expect(page).toHaveURL(`/e/${explorationId}/notes`);
  await expect(page.getByText('No notes yet.')).toBeVisible();

  await page.getByRole('button', { name: '+ New note' }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel' }).click();

  await addNote(page, 'Milk', 'Two litres, **1.5%**');
  await expect(page.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
  await expect(topics(page)).toHaveText(['Milk']);
  await expect(page.locator('.note .description strong')).toHaveText('1.5%');

  await page.getByRole('button', { name: '+ New note' }).click();
  await page.getByLabel('Description').fill('Only a description');
  await page.getByLabel('Description').press('Meta+Enter');
  await expect(topics(page)).toHaveText(['Preparing topic…', 'Milk']);

  await page.locator('.note', { hasText: 'Milk' }).click();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Topic').fill('Oat milk');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(topics(page)).toHaveText(['Preparing topic…', 'Oat milk']);

  const oatMilk = page.locator('.note', { hasText: 'Oat milk' });
  await oatMilk.click();
  await expect(oatMilk).toHaveClass(/selected/);
  await oatMilk.locator('.topic').click();
  await expect(oatMilk).not.toHaveClass(/selected/);
  await oatMilk.click();
  await page.mouse.click(10, 650);
  await expect(oatMilk).not.toHaveClass(/selected/);
  await oatMilk.click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(topics(page)).toHaveText(['Preparing topic…']);

  await page.reload();
  await expect(topics(page)).toHaveText(['Preparing topic…']);
});

test('creates groups, moves notes between them and deletes a group', async ({ page, request }) => {
  const explorationId = await newChat(request);
  await page.goto(`/e/${explorationId}/notes`);
  await addNote(page, 'Bread');
  await addNote(page, 'Eggs');

  await page.getByRole('button', { name: '+ Group' }).click();
  await expect(page.getByLabel('Name')).toHaveAttribute('placeholder', 'Group 2');
  await page.getByLabel('Name').fill('Shopping');
  await page.getByLabel('Checklist').check();
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('tab', { name: 'Shopping' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByText('No notes yet.')).toBeVisible();

  await page.getByRole('tab', { name: 'General' }).click();
  await page.locator('.note', { hasText: 'Bread' }).click();
  await page.getByRole('button', { name: 'Move' }).click();
  await page.getByRole('menuitem', { name: 'Shopping' }).click();
  await expect(topics(page)).toHaveText(['Eggs']);

  await page.locator('.note', { hasText: 'Eggs' }).click();
  await page.getByRole('button', { name: 'Move' }).click();
  await page.getByRole('menuitem', { name: 'New group…' }).click();
  await expect(page.getByRole('tab', { name: 'Group 3' })).toBeVisible();
  await expect(page.getByText('No notes yet.')).toBeVisible();

  await page.getByRole('tab', { name: /Shopping/ }).click();
  await expect(topics(page)).toHaveText(['Bread']);
  await page.getByRole('tab', { name: /Shopping/ }).click();
  await page.getByRole('button', { name: 'Edit group' }).click();
  await page.getByLabel('Name').fill('Groceries');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('tab', { name: /Groceries/ })).toBeVisible();

  await page.getByRole('tab', { name: /Groceries/ }).click();
  await page.getByRole('button', { name: 'Delete group' }).click();
  await page.getByRole('button', { name: 'Confirm' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Delete "Groceries" and its 1 note?');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('tab', { name: /Groceries/ })).toBeVisible();

  await page.getByRole('button', { name: 'Delete group' }).click();
  await page.getByRole('button', { name: 'Confirm' }).click();
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('tab')).toHaveText(['General', 'Group 3']);
  await expect(page.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
});

test('shows notes added on another device', async ({ page, browser, request }) => {
  const explorationId = await newChat(request);
  await page.goto(`/e/${explorationId}/notes`);
  await expect(page.getByText('No notes yet.')).toBeVisible();

  const other = await (await browser.newContext()).newPage();
  await other.goto(`/e/${explorationId}/notes`);
  await addNote(other, 'From the phone');
  await expect(topics(page)).toHaveText(['From the phone']);
  await other.context().close();
});

test('opens a note from a link', async ({ page, request }) => {
  const explorationId = await newChat(request);
  const group = await (
    await request.post(`/api/explorations/${explorationId}/note-groups`, { data: {} })
  ).json();
  await request.post(`/api/explorations/${explorationId}/note-groups`, {
    data: { name: 'Other' },
  });
  const note = await (
    await request.post(`/api/explorations/${explorationId}/notes`, {
      data: { groupId: group.id, topic: 'Linked' },
    })
  ).json();
  await page.goto(`/e/${explorationId}/notes?group=missing#n-${note.id}`);
  await expect(page.locator(`#n-${note.id}`)).toHaveClass(/selected/);
});

test('opens a related note from a link in another note', async ({ page, request }) => {
  const explorationId = await newChat(request);
  const [first, second] = await Promise.all(
    ['General', 'Other'].map(async (name) =>
      (
        await request.post(`/api/explorations/${explorationId}/note-groups`, { data: { name } })
      ).json(),
    ),
  );
  const linked = await (
    await request.post(`/api/explorations/${explorationId}/notes`, {
      data: { groupId: first.id, topic: 'Linked' },
    })
  ).json();
  await request.post(`/api/explorations/${explorationId}/notes`, {
    data: {
      groupId: second.id,
      topic: 'Mentions it',
      description: `See [Linked](#n-${linked.id})`,
    },
  });
  await page.goto(`/e/${explorationId}/notes?group=${second.id}`);
  await page.getByRole('link', { name: 'Linked' }).click();
  await expect(page.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator(`#n-${linked.id}`)).toHaveClass(/selected/);
});

test('copies the id of a selected note', async ({ page, context, request }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const explorationId = await newChat(request);
  const group = await (
    await request.post(`/api/explorations/${explorationId}/note-groups`, { data: {} })
  ).json();
  const note = await (
    await request.post(`/api/explorations/${explorationId}/notes`, {
      data: { groupId: group.id, topic: 'Discuss me' },
    })
  ).json();
  await page.goto(`/e/${explorationId}/notes`);
  await expect(page.locator('.note-id')).toHaveCount(0);
  await page.getByText('Discuss me').click();
  await expect(page.locator('.note-id code')).toHaveText(note.id);
  await page.getByRole('button', { name: 'Copy ID' }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(note.id);
  await expect(page.locator(`#n-${note.id}`)).toHaveClass(/selected/);
});

test('ticks checklist notes, sorts them and drags them into place', async ({
  page,
  context,
  request,
}) => {
  const explorationId = await newChat(request);
  const group = await (
    await request.post(`/api/explorations/${explorationId}/note-groups`, {
      data: { name: 'Shopping', checklist: true },
    })
  ).json();
  for (const topic of ['Chocolate', 'Milk', 'Lemon']) {
    await request.post(`/api/explorations/${explorationId}/notes`, {
      data: { groupId: group.id, topic },
    });
  }
  await page.goto(`/e/${explorationId}/notes`);
  await expect(topics(page)).toHaveText(['Lemon', 'Milk', 'Chocolate']);

  await page.locator('.note', { hasText: 'Milk' }).click();
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(page.locator('.note', { hasText: 'Milk' })).toHaveClass(/checked/);
  await expect(page.locator('.note', { hasText: 'Milk' })).not.toHaveClass(/selected/);
  await page.getByRole('button', { name: 'Unchecked first' }).click();
  await expect(topics(page)).toHaveText(['Lemon', 'Chocolate', 'Milk']);
  await page.reload();
  await expect(topics(page)).toHaveText(['Lemon', 'Chocolate', 'Milk']);
  await page.getByRole('button', { name: 'Original order' }).click();
  await expect(topics(page)).toHaveText(['Lemon', 'Milk', 'Chocolate']);

  await page.locator('.note', { hasText: 'Chocolate' }).click();
  const handle = page.getByRole('button', { name: 'Drag to reorder' });
  const box = (await handle.boundingBox())!;
  const top = (await page.locator('.note', { hasText: 'Lemon' }).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, top.y + 4, { steps: 8 });
  await expect(page.locator('.drop-line')).toBeVisible();
  await page.mouse.up();
  await expect(topics(page)).toHaveText(['Chocolate', 'Lemon', 'Milk']);
  await page.reload();
  await expect(topics(page)).toHaveText(['Chocolate', 'Lemon', 'Milk']);

  await context.setOffline(true);
  await page.locator('.note', { hasText: 'Lemon' }).click();
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(page.locator('.note', { hasText: 'Lemon' })).toContainText('not sent yet');
  await context.setOffline(false);
  await expect(page.locator('.note', { hasText: 'Lemon' })).not.toContainText('not sent yet', {
    timeout: 10_000,
  });
  const snapshot = await (await request.get(`/api/explorations/${explorationId}`)).json();
  expect(
    snapshot.notes
      .filter((each: { checked: boolean }) => each.checked)
      .map((each: { topic: string }) => each.topic),
  ).toEqual(expect.arrayContaining(['Lemon', 'Milk']));
});

test('turns a note comment into a note on Submit', async ({ page, request }) => {
  const explorationId = await answeredChat(request);
  await request.post(`/api/explorations/${explorationId}/note-groups`, {
    data: { name: 'Facts' },
  });
  await request.post(`/api/explorations/${explorationId}/note-groups`, {
    data: { name: 'Backlog' },
  });
  await page.goto(`/e/${explorationId}`);
  await selectAnswer(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByLabel('Note', { exact: true }).check();
  await page.getByLabel('Note group').selectOption({ label: 'Backlog' });
  await page.getByPlaceholder('Your comment').fill('Check this later');
  await page.keyboard.press('ControlOrMeta+Enter');

  const card = page.locator('.comment-card.note');
  await expect(card).toContainText('Note');
  await expect(page.locator('.reply-bar .summary')).toHaveText('1 note');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(card).toContainText('saved');
  await expect(page.locator('.queued-submission')).toHaveCount(0);

  await card.click();
  await expect(page).toHaveURL(new RegExp(`/e/${explorationId}/notes\\?group=.*#n-`));
  await expect(page.getByRole('tab', { name: 'Backlog' })).toHaveAttribute('aria-selected', 'true');
  const note = page.locator('.note.selected');
  await expect(note.locator('.topic')).toHaveText('Preparing topic…');
  await expect(note.locator('.description')).toContainText('Check this later');
});

test('makes the new group a note comment asks for only on Submit', async ({ page, request }) => {
  const explorationId = await answeredChat(request);
  await request.post(`/api/explorations/${explorationId}/note-groups`, {
    data: { name: 'Facts' },
  });
  const groupNames = async () =>
    (await (await request.get(`/api/explorations/${explorationId}`)).json()).noteGroups.map(
      (group: { name: string }) => group.name,
    );
  await page.goto(`/e/${explorationId}`);
  await selectAnswer(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByLabel('Note', { exact: true }).check();
  await expect(page.getByLabel('Note group')).toHaveValue(/.+/);
  await page.getByLabel('Note group').selectOption({ label: 'Group 2 (new)' });
  await page.getByPlaceholder('Your comment').fill('In a group of its own');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('.reply-bar .summary')).toHaveText('1 note');
  expect(await groupNames()).toEqual(['Facts']);

  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.locator('.comment-card.note')).toContainText('saved');
  expect(await groupNames()).toEqual(['Facts', 'Group 2']);
});

test('shows the topic Claude writes and its requests to delete', async ({ page, request }) => {
  const explorationId = await newChat(request);
  const group = await (
    await request.post(`/api/explorations/${explorationId}/note-groups`, { data: {} })
  ).json();
  const create = async (body: object) =>
    (
      await request.post(`/api/explorations/${explorationId}/notes`, {
        data: { groupId: group.id, ...body },
      })
    ).json();
  const unnamed = await create({ description: 'Bread for the weekend' });
  const doomed = await create({ topic: 'Old idea' });
  const kept = await create({ topic: 'Keeper' });
  await page.goto(`/e/${explorationId}/notes`);
  await expect(topics(page)).toHaveText(['Keeper', 'Old idea', 'Preparing topic…']);

  await attachFakeSession(request, explorationId);
  const asClaude = (path: string, data: object, method = 'POST') =>
    request.fetch(`/api/internal${path}`, { method, data: { shimId: 'e2e-shim', ...data } });
  await asClaude(`/notes/${unnamed.id}`, { topic: 'Bread' }, 'PATCH');
  await asClaude(`/notes/${doomed.id}/deletion-request`, {});
  await asClaude(`/notes/${kept.id}/deletion-request`, {});
  await detachFakeSession(request);

  await expect(topics(page)).toHaveText(['Keeper', 'Old idea', 'Bread']);
  await expect(page.locator('.deletion-notice')).toContainText('Claude asks to delete 2 notes.');
  const keeper = page.locator('.note', { hasText: 'Keeper' });
  await keeper.getByRole('button', { name: 'Keep' }).click();
  await expect(keeper).not.toHaveClass(/deletion-requested/);
  const oldIdea = page.locator('.note', { hasText: 'Old idea' });
  await oldIdea.getByRole('button', { name: 'Delete' }).click();
  await oldIdea.getByRole('button', { name: 'Confirm' }).click();
  await expect(topics(page)).toHaveText(['Keeper', 'Bread']);
  await expect(page.locator('.deletion-notice')).toHaveCount(0);
});

test('reads an expanded note aloud, from the start or from a tapped block', async ({
  page,
  request,
}) => {
  const explorationId = await newChat(request);
  const group = await (
    await request.post(`/api/explorations/${explorationId}/note-groups`, { data: {} })
  ).json();
  const note = await (
    await request.post(`/api/explorations/${explorationId}/notes`, {
      data: {
        groupId: group.id,
        topic: 'Read me',
        description: 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.',
      },
    })
  ).json();
  await page.goto(`/e/${explorationId}/notes`);
  const item = page.locator(`#n-${note.id}`);
  const player = page.getByRole('region', { name: 'Reading aloud' });
  const paragraph = (text: string) => item.locator('.description p', { hasText: text });

  await item.click();
  await expect(item.getByRole('button', { name: 'Listen' })).toHaveCount(0);
  await item.getByRole('button', { name: 'Expand' }).click();
  await item.getByRole('button', { name: 'Listen' }).click();
  await expect(player.locator('.block-count')).toHaveText('1/3');
  await expect(paragraph('First')).toHaveClass(/speaking/);
  await expect(item.getByRole('button', { name: 'Pause' }).first()).toBeVisible();

  await paragraph('Third').click();
  await expect(item).toHaveClass(/selected/);
  await expect(paragraph('Third')).toHaveClass(/picked/);
  await item.getByRole('button', { name: 'Read aloud from here' }).click();
  await expect(player.locator('.block-count')).toHaveText('3/3');
  await expect(paragraph('Third')).toHaveClass(/speaking/);

  await player.getByRole('button', { name: 'Pause' }).click();
  await expect(item).toHaveClass(/selected/);
  await page.getByRole('link', { name: 'Map' }).click();
  await expect(player).toHaveCount(0);
});

test('starts a fork about a note from the note', async ({ page, request }) => {
  const explorationId = await answeredChat(request);
  const group = await (
    await request.post(`/api/explorations/${explorationId}/note-groups`, { data: {} })
  ).json();
  const note = await (
    await request.post(`/api/explorations/${explorationId}/notes`, {
      data: { groupId: group.id, topic: 'Cache headers' },
    })
  ).json();
  await page.goto(`/e/${explorationId}/notes`);
  const item = page.locator(`#n-${note.id}`);
  await item.click();
  await item.getByRole('button', { name: 'New fork' }).click();
  const message = item.getByRole('textbox', { name: 'Message for the new fork' });
  await expect(message).toBeFocused();
  await expect(item.getByRole('button', { name: 'Create fork' })).toBeDisabled();
  await message.fill('Which headers should we send?');
  await expect(item.getByRole('button', { name: 'Listen' })).toBeVisible();
  await expect(item).toHaveClass(/selected/);
  await item.getByRole('button', { name: 'Create fork' }).click();
  await expect(page).toHaveURL(new RegExp(`/e/${explorationId}/f/[a-z0-9]+$`));
  const forkId = page.url().split('/').at(-1);
  await expect(page.locator('.queued-submission')).toContainText('Queued');
  await expect(page.locator('.queued-submission')).not.toContainText('as a new fork');

  await expect
    .poll(async () => {
      const snapshot = await (await request.get(`/api/explorations/${explorationId}`)).json();
      return snapshot.queuedSubmissions.map(
        (submission: { forkId: string; globalMessage: string }) => [
          submission.forkId,
          submission.globalMessage,
        ],
      );
    })
    .toEqual([
      [
        forkId,
        `Regarding note [Cache headers](/e/${explorationId}/notes#n-${note.id}) (id \`${note.id}\`):\n\nWhich headers should we send?`,
      ],
    ]);
  await page.getByRole('link', { name: 'Map' }).click();
  await expect(page.locator('.fork-box')).toHaveCount(2);
});
