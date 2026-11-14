import { expect } from '@playwright/test';
import { answeredChat, test } from './helpers';

const withoutPrefix = (id: string) => id.slice(id.indexOf('_') + 1);

test('opens a link with ids from before the prefixes under the new ids', async ({
  page,
  request,
}) => {
  const explorationId = await answeredChat(request);
  expect(explorationId).toMatch(/^chat_/);
  const snapshot = await (await request.get(`/api/explorations/${explorationId}`)).json();
  const forkId: string = snapshot.forks[0].id;
  expect(forkId).toMatch(/^fork_/);

  await page.goto(`/e/${withoutPrefix(explorationId)}/f/${withoutPrefix(forkId)}`);
  await expect(page).toHaveURL(`/e/${explorationId}/f/${forkId}`);
  await expect(page.locator('.conversation')).toContainText('Caching keeps');

  const group = await (
    await request.post(`/api/explorations/${explorationId}/note-groups`, { data: {} })
  ).json();
  const note = await (
    await request.post(`/api/explorations/${explorationId}/notes`, {
      data: { groupId: group.id, topic: 'An old link' },
    })
  ).json();
  expect(note.id).toMatch(/^note_/);
  await page.goto(`/e/${withoutPrefix(explorationId)}/notes#n-${withoutPrefix(note.id)}`);
  await expect(page).toHaveURL(`/e/${explorationId}/notes#n-${note.id}`);
  await expect(page.locator('.note.selected')).toContainText('An old link');
});
