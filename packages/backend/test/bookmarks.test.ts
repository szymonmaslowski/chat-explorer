import { describe, expect, it } from 'vitest';
import { createTestApp, createTestStore, draft, seedConversation } from './helpers.js';

function setup() {
  const context = createTestStore();
  const conversation = seedConversation(context.store);
  const passage = {
    forkId: conversation.mainForkId,
    messageId: conversation.answer.id,
    quote: 'some text',
    startOffset: 16,
    endOffset: 25,
  };
  return { ...context, ...conversation, passage };
}

function childFork(context: ReturnType<typeof setup>) {
  const { store, explorationId, mainForkId, answer } = context;
  const comment = draft(store, explorationId, {
    messageId: answer.id,
    viewForkId: mainForkId,
    body: 'fork here',
    type: 'fork',
  });
  store.forkNow(comment.id);
  store.deliverQueued(explorationId);
  return store.pendingForks(explorationId)[0]!.forkId;
}

describe('bookmarks', () => {
  it('saves a passage of a fork and tells the pages', () => {
    const { store, events, clock, explorationId, passage } = setup();

    const bookmark = store.createBookmark(explorationId, passage);

    expect(bookmark).toEqual({ id: bookmark.id, explorationId, ...passage, createdAt: clock.now });
    expect(events).toContainEqual({ type: 'bookmark.created', bookmark });
    expect(store.snapshot(explorationId).bookmarks).toEqual([bookmark]);
  });

  it('keeps one bookmark per passage of a fork', () => {
    const { store, events, explorationId, passage } = setup();
    const first = store.createBookmark(explorationId, { ...passage, id: 'aaaaaaaaaa' });
    const eventCount = events.length;

    expect(store.createBookmark(explorationId, { ...passage, id: 'aaaaaaaaaa' })).toEqual(first);
    expect(store.createBookmark(explorationId, passage)).toEqual(first);
    expect(events.slice(eventCount)).not.toContainEqual(
      expect.objectContaining({ type: 'bookmark.created' }),
    );
    expect(store.snapshot(explorationId).bookmarks).toHaveLength(1);
  });

  it('keeps the bookmarks of a fork apart from its parent', () => {
    const context = setup();
    const { store, explorationId, passage } = context;
    const forkId = childFork(context);

    const inParent = store.createBookmark(explorationId, passage);
    const inChild = store.createBookmark(explorationId, { ...passage, forkId });

    expect(inChild.id).not.toBe(inParent.id);
    store.deleteBookmark(inParent.id);
    expect(store.snapshot(explorationId).bookmarks).toEqual([inChild]);
  });

  it('refuses a message the fork does not show, and an empty passage', () => {
    const { store, explorationId, passage } = setup();
    const other = seedConversation(store);

    expect(() =>
      store.createBookmark(explorationId, { ...passage, messageId: other.answer.id }),
    ).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(() =>
      store.createBookmark(explorationId, { ...passage, startOffset: 4, endOffset: 4 }),
    ).toThrow(expect.objectContaining({ code: 'invalid' }));
  });

  it('removes a bookmark and tells the pages', () => {
    const { store, events, explorationId, passage } = setup();
    const bookmark = store.createBookmark(explorationId, passage);

    store.deleteBookmark(bookmark.id);

    expect(events).toContainEqual({ type: 'bookmark.deleted', bookmarkId: bookmark.id });
    expect(store.snapshot(explorationId).bookmarks).toEqual([]);
    expect(() => store.deleteBookmark(bookmark.id)).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
  });

  it('adds and removes bookmarks through the API', async () => {
    const { request, store } = createTestApp();
    const { explorationId, mainForkId, answer } = seedConversation(store);
    const passage = {
      forkId: mainForkId,
      messageId: answer.id,
      quote: 'some text',
      startOffset: 16,
      endOffset: 25,
    };

    const created = await request(`/api/explorations/${explorationId}/bookmarks`, {
      method: 'POST',
      json: passage,
    });
    expect(created.status).toBe(201);
    const bookmark = await created.json();
    expect(bookmark).toMatchObject(passage);

    const deleted = await request(`/api/bookmarks/${bookmark.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(store.snapshot(explorationId).bookmarks).toEqual([]);
  });
});
