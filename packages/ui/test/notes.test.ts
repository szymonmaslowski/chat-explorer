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
      snapshot: unreachable,
    },
  };
});

const { applyChange, applyServerEvent } = await import('../src/stores/exploration');
const { outbox } = await import('../src/stores/outbox');
const { notesInGroup } = await import('../src/lib/notes');

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

const note = (id: string, groupId: string, position: number): Note => ({
  id,
  explorationId,
  groupId,
  topic: id,
  description: '',
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
