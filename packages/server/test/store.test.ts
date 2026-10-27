import { describe, expect, it } from 'vitest';
import { attachmentLivenessMs } from '../src/store/store.js';
import { createTestStore, draft, seedConversation } from './helpers.js';

function setup() {
  const context = createTestStore();
  const conversation = seedConversation(context.store);
  context.store.attach({
    explorationId: conversation.explorationId,
    shimId: 'shim-a',
    sessionId: 'session-a',
    takeover: false,
  });
  return { ...context, ...conversation };
}

describe('paths', () => {
  it('reads a fork from the root to its tip', () => {
    const { store, mainForkId } = setup();
    const read = store.readFork(mainForkId);
    expect(read.messages.map((message) => message.text)).toEqual([
      'Question one',
      'Answer one with some text to quote',
    ]);
    expect(read.omitted).toBeNull();
  });

  it('limits a read to the newest messages and names the omitted forks', () => {
    const { store, mainForkId } = setup();
    const read = store.readFork(mainForkId, 1);
    expect(read.messages).toHaveLength(1);
    expect(read.omitted).toEqual({ count: 1, forks: [{ id: mainForkId, summary: '' }] });
  });

  it('includes the shared history in a new fork path', () => {
    const { store, explorationId, mainForkId, answer } = setup();
    draft(store, explorationId, {
      messageId: answer.id,
      viewForkId: mainForkId,
      body: 'Go deeper here',
      type: 'fork',
    });
    store.submit(explorationId, mainForkId, '');
    store.deliverQueued(explorationId);
    const [newFork] = store.pendingForks(explorationId);
    const read = store.readFork(newFork!.forkId);
    expect(read.messages.map((message) => message.id).slice(0, 2)).toEqual([
      store.readFork(mainForkId).messages[0]!.id,
      answer.id,
    ]);
    expect(read.messages.at(-1)!.text).toBe('> some text\nGo deeper here');
  });
});

describe('comments', () => {
  it('rejects an anchor on a message the fork view does not show', () => {
    const { store, explorationId, mainForkId, answer } = setup();
    draft(store, explorationId, {
      messageId: answer.id,
      viewForkId: mainForkId,
      body: 'Fork',
      type: 'fork',
    });
    store.submit(explorationId, mainForkId, '');
    store.deliverQueued(explorationId);
    const [newFork] = store.pendingForks(explorationId);
    const forkMessageId = newFork!.inReplyTo;
    expect(() =>
      draft(store, explorationId, { messageId: forkMessageId, viewForkId: mainForkId, body: 'x' }),
    ).toThrow(expect.objectContaining({ code: 'invalid' }));
  });

  it('toggles fork-all between all fork and all inline', () => {
    const { store, explorationId, mainForkId, answer } = setup();
    draft(store, explorationId, { messageId: answer.id, viewForkId: mainForkId, body: 'a' });
    draft(store, explorationId, {
      messageId: answer.id,
      viewForkId: mainForkId,
      body: 'b',
      type: 'fork',
    });
    expect(store.toggleForkAll(explorationId, mainForkId).map((comment) => comment.type)).toEqual([
      'fork',
      'fork',
    ]);
    expect(store.toggleForkAll(explorationId, mainForkId).map((comment) => comment.type)).toEqual([
      'inline',
      'inline',
    ]);
  });

  it('refuses to edit or delete a queued comment', () => {
    const { store, explorationId, mainForkId, answer } = setup();
    const comment = draft(store, explorationId, {
      messageId: answer.id,
      viewForkId: mainForkId,
      body: 'a',
    });
    store.submit(explorationId, mainForkId, '');
    expect(() => store.updateComment(comment.id, { body: 'b' })).toThrow(
      expect.objectContaining({ code: 'not_draft' }),
    );
    expect(() => store.deleteComment(comment.id)).toThrow(
      expect.objectContaining({ code: 'not_draft' }),
    );
  });
});

describe('submission queue', () => {
  it('queues a submit without creating messages or forks', () => {
    const { store, explorationId, mainForkId, answer } = setup();
    draft(store, explorationId, { messageId: answer.id, viewForkId: mainForkId, body: 'inline' });
    draft(store, explorationId, {
      messageId: answer.id,
      viewForkId: mainForkId,
      body: 'fork',
      type: 'fork',
    });
    store.submit(explorationId, mainForkId, 'global');
    const snapshot = store.snapshot(explorationId);
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.forks).toHaveLength(1);
    expect(snapshot.comments.map((comment) => comment.status)).toEqual(['queued', 'queued']);
    expect(snapshot.queuedSubmissions).toHaveLength(1);
  });

  it('rejects an empty submit', () => {
    const { store, explorationId, mainForkId } = setup();
    expect(() => store.submit(explorationId, mainForkId, '  ')).toThrow(
      expect.objectContaining({ code: 'invalid' }),
    );
  });

  it('merges queued submissions per fork on delivery and creates one fork per fork comment', () => {
    const { store, explorationId, mainForkId, answer } = setup();
    draft(store, explorationId, {
      messageId: answer.id,
      viewForkId: mainForkId,
      body: 'first inline',
    });
    draft(store, explorationId, {
      messageId: answer.id,
      viewForkId: mainForkId,
      body: 'fork A',
      type: 'fork',
    });
    store.submit(explorationId, mainForkId, 'first message');
    draft(store, explorationId, {
      messageId: answer.id,
      viewForkId: mainForkId,
      body: 'second inline',
    });
    draft(store, explorationId, {
      messageId: answer.id,
      viewForkId: mainForkId,
      body: 'fork B',
      type: 'fork',
    });
    store.submit(explorationId, mainForkId, 'second message');

    expect(store.deliverQueued(explorationId)).toBe(true);

    const pending = store.pendingForks(explorationId);
    expect(pending).toHaveLength(3);
    const [main, forkA, forkB] = pending;
    expect(main!.forkId).toBe(mainForkId);
    expect(main!.isNewFork).toBe(false);
    expect(main!.userMessages).toHaveLength(1);
    expect(main!.userMessages[0]!.text).toBe(
      '> some text\nfirst inline\n\n> some text\nsecond inline\n\nfirst message\n\nsecond message',
    );
    expect(forkA!.isNewFork).toBe(true);
    expect(forkA!.baseMessageId).toBe(answer.id);
    expect(forkA!.parentForkId).toBe(mainForkId);
    expect(forkA!.userMessages[0]!.text).toBe('> some text\nfork A');
    expect(forkB!.userMessages[0]!.text).toBe('> some text\nfork B');

    const snapshot = store.snapshot(explorationId);
    expect(snapshot.queuedSubmissions).toHaveLength(0);
    expect(snapshot.comments.every((comment) => comment.status === 'submitted')).toBe(true);
    expect(snapshot.forks.find((fork) => fork.id === forkA!.forkId)!.summary).toBe('fork A');
    expect(store.deliverQueued(explorationId)).toBe(false);
  });

  it('restores drafts and returns the message when a queued submission is cancelled', () => {
    const { store, explorationId, mainForkId, answer } = setup();
    draft(store, explorationId, { messageId: answer.id, viewForkId: mainForkId, body: 'inline' });
    const submission = store.submit(explorationId, mainForkId, 'global');
    expect(store.cancelSubmission(submission.id)).toEqual({ globalMessage: 'global' });
    const snapshot = store.snapshot(explorationId);
    expect(snapshot.comments.map((comment) => [comment.status, comment.submissionId])).toEqual([
      ['draft', null],
    ]);
    expect(snapshot.queuedSubmissions).toHaveLength(0);
  });

  it('refuses to cancel a submission that was already delivered', () => {
    const { store, explorationId, mainForkId } = setup();
    const submission = store.submit(explorationId, mainForkId, 'global');
    store.deliverQueued(explorationId);
    expect(() => store.cancelSubmission(submission.id)).toThrow(
      expect.objectContaining({ code: 'already_sent' }),
    );
  });

  it('returns every unanswered user message of a fork that was skipped', () => {
    const { store, explorationId, mainForkId } = setup();
    store.submit(explorationId, mainForkId, 'one');
    store.deliverQueued(explorationId);
    store.submit(explorationId, mainForkId, 'two');
    store.deliverQueued(explorationId);
    const [main] = store.pendingForks(explorationId);
    expect(main!.userMessages.map((message) => message.text)).toEqual(['one', 'two']);
    expect(main!.inReplyTo).toBe(main!.userMessages[1]!.id);
  });
});

describe('answers', () => {
  it('appends an answer only when inReplyTo is the current tip', () => {
    const { store, explorationId, mainForkId } = setup();
    store.submit(explorationId, mainForkId, 'one');
    store.deliverQueued(explorationId);
    const [main] = store.pendingForks(explorationId);
    expect(() =>
      store.addAssistantMessage({
        shimId: 'shim-a',
        forkId: mainForkId,
        inReplyTo: 'other',
        content: 'x',
      }),
    ).toThrow(expect.objectContaining({ code: 'stale_tip' }));
    store.addAssistantMessage({
      shimId: 'shim-a',
      forkId: mainForkId,
      inReplyTo: main!.inReplyTo,
      content: 'Answer two',
    });
    expect(store.pendingForks(explorationId)).toHaveLength(0);
    expect(store.forkMap(explorationId)[0]!.awaitingAnswer).toBe(false);
  });

  it('refuses an answer from a session that is not attached', () => {
    const { store, explorationId, mainForkId } = setup();
    store.submit(explorationId, mainForkId, 'one');
    store.deliverQueued(explorationId);
    const [main] = store.pendingForks(explorationId);
    expect(() =>
      store.addAssistantMessage({
        shimId: 'shim-b',
        forkId: mainForkId,
        inReplyTo: main!.inReplyTo,
        content: 'x',
      }),
    ).toThrow(expect.objectContaining({ code: 'detached' }));
  });

  it('marks a fork as awaiting an answer while its tip is a user message', () => {
    const { store, explorationId, mainForkId } = setup();
    expect(store.forkMap(explorationId)[0]!.awaitingAnswer).toBe(false);
    store.submit(explorationId, mainForkId, 'one');
    expect(store.forkMap(explorationId)[0]!.awaitingAnswer).toBe(false);
    store.deliverQueued(explorationId);
    expect(store.forkMap(explorationId)[0]).toMatchObject({
      awaitingAnswer: true,
      messageCount: 3,
    });
  });
});

describe('attachment', () => {
  it('refuses a second live session unless it takes over', () => {
    const { store, explorationId } = setup();
    const attachB = (takeover: boolean) =>
      store.attach({ explorationId, shimId: 'shim-b', sessionId: 'session-b', takeover });
    expect(() => attachB(false)).toThrow(expect.objectContaining({ code: 'attached_elsewhere' }));
    attachB(true);
    expect(store.attachment(explorationId)).toMatchObject({
      shimId: 'shim-b',
      sessionId: 'session-b',
    });
  });

  it('frees an attachment whose heartbeats stopped', () => {
    const { store, explorationId, clock } = setup();
    clock.now += attachmentLivenessMs + 1;
    store.attach({ explorationId, shimId: 'shim-b', sessionId: 'session-b', takeover: false });
    expect(store.attachment(explorationId)?.shimId).toBe('shim-b');
  });

  it('keeps an attachment alive with heartbeats', () => {
    const { store, explorationId, clock } = setup();
    clock.now += attachmentLivenessMs - 1;
    store.heartbeat('shim-a');
    clock.now += attachmentLivenessMs - 1;
    expect(store.attachment(explorationId)?.live).toBe(true);
  });

  it('finds the exploration attached to a Claude session', () => {
    const { store, explorationId } = setup();
    expect(store.explorationForSession('session-a')?.id).toBe(explorationId);
    expect(store.explorationForSession('unknown')).toBeNull();
  });
});

describe('delete', () => {
  it('removes every row of the exploration', () => {
    const { store, database, explorationId, mainForkId, answer } = setup();
    draft(store, explorationId, {
      messageId: answer.id,
      viewForkId: mainForkId,
      body: 'fork',
      type: 'fork',
    });
    store.submit(explorationId, mainForkId, 'message');
    store.deliverQueued(explorationId);
    store.deleteExploration(explorationId);
    for (const table of ['explorations', 'forks', 'messages', 'comments', 'submissions']) {
      expect(database.get<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)!.count).toBe(
        0,
      );
    }
  });
});
