import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MessageFile } from '../src/shared/types.js';
import { createTestApp, draft, seedConversation } from './helpers.js';

const anchor = { quote: 'some text', startOffset: 16, endOffset: 25 };

describe('comments being written', () => {
  it('keeps an unsaved new comment with an empty body until it is saved', () => {
    const { store } = createTestApp();
    const { explorationId, mainForkId, answer } = seedConversation(store);
    const writing = store.createComment(explorationId, {
      messageId: answer.id,
      viewForkId: mainForkId,
      ...anchor,
      body: '',
      editBody: 'Half a thou',
    });
    expect(writing).toMatchObject({ body: '', editBody: 'Half a thou', status: 'draft' });

    store.updateComment(writing.id, { editBody: 'Half a thought, then more' });
    const saved = store.updateComment(writing.id, {
      body: 'Half a thought, then more',
      editBody: null,
    });
    expect(saved).toMatchObject({ body: 'Half a thought, then more', editBody: null });
  });

  it('keeps the saved text of a comment while it is edited', () => {
    const { store } = createTestApp();
    const { explorationId, mainForkId, answer } = seedConversation(store);
    const comment = draft(store, explorationId, {
      messageId: answer.id,
      viewForkId: mainForkId,
      body: 'Original',
    });
    store.updateComment(comment.id, { editBody: 'Original, edited' });
    expect(store.snapshot(explorationId).comments[0]).toMatchObject({
      body: 'Original',
      editBody: 'Original, edited',
    });
    expect(store.updateComment(comment.id, { editBody: null })).toMatchObject({
      body: 'Original',
      editBody: null,
    });
  });

  it('refuses to submit while a comment of the fork is open in an editor', () => {
    const { store } = createTestApp();
    const { explorationId, mainForkId, answer } = seedConversation(store);
    const comment = draft(store, explorationId, {
      messageId: answer.id,
      viewForkId: mainForkId,
      body: 'Original',
    });
    store.updateComment(comment.id, { editBody: 'Changing' });
    expect(() => store.submit(explorationId, mainForkId, 'Reply')).toThrow(
      expect.objectContaining({ code: 'invalid' }),
    );
    store.updateComment(comment.id, { editBody: null });
    expect(store.submit(explorationId, mainForkId, 'Reply').globalMessage).toBe('Reply');
  });
});

describe('reply drafts', () => {
  async function upload(request: ReturnType<typeof createTestApp>['request'], name: string) {
    const form = new FormData();
    form.append('file', new File(['content'], name));
    return (await (
      await request('/api/files', { method: 'POST', body: form })
    ).json()) as MessageFile;
  }

  it('saves the reply box with its files and drops it on submit', async () => {
    const { request, store } = createTestApp();
    const { explorationId, mainForkId } = seedConversation(store);
    const file = await upload(request, 'notes.md');

    const saved = await request(`/api/forks/${mainForkId}/reply-draft`, {
      method: 'PUT',
      json: { text: 'Still typing', newFork: true, fileIds: [file.id] },
    });
    expect(await saved.json()).toMatchObject({
      forkId: mainForkId,
      text: 'Still typing',
      newFork: true,
      files: [{ id: file.id, name: 'notes.md' }],
    });
    expect(store.snapshot(explorationId).replyDrafts).toHaveLength(1);

    store.submit(explorationId, mainForkId, 'Still typing', { fileIds: [file.id] });
    expect(store.replyDraft(mainForkId)).toEqual({
      forkId: mainForkId,
      text: '',
      newFork: false,
      files: [],
      updatedAt: 0,
    });
  });

  it('removes a draft that became empty', async () => {
    const { request, store } = createTestApp();
    const { explorationId, mainForkId } = seedConversation(store);
    store.saveReplyDraft(mainForkId, { text: 'x', newFork: false, fileIds: [] });
    store.saveReplyDraft(mainForkId, { text: '', newFork: false, fileIds: [] });
    expect(store.snapshot(explorationId).replyDrafts).toEqual([]);
    expect((await request(`/api/forks/${mainForkId}/reply-draft`)).status).toBe(200);
  });

  it('keeps the files of a reply draft through the stale draft sweep', async () => {
    const { request, store, clock, fileStorage } = createTestApp();
    const { mainForkId } = seedConversation(store);
    const kept = await upload(request, 'kept.md');
    const loose = await upload(request, 'loose.md');
    store.saveReplyDraft(mainForkId, { text: '', newFork: false, fileIds: [kept.id] });

    clock.now += 25 * 60 * 60 * 1000;
    await fileStorage.removeStaleDrafts();
    expect(existsSync(store.fileRow(kept.id).path)).toBe(true);
    expect(() => store.fileRow(loose.id)).toThrow(expect.objectContaining({ code: 'not_found' }));
  });
});
