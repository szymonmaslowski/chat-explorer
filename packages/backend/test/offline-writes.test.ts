import { describe, expect, it } from 'vitest';
import { createTestApp, seedConversation } from './helpers.js';

describe('changes made offline', () => {
  it('keeps the newest of two read marks, whichever arrives last', () => {
    const { store, clock } = createTestApp();
    const { explorationId, mainForkId, answer } = seedConversation(store);
    store.markUnreadFrom(answer.id, mainForkId, clock.now);
    const offlineRead = clock.now + 10;
    const laterUnread = clock.now + 20;
    store.markUnreadFrom(answer.id, mainForkId, laterUnread);

    expect(store.markRead(explorationId, [answer.id], offlineRead).messageIds).toEqual([]);
    expect(store.readFork(mainForkId).messages).toBeDefined();
    expect(store.snapshot(explorationId).messages.at(-1)!.readAt).toBeNull();
    expect(store.markRead(explorationId, [answer.id], laterUnread + 1).messageIds).toEqual([
      answer.id,
    ]);
  });

  it('keeps an edit another device overtook as a copy of the note, the newer one in it', () => {
    const { store, clock } = createTestApp();
    const { explorationId } = seedConversation(store);
    const group = store.createNoteGroup(explorationId, {});
    const note = store.createNote(explorationId, {
      groupId: group.id,
      topic: 'Plan',
      description: 'v1',
    });
    const seen = note.updatedAt;

    clock.now += 1_000;
    const offlineEditAt = clock.now;
    clock.now += 1_000;
    store.updateNote(note.id, { description: 'From the laptop' }, 'laptop');
    clock.now += 1_000;
    store.updateNote(
      note.id,
      { description: 'From the phone, offline', baseUpdatedAt: seen, editedAt: offlineEditAt },
      'phone',
    );

    const notes = store.snapshot(explorationId).notes;
    expect(notes.find((each) => each.id === note.id)!.description).toBe('From the laptop');
    expect(notes.find((each) => each.id !== note.id)).toMatchObject({
      topic: 'Plan (other version)',
      description: 'From the phone, offline',
    });
  });

  it('puts the newer edit in the note and the overtaken one in the copy', () => {
    const { store, clock } = createTestApp();
    const { explorationId } = seedConversation(store);
    const group = store.createNoteGroup(explorationId, {});
    const note = store.createNote(explorationId, {
      groupId: group.id,
      topic: 'Plan',
      description: 'v1',
    });
    const seen = note.updatedAt;
    clock.now += 1_000;
    store.updateNote(note.id, { description: 'From the laptop' }, 'laptop');
    clock.now += 1_000;
    store.updateNote(
      note.id,
      { description: 'From the phone', baseUpdatedAt: seen, editedAt: clock.now },
      'phone',
    );

    const notes = store.snapshot(explorationId).notes;
    expect(notes.find((each) => each.id === note.id)!.description).toBe('From the phone');
    expect(notes.find((each) => each.id !== note.id)!.description).toBe('From the laptop');
  });

  it('sees no conflict in a device saving its own edits one after another', () => {
    const { store, clock } = createTestApp();
    const { explorationId } = seedConversation(store);
    const group = store.createNoteGroup(explorationId, {});
    const note = store.createNote(explorationId, {
      groupId: group.id,
      topic: 'Plan',
      description: 'v1',
    });
    for (const description of ['v2', 'v3']) {
      clock.now += 1_000;
      store.updateNote(note.id, { description, baseUpdatedAt: note.updatedAt }, 'phone');
    }
    expect(store.snapshot(explorationId).notes).toHaveLength(1);
  });

  it('gives each browser a lasting device id in a cookie the page can read', async () => {
    const { request } = createTestApp();
    const first = await request('/api/health');
    const cookie = first.headers.get('set-cookie')!;
    expect(cookie).toMatch(
      /^ce_device=[0-9a-z]+\.\d+; Max-Age=34560000; Path=\/; SameSite=Strict$/,
    );
    const again = await request('/api/health', { headers: { cookie: cookie.split(';')[0]! } });
    expect(again.headers.get('set-cookie')!.split(';')[0]).toBe(cookie.split(';')[0]);
  });
});
