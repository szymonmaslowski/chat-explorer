import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { test } from './helpers';

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
  await page.getByRole('button', { name: 'Save' }).click();
}

const topics = (page: Page) => page.locator('.note .topic');

test('adds, edits and deletes notes, starting the General group', async ({ page, request }) => {
  const explorationId = await newChat(request);
  await page.goto(`/e/${explorationId}`);
  await page.getByRole('link', { name: 'Notes' }).click();
  await expect(page).toHaveURL(`/e/${explorationId}/notes`);
  await expect(page.getByText('No notes yet.')).toBeVisible();

  await page.getByRole('button', { name: '+ New note' }).click();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
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
  await page.getByRole('button', { name: 'Save' }).click();
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
  await page.getByRole('button', { name: 'Save' }).click();
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
