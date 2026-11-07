import { describe, expect, it } from 'vitest';
import { createTestStore, seedConversation } from './helpers.js';

function setup() {
  const context = createTestStore();
  const conversation = seedConversation(context.store);
  context.store.attach({
    explorationId: conversation.explorationId,
    shimId: 'shim-a',
    sessionId: 'session-a',
    takeover: false,
  });
  const answer = (forkId: string, content: string) => {
    context.store.deliverQueued(conversation.explorationId);
    const pending = context.store
      .pendingForks(conversation.explorationId)
      .find((fork) => fork.forkId === forkId)!;
    return context.store.addAssistantMessage({
      shimId: 'shim-a',
      forkId,
      inReplyTo: pending.inReplyTo,
      content,
    });
  };
  return { ...context, ...conversation, answer };
}

const messagesOf = (store: ReturnType<typeof setup>['store'], explorationId: string) =>
  store.snapshot(explorationId).messages;

describe('read state', () => {
  it('leaves only new answers of Claude unread', () => {
    const { store, explorationId, mainForkId, answer } = setup();
    expect(messagesOf(store, explorationId).every((message) => message.readAt !== null)).toBe(true);
    expect(store.listExplorations()[0]!.hasUnread).toBe(false);

    store.submit(explorationId, mainForkId, 'Another question');
    const reply = answer(mainForkId, 'Another answer');
    const messages = messagesOf(store, explorationId);
    expect(messages.find((message) => message.content === 'Another question')!.readAt).not.toBe(
      null,
    );
    expect(messages.find((message) => message.id === reply.id)!.readAt).toBeNull();
    expect(store.listExplorations()[0]!.hasUnread).toBe(true);
  });

  it('marks answers read once and tells the pages', () => {
    const { store, events, clock, explorationId, mainForkId, answer } = setup();
    store.submit(explorationId, mainForkId, 'Another question');
    const reply = answer(mainForkId, 'Another answer');

    const marked = store.markRead(explorationId, [reply.id]);
    expect(marked).toEqual({ messageIds: [reply.id], readAt: clock.now });
    expect(events.at(-1)).toEqual({
      type: 'messages.read',
      messageIds: [reply.id],
      readAt: clock.now,
    });
    expect(store.markRead(explorationId, [reply.id]).messageIds).toEqual([]);
    expect(store.listExplorations()[0]!.hasUnread).toBe(false);
  });

  it('marks an answer and the later ones on the fork path unread', () => {
    const { store, explorationId, mainForkId, answer } = setup();
    store.submit(explorationId, mainForkId, 'Second');
    const second = answer(mainForkId, 'Second answer');
    store.submit(explorationId, mainForkId, 'Third');
    const third = answer(mainForkId, 'Third answer');
    store.markRead(explorationId, [second.id, third.id]);

    const unread = store.markUnreadFrom(second.id, mainForkId);
    expect(unread.messageIds).toEqual([second.id, third.id]);
    const readAt = new Map(
      messagesOf(store, explorationId).map((message) => [message.id, message.readAt]),
    );
    expect(readAt.get(second.id)).toBeNull();
    expect(readAt.get(third.id)).toBeNull();
  });

  it('refuses to mark a question unread or an answer outside the fork', () => {
    const { store, mainForkId, question, explorationId } = setup();
    expect(() => store.markUnreadFrom(question.id, mainForkId)).toThrow(
      expect.objectContaining({ code: 'invalid' }),
    );
    const other = seedConversation(store);
    expect(() => store.markUnreadFrom(other.answer.id, mainForkId)).toThrow();
    expect(store.markRead(explorationId, [other.answer.id]).messageIds).toEqual([]);
  });

  it('lets an archived chat be read', () => {
    const { store, explorationId, mainForkId, answer } = setup();
    store.submit(explorationId, mainForkId, 'Another question');
    const reply = answer(mainForkId, 'Another answer');
    store.archiveExploration(explorationId);
    expect(store.markRead(explorationId, [reply.id]).messageIds).toEqual([reply.id]);
  });
});
