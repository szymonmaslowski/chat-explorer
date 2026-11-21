import { describe, expect, it } from 'vitest';
import { createTestStore, draft, seedConversation } from './helpers.js';

// Child forks of the main fork, named by their first message.
function setup(forkCount = 3) {
  const context = createTestStore();
  const conversation = seedConversation(context.store);
  const { store } = context;
  const forkIds: string[] = [];
  for (let index = 0; index < forkCount; index += 1) {
    draft(store, conversation.explorationId, {
      messageId: conversation.answer.id,
      viewForkId: conversation.mainForkId,
      body: `Fork ${index + 1}`,
      type: 'fork',
    });
    store.submit(conversation.explorationId, conversation.mainForkId, '');
    store.deliverQueued(conversation.explorationId);
    forkIds.push(store.pendingForks(conversation.explorationId).at(-1)!.forkId);
  }
  return { ...context, ...conversation, forkIds };
}

const column = (context: ReturnType<typeof setup>, id: string | null) =>
  context.store
    .snapshot(context.explorationId)
    .forks.filter((fork) => fork.parentForkId !== null && fork.boardColumnId === id)
    .sort((a, b) => a.boardPosition - b.boardPosition)
    .map((fork) => fork.id);

describe('board columns', () => {
  it('adds, renames and reorders columns', () => {
    const context = setup(0);
    const { store, explorationId } = context;
    store.addBoardColumn(explorationId, ' system ');
    store.addBoardColumn(explorationId, 'UX');
    const [system, ux] = store.snapshot(explorationId).exploration.boardColumns;
    expect(system!.name).toBe('system');
    store.renameBoardColumn(explorationId, system!.id, 'platform');
    store.reorderBoardColumn(explorationId, ux!.id, null);
    expect(store.snapshot(explorationId).exploration.boardColumns.map((each) => each.name)).toEqual(
      ['UX', 'platform'],
    );
  });

  it('refuses empty and duplicate names', () => {
    const { store, explorationId } = setup(0);
    store.addBoardColumn(explorationId, 'UX');
    expect(() => store.addBoardColumn(explorationId, '  ')).toThrow();
    expect(() => store.addBoardColumn(explorationId, 'UX')).toThrow(/already/);
  });

  it('keeps a client-made column when the same id is sent again', () => {
    const { store, explorationId } = setup(0);
    store.addBoardColumn(explorationId, 'UX', 'abc');
    store.addBoardColumn(explorationId, 'UX', 'abc');
    expect(store.snapshot(explorationId).exploration.boardColumns).toHaveLength(1);
  });

  it('puts a new fork in Ungrouped, at the bottom, in creation order', () => {
    const context = setup(3);
    expect(column(context, null)).toEqual(context.forkIds);
  });

  it('moves forks between columns and within one, keeping the order gapless', () => {
    const context = setup(3);
    const { store, explorationId, forkIds } = context;
    store.addBoardColumn(explorationId, 'system');
    const [system] = store.snapshot(explorationId).exploration.boardColumns;
    const [a, b, c] = forkIds as [string, string, string];
    store.moveFork(a, system!.id, null);
    store.moveFork(c, system!.id, null);
    expect(column(context, system!.id)).toEqual([c, a]);
    expect(column(context, null)).toEqual([b]);
    store.moveFork(c, system!.id, a);
    expect(column(context, system!.id)).toEqual([a, c]);
    expect(
      store
        .snapshot(explorationId)
        .forks.filter((fork) => fork.boardColumnId === system!.id)
        .map((fork) => fork.boardPosition)
        .sort(),
    ).toEqual([0, 1]);
  });

  it('refuses to move the main fork, or after a fork of another column', () => {
    const context = setup(2);
    const { store, explorationId, forkIds, mainForkId } = context;
    store.addBoardColumn(explorationId, 'system');
    const [system] = store.snapshot(explorationId).exploration.boardColumns;
    expect(() => store.moveFork(mainForkId, system!.id, null)).toThrow(/main fork/);
    store.moveFork(forkIds[0]!, system!.id, null);
    expect(() => store.moveFork(forkIds[1]!, system!.id, forkIds[1]!)).toThrow();
    expect(() => store.moveFork(forkIds[1]!, null, forkIds[0]!)).toThrow(/not in that column/);
    expect(() => store.moveFork(forkIds[1]!, 'nope', null)).toThrow(/does not exist/);
  });

  it('files a fork of a fork under its parent column, at the bottom', () => {
    const context = setup(2);
    const { store, explorationId, forkIds } = context;
    store.attach({ explorationId, shimId: 'shim-a', sessionId: 'session-a', takeover: false });
    store.addBoardColumn(explorationId, 'system');
    const [system] = store.snapshot(explorationId).exploration.boardColumns;
    const [parentId, otherId] = forkIds as [string, string];
    store.moveFork(parentId, system!.id, null);
    store.moveFork(otherId, system!.id, parentId);
    const pending = store.pendingForks(explorationId).find((fork) => fork.forkId === parentId)!;
    const answer = store.addAssistantMessage({
      shimId: 'shim-a',
      forkId: parentId,
      inReplyTo: pending.inReplyTo,
      content: 'Answer with some text to quote',
    });
    draft(store, explorationId, {
      messageId: answer.id,
      viewForkId: parentId,
      body: 'Grandchild',
      type: 'fork',
    });
    store.submit(explorationId, parentId, '');
    store.deliverQueued(explorationId);
    const childId = store.pendingForks(explorationId).at(-1)!.forkId;
    expect(column(context, system!.id)).toEqual([parentId, otherId, childId]);
  });

  it('leaves an archived fork in its column', () => {
    const context = setup(2);
    const { store, explorationId, forkIds } = context;
    store.addBoardColumn(explorationId, 'system');
    const [system] = store.snapshot(explorationId).exploration.boardColumns;
    store.moveFork(forkIds[0]!, system!.id, null);
    store.archiveFork(forkIds[0]!);
    const archived = store.snapshot(explorationId).forks.find((fork) => fork.id === forkIds[0])!;
    expect(archived.boardColumnId).toBe(system!.id);
  });

  it('frees the forks of a deleted column to Ungrouped, archived ones too', () => {
    const context = setup(3);
    const { store, explorationId, forkIds } = context;
    store.addBoardColumn(explorationId, 'system');
    const [system] = store.snapshot(explorationId).exploration.boardColumns;
    store.moveFork(forkIds[0]!, system!.id, null);
    store.moveFork(forkIds[1]!, system!.id, forkIds[0]!);
    store.archiveFork(forkIds[1]!);
    store.deleteBoardColumn(explorationId, system!.id);
    expect(store.snapshot(explorationId).exploration.boardColumns).toEqual([]);
    expect(column(context, null)).toEqual([forkIds[2], forkIds[0], forkIds[1]]);
  });
});

describe('a fork comment that picks a column', () => {
  function forkFromComment(context: ReturnType<typeof setup>, choice: string | null) {
    const { store, explorationId, mainForkId, answer } = context;
    store.createComment(explorationId, {
      messageId: answer.id,
      viewForkId: mainForkId,
      quote: 'some text',
      startOffset: 16,
      endOffset: 25,
      body: 'Go deeper',
      type: 'fork',
      boardColumnChoice: choice,
    });
    store.submit(explorationId, mainForkId, '');
    store.deliverQueued(explorationId);
    return store.pendingForks(explorationId).at(-1)!.forkId;
  }

  it('puts the fork in the column it names, at the bottom', () => {
    const context = setup(1);
    const { store, explorationId, forkIds } = context;
    store.addBoardColumn(explorationId, 'system');
    const [system] = store.snapshot(explorationId).exploration.boardColumns;
    store.moveFork(forkIds[0]!, system!.id, null);
    const created = forkFromComment(context, system!.id);
    expect(column(context, system!.id)).toEqual([forkIds[0], created]);
  });

  it('leaves the fork ungrouped on request, and in its parent column otherwise', () => {
    const context = setup(0);
    const first = forkFromComment(context, 'ungrouped');
    const second = forkFromComment(context, null);
    expect(column(context, null)).toEqual([first, second]);
  });

  it('makes a column for "new" and tells the page about it', () => {
    const context = setup(0);
    const created = forkFromComment(context, 'new');
    const [made] = context.store.snapshot(context.explorationId).exploration.boardColumns;
    expect(made!.name).toBe('Group 1');
    expect(column(context, made!.id)).toEqual([created]);
    expect(
      context.events.some(
        (event) =>
          event.type === 'exploration.updated' && event.exploration.boardColumns.length === 1,
      ),
    ).toBe(true);
  });

  it('ignores a column that was deleted meanwhile', () => {
    const context = setup(0);
    context.store.addBoardColumn(context.explorationId, 'system');
    const [system] = context.store.snapshot(context.explorationId).exploration.boardColumns;
    context.store.deleteBoardColumn(context.explorationId, system!.id);
    const created = forkFromComment(context, system!.id);
    expect(column(context, null)).toEqual([created]);
  });
});
