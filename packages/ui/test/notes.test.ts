import type { Note, NoteGroup } from '@shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExplorationState } from '../src/stores/exploration';

vi.mock('../src/api', async (importOriginal) => {
  const { ApiError } = await importOriginal<typeof import('../src/api')>();
  const unreachable = () => Promise.reject(new TypeError('Failed to fetch'));
  return {
    ApiError,
    api: {
      createNoteGroup: unreachable,
      createNote: unreachable,
      updateNote: unreachable,
      changeNoteGroup: unreachable,
      reorderNote: unreachable,
      snapshot: unreachable,
    },
  };
});

const { applyChange, applyServerEvent } = await import('../src/stores/exploration');
const { outbox } = await import('../src/stores/outbox');
const {
  dropAnchor,
  dropRange,
  noteSections,
  notesInGroup,
  readCategoriesHidden,
  readCollapsedCategories,
  storeCategoriesHidden,
  storeCollapsedCategories,
  uncheckedFirst,
} = await import('../src/lib/notes');

const explorationId = 'e';

const group = (id: string, name: string, position: number): NoteGroup => ({
  id,
  explorationId,
  name,
  checklist: false,
  position,
  createdAt: 0,
  updatedAt: 0,
});

const note = (
  id: string,
  groupId: string,
  position: number,
  category: string | null = null,
): Note => ({
  id,
  explorationId,
  groupId,
  topic: id,
  description: '',
  category,
  checked: false,
  position,
  sourceForkId: null,
  sourceMessageId: null,
  sourceQuote: null,
  sourceCommentId: null,
  createdBy: 'user',
  deletionRequestedAt: null,
  createdAt: 0,
  updatedAt: 0,
});

function stateWith(groups: NoteGroup[], notes: Note[]) {
  return {
    explorationId,
    noteGroups: new Map(groups.map((each) => [each.id, each])),
    notes: new Map(notes.map((each) => [each.id, each])),
  } as ExplorationState;
}

const topicsIn = (state: ExplorationState, groupId: string) =>
  notesInGroup(state.notes, groupId).map((each) => each.topic);

beforeEach(() => localStorage.clear());

describe('notes shown before the daemon has them', () => {
  it('names a new group and puts a new note first', () => {
    const state = stateWith([], []);
    applyChange(state, {
      type: 'note-group.create',
      explorationId,
      group: { id: 'g1' },
    });
    applyChange(state, {
      type: 'note-group.create',
      explorationId,
      group: { id: 'g2', name: ' ' },
    });
    expect([...state.noteGroups.values()].map((each) => each.name)).toEqual(['General', 'Group 2']);
    state.notes.set('a', note('a', 'g1', 1));
    applyChange(state, {
      type: 'note.create',
      explorationId,
      note: { id: 'n', groupId: 'g1', description: 'Only words' },
    });
    expect(topicsIn(state, 'g1')).toEqual([null, 'a']);
  });

  it('moves a note first into its new group and closes the gap', () => {
    const state = stateWith(
      [group('g1', 'General', 1), group('g2', 'Backlog', 2)],
      [note('a', 'g1', 1), note('b', 'g1', 2), note('c', 'g1', 3), note('x', 'g2', 1)],
    );
    applyChange(state, { type: 'note.change-group', explorationId, noteId: 'b', groupId: 'g2' });
    expect(topicsIn(state, 'g1')).toEqual(['a', 'c']);
    expect(notesInGroup(state.notes, 'g1').map((each) => each.position)).toEqual([1, 2]);
    expect(topicsIn(state, 'g2')).toEqual(['b', 'x']);
  });

  it('deletes a group with its notes', () => {
    const state = stateWith(
      [group('g1', 'General', 1), group('g2', 'Backlog', 2)],
      [note('a', 'g1', 1), note('x', 'g2', 1)],
    );
    applyChange(state, { type: 'note-group.delete', explorationId, groupId: 'g1' });
    expect([...state.noteGroups.keys()]).toEqual(['g2']);
    expect([...state.notes.keys()]).toEqual(['x']);
  });

  it('takes the order the daemon announces', () => {
    const state = stateWith(
      [group('g1', 'General', 1)],
      [note('a', 'g1', 1), note('b', 'g1', 2), note('c', 'g1', 3)],
    );
    applyServerEvent(state, { type: 'notes.reordered', groupId: 'g1', noteIds: ['c', 'a', 'b'] });
    expect(topicsIn(state, 'g1')).toEqual(['c', 'a', 'b']);
  });

  it('keeps an edit made here when an older notice about the note arrives', () => {
    const state = stateWith([group('g1', 'General', 1)], [note('a', 'g1', 1)]);
    outbox.add({ type: 'note.update', explorationId, noteId: 'a', changes: { topic: 'Newer' } });
    applyServerEvent(state, {
      type: 'note.updated',
      note: { ...note('a', 'g1', 1), topic: 'Older' },
    });
    expect(state.notes.get('a')?.topic).toBe('Newer');
  });
});

describe('dragging a note', () => {
  const ticked = (each: Note) => ({ ...each, checked: true });
  // Stored order a, b, c, d, e; b and d are ticked, so unchecked first shows a, c, e, b, d.
  const stored = [
    note('a', 'g', 1),
    ticked(note('b', 'g', 2)),
    note('c', 'g', 3),
    ticked(note('d', 'g', 4)),
    note('e', 'g', 5),
  ];
  const sorted = uncheckedFirst(stored);

  it('goes after its new neighbour above, or to the top', () => {
    expect(dropAnchor(stored, stored, 'e', 2, false)).toBe('b');
    expect(dropAnchor(stored, stored, 'c', 0, false)).toBeNull();
    expect(dropAnchor(stored, stored, 'a', 4, false)).toBe('e');
  });

  it('stays in its part when unchecked notes come first', () => {
    expect(dropRange(sorted, 'c', true)).toEqual({ first: 0, last: 2 });
    expect(dropRange(sorted, 'b', true)).toEqual({ first: 3, last: 4 });
    expect(dropRange(sorted, 'b', false)).toEqual({ first: 0, last: 4 });
  });

  it('goes just before the note below when it lands first in its part', () => {
    // d dropped first among the ticked notes (shown a, c, e | d, b) goes before b.
    expect(dropAnchor(sorted, stored, 'd', 3, true)).toBe('a');
    // e dropped first overall goes to the top.
    expect(dropAnchor(sorted, stored, 'e', 0, true)).toBeNull();
    // e dropped after a, inside the unchecked part.
    expect(dropAnchor(sorted, stored, 'e', 1, true)).toBe('a');
  });

  it('is shown at once, and a pending drag survives an older order', () => {
    const state = stateWith(
      [group('g1', 'General', 1)],
      [note('a', 'g1', 1), note('b', 'g1', 2), note('c', 'g1', 3)],
    );
    outbox.add({ type: 'note.reorder', explorationId, noteId: 'c', afterNoteId: null });
    applyChange(state, outbox.changes.value.at(-1)!);
    expect(topicsIn(state, 'g1')).toEqual(['c', 'a', 'b']);
    applyServerEvent(state, { type: 'notes.reordered', groupId: 'g1', noteIds: ['a', 'b', 'c'] });
    expect(topicsIn(state, 'g1')).toEqual(['c', 'a', 'b']);
  });
});

describe('categories', () => {
  const stored = [
    note('a', 'g', 1, 'Dairy'),
    note('b', 'g', 2),
    note('c', 'g', 3, 'Fruit'),
    note('d', 'g', 4, 'Dairy'),
  ];

  it('shows notes with no category first, then each category where its first note is', () => {
    expect(noteSections(stored).map((each) => [each.name, each.notes.map((n) => n.id)])).toEqual([
      [null, ['b']],
      ['Dairy', ['a', 'd']],
      ['Fruit', ['c']],
    ]);
  });

  it('leaves out the section of notes with no category when there are none', () => {
    expect(noteSections([note('a', 'g', 1, 'Dairy')]).map((each) => each.name)).toEqual(['Dairy']);
  });

  it('keeps a dragged note in its category', () => {
    const shown = noteSections(stored).flatMap((each) => each.notes);
    // Shown: b, a, d, c. Another note of Dairy is at 1 among the others (b, d, c).
    expect(dropRange(shown, 'a', false)).toEqual({ first: 1, last: 2 });
    expect(dropRange(shown, 'c', false)).toEqual({ first: 3, last: 3 });
  });

  it('drops first in a category before its first note in the stored order', () => {
    const shown = noteSections(stored).flatMap((each) => each.notes);
    // d to the top of Dairy: after the note stored before a, which is none.
    expect(dropAnchor(shown, stored, 'd', 1, false)).toBeNull();
  });

  it('keeps which categories are folded on this device, per group', () => {
    storeCollapsedCategories('g', ['Dairy']);
    expect(readCollapsedCategories('g')).toEqual(['Dairy']);
    expect(readCollapsedCategories('other')).toEqual([]);
    storeCollapsedCategories('g', []);
    expect(readCollapsedCategories('g')).toEqual([]);
  });

  it('shows a category set on a new or edited note, and clears it with an empty name', () => {
    const state = stateWith([group('g', 'One', 1)], []);
    applyChange(state, {
      type: 'note.create',
      explorationId,
      note: { id: 'n', groupId: 'g', topic: 'Milk', category: ' Dairy ' },
    });
    expect(state.notes.get('n')?.category).toBe('Dairy');
    applyChange(state, {
      type: 'note.update',
      explorationId,
      noteId: 'n',
      changes: { topic: 'Milk 2%' },
    });
    expect(state.notes.get('n')?.category).toBe('Dairy');
    applyChange(state, {
      type: 'note.update',
      explorationId,
      noteId: 'n',
      changes: { category: '' },
    });
    expect(state.notes.get('n')?.category).toBeNull();
  });

  it('takes a note out of its category when it moves to another group', () => {
    const state = stateWith(
      [group('g', 'One', 1), group('h', 'Two', 2)],
      [note('a', 'g', 1, 'Dairy')],
    );
    applyChange(state, { type: 'note.change-group', explorationId, noteId: 'a', groupId: 'h' });
    expect(state.notes.get('a')?.category).toBeNull();
  });

  it('puts a new note at the top of its category, and at the top of the group with none', () => {
    const state = stateWith(
      [group('g', 'One', 1)],
      [note('a', 'g', 1, 'Fruit'), note('b', 'g', 2, 'Dairy'), note('c', 'g', 3, 'Dairy')],
    );
    const create = (id: string, category?: string) =>
      applyChange(state, {
        type: 'note.create',
        explorationId,
        note: { id, groupId: 'g', topic: id, category },
      });
    create('x', 'Dairy');
    expect(topicsIn(state, 'g')).toEqual(['a', 'x', 'b', 'c']);
    create('y');
    expect(topicsIn(state, 'g')).toEqual(['y', 'a', 'x', 'b', 'c']);
    create('z', 'Bread');
    expect(topicsIn(state, 'g')).toEqual(['z', 'y', 'a', 'x', 'b', 'c']);
  });

  it('puts a note that joins a category at the top of it', () => {
    const state = stateWith(
      [group('g', 'One', 1)],
      [note('a', 'g', 1, 'Fruit'), note('b', 'g', 2), note('c', 'g', 3, 'Dairy')],
    );
    applyChange(state, {
      type: 'note.update',
      explorationId,
      noteId: 'b',
      changes: { category: 'Dairy' },
    });
    expect(topicsIn(state, 'g')).toEqual(['a', 'b', 'c']);
    applyChange(state, {
      type: 'note.update',
      explorationId,
      noteId: 'a',
      changes: { category: 'Dairy' },
    });
    expect(topicsIn(state, 'g')).toEqual(['a', 'b', 'c']);
    applyChange(state, {
      type: 'note.update',
      explorationId,
      noteId: 'c',
      changes: { topic: 'c2' },
    });
    expect(topicsIn(state, 'g')).toEqual(['a', 'b', 'c2']);
  });

  it('moves notes freely in the plain list, and keeps the choice per group', () => {
    const shown = [note('a', 'g', 1, 'Dairy'), note('b', 'g', 2, 'Fruit'), note('c', 'g', 3)];
    expect(dropRange(shown, 'a', false, false)).toEqual({ first: 0, last: 2 });
    expect(dropAnchor(shown, shown, 'a', 2, false, false)).toBe('c');
    storeCategoriesHidden('g', true);
    expect(readCategoriesHidden('g')).toBe(true);
    expect(readCategoriesHidden('other')).toBe(false);
    storeCategoriesHidden('g', false);
    expect(readCategoriesHidden('g')).toBe(false);
  });
});
