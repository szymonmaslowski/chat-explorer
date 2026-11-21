import type { BoardColumn, Fork } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { boardLayout, dropAnchor, withAncestors } from '../src/lib/board';

function fork(id: string, parent: string | null, column: string | null, position: number): Fork {
  return {
    id,
    explorationId: 'chat_x',
    parentForkId: parent,
    boardColumnId: column,
    boardPosition: position,
    createdAt: position,
  } as Fork;
}

const columns: BoardColumn[] = [
  { id: 'c1', name: 'system' },
  { id: 'c2', name: 'UX' },
];

describe('boardLayout', () => {
  const forks = [
    fork('main', null, null, 0),
    fork('a', 'main', 'c1', 1),
    fork('b', 'main', 'c1', 0),
    fork('c', 'main', null, 2),
    fork('d', 'main', 'gone', 3),
  ];

  it('orders each column by place and puts the main fork apart', () => {
    const layout = boardLayout(forks, columns, new Set(), false);
    expect(layout.main?.id).toBe('main');
    expect(layout.columns.map((view) => view.forks.map((each) => each.id))).toEqual([
      ['b', 'a'],
      [],
    ]);
  });

  it('treats a fork of a column that no longer exists as ungrouped', () => {
    expect(boardLayout(forks, columns, new Set(), false).ungrouped.map((f) => f.id)).toEqual([
      'c',
      'd',
    ]);
  });

  it('shows only archived forks, in the columns that hold one, keeping their order', () => {
    const layout = boardLayout(forks, columns, new Set(['a', 'd']), true);
    expect(layout.columns.map((view) => view.column.id)).toEqual(['c1']);
    expect(layout.columns[0]!.forks.map((f) => f.id)).toEqual(['a']);
    expect(layout.ungrouped.map((f) => f.id)).toEqual(['d']);
  });

  it('hides archived forks in the normal view but keeps their column', () => {
    const layout = boardLayout(forks, columns, new Set(['a']), false);
    expect(layout.columns[0]!.forks.map((f) => f.id)).toEqual(['b']);
    expect(layout.columns).toHaveLength(2);
  });
});

describe('withAncestors', () => {
  it('adds each parent up to the main fork', () => {
    const map = new Map(
      [fork('main', null, null, 0), fork('a', 'main', null, 1), fork('b', 'a', null, 2)].map(
        (each) => [each.id, each],
      ),
    );
    expect([...withAncestors(map, new Set(['b']))].sort()).toEqual(['a', 'b', 'main']);
  });
});

describe('dropAnchor', () => {
  it('names the card to drop after, ignoring the dragged one', () => {
    expect(dropAnchor(['a', 'b', 'c'], 'b', 0)).toBeNull();
    expect(dropAnchor(['a', 'b', 'c'], 'b', 1)).toBe('a');
    expect(dropAnchor(['a', 'b', 'c'], 'a', 2)).toBe('c');
    expect(dropAnchor(['a', 'b', 'c'], 'a', 99)).toBe('c');
    expect(dropAnchor([], 'x', 0)).toBeNull();
  });
});
