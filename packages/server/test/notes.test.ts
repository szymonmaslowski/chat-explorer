import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Database } from '../src/db/database.js';
import { migrations } from '../src/db/schema.js';
import { defaultGroupName, reorderedIds } from '../src/shared/notes.js';
import { createTestApp, createTestStore, seedConversation } from './helpers.js';

function setup() {
  const context = createTestStore();
  const conversation = seedConversation(context.store);
  return { ...context, ...conversation };
}

function seedNotes(topics: string[]) {
  const context = setup();
  const group = context.store.createNoteGroup(context.explorationId, {});
  // Each new note goes first, so they are added in reverse to read in the given order.
  const notes = topics
    .toReversed()
    .map((topic) => context.store.createNote(context.explorationId, { groupId: group.id, topic }))
    .toReversed();
  const order = () =>
    context.store
      .snapshot(context.explorationId)
      .notes.filter((note) => note.groupId === group.id)
      .map((note) => note.topic);
  return { ...context, group, notes, order };
}

describe('note groups', () => {
  it('names the first group General and later ones by the next free number', () => {
    expect(defaultGroupName([])).toBe('General');
    expect(defaultGroupName(['General'])).toBe('Group 2');
    expect(defaultGroupName(['General', 'Group 3'])).toBe('Group 4');
    const { store, explorationId } = setup();
    expect(store.createNoteGroup(explorationId, {}).name).toBe('General');
    expect(store.createNoteGroup(explorationId, { name: ' Shopping ' }).name).toBe('Shopping');
    expect(store.createNoteGroup(explorationId, { name: '' }).name).toBe('Group 3');
  });

  it('creates a group once for a repeated request', () => {
    const { store, explorationId, events } = setup();
    const first = store.createNoteGroup(explorationId, { id: 'grp0000001', name: 'Ideas' });
    const second = store.createNoteGroup(explorationId, { id: 'grp0000001', name: 'Ideas' });
    expect(second).toEqual(first);
    expect(events.filter((event) => event.type === 'note-group.created')).toHaveLength(1);
  });

  it('renames a group and switches it to a checklist', () => {
    const { store, explorationId } = setup();
    const group = store.createNoteGroup(explorationId, {});
    expect(store.updateNoteGroup(group.id, { name: 'Shopping', checklist: true })).toMatchObject({
      name: 'Shopping',
      checklist: true,
    });
    expect(store.updateNoteGroup(group.id, { name: '' }).name).toBe('General');
  });

  it('keeps the ticks when checklist mode goes off', () => {
    const { store, group, notes } = seedNotes(['Milk']);
    store.updateNoteGroup(group.id, { checklist: true });
    store.updateNote(notes[0]!.id, { checked: true });
    store.updateNoteGroup(group.id, { checklist: false });
    expect(store.updateNoteGroup(group.id, { checklist: true }).checklist).toBe(true);
    expect(store.snapshot(group.explorationId).notes[0]!.checked).toBe(true);
  });

  it('deletes a group with its notes', () => {
    const { store, explorationId, group, events } = seedNotes(['A', 'B']);
    store.deleteNoteGroup(group.id);
    const snapshot = store.snapshot(explorationId);
    expect(snapshot.noteGroups).toEqual([]);
    expect(snapshot.notes).toEqual([]);
    expect(events.at(-1)).toEqual({ type: 'note-group.deleted', groupId: group.id });
  });
});

describe('notes', () => {
  it('puts a new note first and announces the order', () => {
    const { store, explorationId, group, events, order } = seedNotes(['A', 'B']);
    const note = store.createNote(explorationId, { groupId: group.id, topic: 'New' });
    expect(order()).toEqual(['New', 'A', 'B']);
    expect(events.slice(-2)).toEqual([
      { type: 'note.created', note },
      {
        type: 'notes.reordered',
        groupId: group.id,
        noteIds: store.snapshot(explorationId).notes.map((each) => each.id),
      },
    ]);
  });

  it('needs a topic or a description', () => {
    const { store, explorationId, group, notes } = seedNotes(['A']);
    expect(() =>
      store.createNote(explorationId, { groupId: group.id, topic: ' ', description: '' }),
    ).toThrow(expect.objectContaining({ code: 'invalid' }));
    const described = store.createNote(explorationId, {
      groupId: group.id,
      description: 'Only words',
    });
    expect(described).toMatchObject({ topic: null, description: 'Only words', createdBy: 'user' });
    expect(() => store.updateNote(notes[0]!.id, { topic: '' })).toThrow(
      expect.objectContaining({ code: 'invalid' }),
    );
  });

  it('edits, ticks and deletes a note', () => {
    const { store, explorationId, notes } = seedNotes(['A']);
    const note = notes[0]!;
    expect(store.updateNote(note.id, { topic: 'Milk', description: '1.5%' })).toMatchObject({
      topic: 'Milk',
      description: '1.5%',
      checked: false,
    });
    expect(store.updateNote(note.id, { checked: true }).checked).toBe(true);
    store.deleteNote(note.id);
    expect(store.snapshot(explorationId).notes).toEqual([]);
  });

  it('rejects a group from another chat', () => {
    const { store, explorationId } = setup();
    const other = seedConversation(store);
    const otherGroup = store.createNoteGroup(other.explorationId, {});
    expect(() => store.createNote(explorationId, { groupId: otherGroup.id, topic: 'A' })).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
  });

  it('refuses changes in an archived chat', () => {
    const { store, explorationId, group } = seedNotes([]);
    store.archiveExploration(explorationId);
    expect(() => store.createNote(explorationId, { groupId: group.id, topic: 'A' })).toThrow(
      expect.objectContaining({ code: 'archived' }),
    );
  });
});

describe('reordering notes', () => {
  it('moves a note after another one or to the top', () => {
    const { store, notes, order } = seedNotes(['A', 'B', 'C', 'D']);
    const [a, b, , d] = notes;
    store.reorderNote(a!.id, d!.id);
    expect(order()).toEqual(['B', 'C', 'D', 'A']);
    store.reorderNote(d!.id, null);
    expect(order()).toEqual(['D', 'B', 'C', 'A']);
    store.reorderNote(a!.id, b!.id);
    expect(order()).toEqual(['D', 'B', 'A', 'C']);
  });

  it('keeps moves and notes made elsewhere when a stale view sends its move', () => {
    const { store, explorationId, group, notes, order } = seedNotes(['A', 'B', 'C']);
    const [a, b, c] = notes;
    // Another device moves C to the top and Claude adds a note; then a phone that still shows
    // A, B, C asks for A after B.
    store.reorderNote(c!.id, null);
    store.createNote(explorationId, { groupId: group.id, topic: 'New' });
    store.reorderNote(a!.id, b!.id);
    expect(order()).toEqual(['New', 'C', 'B', 'A']);
  });

  it('leaves the order alone when the anchor is gone', () => {
    const { store, notes, order, events } = seedNotes(['A', 'B', 'C']);
    const [a, , c] = notes;
    store.deleteNote(c!.id);
    store.reorderNote(a!.id, c!.id);
    expect(order()).toEqual(['A', 'B']);
    expect(events.at(-1)).toMatchObject({ type: 'notes.reordered' });
  });

  it('computes the same order as the page does', () => {
    expect(reorderedIds(['a', 'b', 'c'], 'c', 'a')).toEqual(['a', 'c', 'b']);
    expect(reorderedIds(['a', 'b', 'c'], 'b', null)).toEqual(['b', 'a', 'c']);
    expect(reorderedIds(['a', 'b'], 'missing', null)).toEqual(['a', 'b']);
    expect(reorderedIds(['a', 'b'], 'a', 'a')).toEqual(['a', 'b']);
  });
});

describe('changing a note group', () => {
  it('puts the note first in its new group and closes the gap in the old one', () => {
    const { store, explorationId, notes, order, events } = seedNotes(['A', 'B', 'C']);
    const target = store.createNoteGroup(explorationId, { name: 'Backlog' });
    const kept = store.createNote(explorationId, { groupId: target.id, topic: 'Old' });
    const { note, noteIds } = store.changeNoteGroup(notes[1]!.id, target.id);
    expect(note.groupId).toBe(target.id);
    expect(noteIds).toEqual([notes[1]!.id, kept.id]);
    expect(order()).toEqual(['A', 'C']);
    const positions = store.snapshot(explorationId).notes.map((each) => each.position);
    expect(positions.toSorted()).toEqual([1, 1, 2, 2]);
    expect(events.at(-1)).toEqual({ type: 'note.group-changed', note, noteIds });
  });

  it('keeps the tick', () => {
    const { store, explorationId, notes } = seedNotes(['A']);
    store.updateNote(notes[0]!.id, { checked: true });
    const target = store.createNoteGroup(explorationId, {});
    expect(store.changeNoteGroup(notes[0]!.id, target.id).note.checked).toBe(true);
  });

  it('changes nothing for the group the note is already in', () => {
    const { store, group, notes, order } = seedNotes(['A', 'B']);
    store.changeNoteGroup(notes[1]!.id, group.id);
    expect(order()).toEqual(['A', 'B']);
  });
});

describe('notes API', () => {
  it('creates, changes, reorders and deletes through REST', async () => {
    const { request, store } = createTestApp();
    const { explorationId } = seedConversation(store);
    const json = (path: string, method: string, body?: object) =>
      request(path, body ? { method, json: body } : { method });

    const group = await (
      await json(`/api/explorations/${explorationId}/note-groups`, 'POST', { id: 'grp0000001' })
    ).json();
    expect(group).toMatchObject({ id: 'grp0000001', name: 'General', checklist: false });
    const backlog = await (
      await json(`/api/explorations/${explorationId}/note-groups`, 'POST', { name: 'Backlog' })
    ).json();

    const created = await json(`/api/explorations/${explorationId}/notes`, 'POST', {
      id: 'nte0000001',
      groupId: group.id,
      topic: 'First',
    });
    expect(created.status).toBe(201);
    await json(`/api/explorations/${explorationId}/notes`, 'POST', {
      id: 'nte0000002',
      groupId: group.id,
      description: 'Second',
    });
    expect(
      (await json('/api/notes/nte0000001', 'PATCH', { checked: true, topic: 'One' })).status,
    ).toBe(200);
    expect(
      await (
        await json('/api/notes/nte0000002/reorder', 'POST', { afterNoteId: 'nte0000001' })
      ).json(),
    ).toEqual({ groupId: group.id, noteIds: ['nte0000001', 'nte0000002'] });
    expect(
      await (await json('/api/notes/nte0000002/group', 'PUT', { groupId: backlog.id })).json(),
    ).toMatchObject({ note: { groupId: backlog.id }, noteIds: ['nte0000002'] });
    expect((await json('/api/note-groups/grp0000001', 'PATCH', { checklist: true })).status).toBe(
      200,
    );

    const snapshot = await (await request(`/api/explorations/${explorationId}`)).json();
    expect(snapshot.noteGroups.map((each: { name: string }) => each.name)).toEqual([
      'General',
      'Backlog',
    ]);
    expect(snapshot.notes).toHaveLength(2);

    expect((await json('/api/notes/nte0000001', 'DELETE')).status).toBe(200);
    expect((await json('/api/notes/nte0000001', 'DELETE')).status).toBe(404);
    expect((await json('/api/note-groups/grp0000001', 'DELETE')).status).toBe(200);
  });

  it('rejects a note without a topic or a description', async () => {
    const { request, store } = createTestApp();
    const { explorationId } = seedConversation(store);
    const group = store.createNoteGroup(explorationId, {});
    const response = await request(`/api/explorations/${explorationId}/notes`, {
      method: 'POST',
      json: { groupId: group.id },
    });
    expect(response.status).toBe(400);
  });
});

describe('migration 8', () => {
  it('keeps comment types and accepts the note type', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'chat-explorer-migration-')), 'test.db');
    const old = new DatabaseSync(path);
    for (const migration of migrations.slice(0, 7)) old.exec(migration);
    old.exec(`PRAGMA user_version = 7;
      INSERT INTO explorations (id, created_at, updated_at) VALUES ('e', 1, 1);
      INSERT INTO comments (id, exploration_id, message_id, view_fork_id, quote, start_offset,
        end_offset, body, type, status, created_at, updated_at)
      VALUES ('c1', 'e', 'm', 'f', 'q', 0, 1, 'b', 'fork', 'draft', 1, 1),
             ('c2', 'e', 'm', 'f', 'q', 0, 1, 'b', 'inline', 'draft', 1, 1);`);
    old.close();

    const database = new Database(path);
    expect(database.get<{ user_version: number }>('PRAGMA user_version')).toEqual({
      user_version: migrations.length,
    });
    expect(database.all('SELECT id, type FROM comments ORDER BY id')).toEqual([
      { id: 'c1', type: 'fork' },
      { id: 'c2', type: 'inline' },
    ]);
    database.run("UPDATE comments SET type = 'note' WHERE id = 'c1'");
    expect(() => database.run("UPDATE comments SET type = 'other' WHERE id = 'c1'")).toThrow(
      /comment_type/,
    );
    database.close();
  });
});
