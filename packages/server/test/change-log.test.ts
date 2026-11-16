import { describe, expect, it } from 'vitest';
import type { ChangeSet, LightSnapshot } from '../src/shared/types.js';
import { createTestApp, draft, seedConversation } from './helpers.js';

const changesAfter = async (
  request: ReturnType<typeof createTestApp>['request'],
  explorationId: string,
  after: number,
): Promise<ChangeSet> =>
  (await request(`/api/explorations/${explorationId}/changes?after=${after}`)).json();

describe('change log', () => {
  it('records each write in its own transaction, and nothing for one rolled back', () => {
    const { store, database } = createTestApp();
    const { explorationId, mainForkId, answer } = seedConversation(store);
    const before = store.latestChangeSeq();
    draft(store, explorationId, { messageId: answer.id, viewForkId: mainForkId, body: 'Why?' });
    expect(store.latestChangeSeq()).toBe(before + 1);

    expect(() =>
      database.transaction(() => {
        database.run(
          `INSERT INTO bookmarks (id, exploration_id, fork_id, message_id, quote, start_offset,
             end_offset, created_at) VALUES ('b1', ?, ?, ?, 'x', 0, 1, 0)`,
          explorationId,
          mainForkId,
          answer.id,
        );
        throw new Error('Rolled back');
      }),
    ).toThrow('Rolled back');
    expect(store.latestChangeSeq()).toBe(before + 1);
  });

  it('sends what changed after a number as it is now, once each, and what was deleted', async () => {
    const { request, store } = createTestApp();
    const { explorationId, mainForkId, answer } = seedConversation(store);
    const light: LightSnapshot = await (
      await request(`/api/explorations/${explorationId}?light`)
    ).json();

    const kept = draft(store, explorationId, {
      messageId: answer.id,
      viewForkId: mainForkId,
      body: 'First',
    });
    store.updateComment(kept.id, { body: 'Second' });
    store.updateComment(kept.id, { body: 'Third' });
    const gone = draft(store, explorationId, {
      messageId: answer.id,
      viewForkId: mainForkId,
      body: 'Gone',
    });
    store.deleteComment(gone.id);
    const other = seedConversation(store);
    draft(store, other.explorationId, {
      messageId: other.answer.id,
      viewForkId: other.mainForkId,
      body: 'Elsewhere',
    });

    const changes = await changesAfter(request, explorationId, light.seq);
    expect(changes.reset).toBe(false);
    expect(changes.seq).toBe(store.latestChangeSeq());
    expect(changes.comments.map((comment) => comment.body)).toEqual(['Third']);
    expect(changes.deleted).toEqual([{ kind: 'comment', id: gone.id }]);
    expect((await changesAfter(request, explorationId, changes.seq)).comments).toEqual([]);
  });

  it('sends a new message with its text, and a read mark as the message changed', async () => {
    const { request, store } = createTestApp();
    const { explorationId, mainForkId, answer } = seedConversation(store);
    const seq = store.latestChangeSeq();
    store.markUnreadFrom(answer.id, mainForkId);
    store.submit(explorationId, mainForkId, 'And then?');
    store.deliverQueued(explorationId);

    const changes = await changesAfter(request, explorationId, seq);
    expect(changes.messages.map((message) => message.content)).toEqual([
      'Answer one with some text to quote',
      'And then?',
    ]);
    expect(changes.messages[0]!.readAt).toBeNull();
    expect(changes.forks.map((fork) => fork.id)).toEqual([mainForkId]);
  });

  it('asks for a fresh load once the rows a device would need were deleted', async () => {
    const { request, store, clock } = createTestApp();
    const { explorationId, mainForkId, answer } = seedConversation(store);
    const seq = store.latestChangeSeq();
    draft(store, explorationId, { messageId: answer.id, viewForkId: mainForkId, body: 'Old' });
    clock.now += 1;
    store.pruneChanges(Date.now() + 60_000);

    expect(await changesAfter(request, explorationId, seq)).toMatchObject({ reset: true });
    const current = store.latestChangeSeq();
    expect(current).toBeGreaterThan(seq);
    expect(await changesAfter(request, explorationId, current)).toMatchObject({
      reset: false,
      comments: [],
    });
  });

  it('sends the session state with the changes, which the log keeps no record of', async () => {
    const { request, store } = createTestApp();
    const { explorationId } = seedConversation(store);
    const seq = store.latestChangeSeq();
    expect(await changesAfter(request, explorationId, seq)).toMatchObject({
      sessionStatus: 'detached',
      sessionError: null,
    });

    store.attach({ explorationId, shimId: 'shim-a', sessionId: 'session-a', takeover: false });
    expect(await changesAfter(request, explorationId, store.latestChangeSeq())).toMatchObject({
      sessionStatus: 'attached',
    });
  });
});
