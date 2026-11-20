import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Database } from '../src/db/database.js';
import { migrations } from '../src/db/schema.js';
import { defaultGroupName, noteForkMessage, reorderedIds } from '@chat-explorer/shared/notes.js';
import { createTestApp, createTestStore, draft, seedConversation } from './helpers.js';

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

  it('takes changes in an archived chat', () => {
    const { store, explorationId, group } = seedNotes([]);
    store.archiveExploration(explorationId);
    expect(store.createNote(explorationId, { groupId: group.id, topic: 'A' })).toMatchObject({
      topic: 'A',
    });
  });
});

describe('reordering note groups', () => {
  it('moves a group after another one or to the start, and tells the open pages', () => {
    const { store, explorationId, events } = setup();
    const [a, b, c] = ['A', 'B', 'C'].map((name) => store.createNoteGroup(explorationId, { name }));
    const order = () => store.snapshot(explorationId).noteGroups.map((group) => group.name);
    store.reorderNoteGroup(a!.id, c!.id);
    expect(order()).toEqual(['B', 'C', 'A']);
    store.reorderNoteGroup(c!.id, null);
    expect(order()).toEqual(['C', 'B', 'A']);
    expect(events.at(-1)).toEqual({
      type: 'note-groups.reordered',
      groupIds: [c!.id, b!.id, a!.id],
    });
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

describe('note categories', () => {
  const categoryOf = (context: ReturnType<typeof seedNotes>, noteId: string) =>
    context.store.snapshot(context.explorationId).notes.find((note) => note.id === noteId)
      ?.category;

  it('sets, changes and clears the category of a note', () => {
    const context = seedNotes(['Milk']);
    const [milk] = context.notes;
    expect(categoryOf(context, milk!.id)).toBeNull();
    context.store.updateNote(milk!.id, { category: ' Dairy ' });
    expect(categoryOf(context, milk!.id)).toBe('Dairy');
    context.store.updateNote(milk!.id, { topic: 'Milk 2%' });
    expect(categoryOf(context, milk!.id)).toBe('Dairy');
    context.store.updateNote(milk!.id, { category: '' });
    expect(categoryOf(context, milk!.id)).toBeNull();
    context.store.updateNote(milk!.id, { category: 'Dairy' });
    context.store.updateNote(milk!.id, { category: null });
    expect(categoryOf(context, milk!.id)).toBeNull();
  });

  it('refuses a very long name', () => {
    const context = seedNotes(['Milk']);
    expect(() =>
      context.store.updateNote(context.notes[0]!.id, { category: 'x'.repeat(81) }),
    ).toThrow(/at most 80/);
  });

  it('puts a note at the top of its category, and one with no category at the top of the group', () => {
    const context = seedNotes([]);
    const add = (topic: string, category?: string) =>
      context.store.createNote(context.explorationId, {
        groupId: context.group.id,
        topic,
        ...(category ? { category } : {}),
      });
    const order = () =>
      context.store
        .snapshot(context.explorationId)
        .notes.filter((note) => note.groupId === context.group.id)
        .map((note) => note.topic);
    add('Apple', 'Fruit');
    add('Cheese', 'Dairy');
    add('Milk', 'Dairy');
    // Cheese has no category of its own yet, so it goes to the top; Milk joins above it.
    expect(order()).toEqual(['Milk', 'Cheese', 'Apple']);
    add('Salt');
    add('Bread', 'Bakery');
    expect(order()).toEqual(['Bread', 'Salt', 'Milk', 'Cheese', 'Apple']);
  });

  it('puts a note that joins a category at the top of it, and tells the pages', () => {
    const context = seedNotes(['Apple', 'Salt', 'Milk']);
    const [apple, salt, milk] = context.notes;
    context.store.updateNote(apple!.id, { category: 'Fruit' });
    context.store.updateNote(milk!.id, { category: 'Dairy' });
    context.events.length = 0;
    context.store.updateNote(salt!.id, { category: 'Dairy' });
    expect(context.order()).toEqual(['Apple', 'Salt', 'Milk']);
    context.store.updateNote(apple!.id, { category: 'Dairy' });
    expect(context.order()).toEqual(['Apple', 'Salt', 'Milk']);
    expect(context.events.map((event) => event.type)).toContain('notes.reordered');
    // An edit that leaves the category alone moves nothing.
    context.store.updateNote(milk!.id, { topic: 'Milk 2%' });
    expect(context.order()).toEqual(['Apple', 'Salt', 'Milk 2%']);
  });

  it('renames a category for all its notes and keeps their order', () => {
    const context = seedNotes(['Milk', 'Salt', 'Cheese']);
    const [milk, salt, cheese] = context.notes;
    context.store.updateNote(cheese!.id, { category: 'Dairy' });
    context.store.updateNote(milk!.id, { category: 'Dairy' });
    context.store.updateNote(salt!.id, { category: 'Spices' });
    const before = context.order();
    context.events.length = 0;
    const { noteIds } = context.store.renameNoteCategory(context.group.id, 'Dairy', ' Nabiał ');
    expect(noteIds).toHaveLength(2);
    expect(context.events.filter((event) => event.type === 'note.updated')).toHaveLength(2);
    expect(context.order()).toEqual(before);
    expect(categoryOf(context, milk!.id)).toBe('Nabiał');
    expect(categoryOf(context, cheese!.id)).toBe('Nabiał');
    expect(categoryOf(context, salt!.id)).toBe('Spices');
    context.store.renameNoteCategory(context.group.id, 'Nabiał', null);
    expect(categoryOf(context, milk!.id)).toBeNull();
  });

  it('refuses to rename a category the group does not have', () => {
    const context = seedNotes(['Milk']);
    expect(() => context.store.renameNoteCategory(context.group.id, 'Dairy', 'Nabiał')).toThrow(
      /no category/,
    );
    expect(() => context.store.renameNoteCategory(context.group.id, ' ', 'Nabiał')).toThrow(
      /Name the category/,
    );
  });

  it('lets Claude name a category when adding notes, and lists it', () => {
    const context = seedNotes([]);
    const { noteIds } = context.store.addNotes({
      explorationId: context.explorationId,
      groupId: context.group.id,
      notes: [{ topic: 'Milk', category: 'Dairy' }, { topic: 'Salt' }],
    });
    expect(categoryOf(context, noteIds[0]!)).toBe('Dairy');
    expect(categoryOf(context, noteIds[1]!)).toBeNull();
    const listed = context.store.listNotes(context.explorationId).groups[0]!.notes;
    expect(listed.map((note) => note.category)).toEqual(['Dairy', null]);
  });

  it('takes a note out of its category when it moves to another group', () => {
    const context = seedNotes(['Milk']);
    const other = context.store.createNoteGroup(context.explorationId, {});
    context.store.updateNote(context.notes[0]!.id, { category: 'Dairy' });
    context.store.changeNoteGroup(context.notes[0]!.id, other.id);
    expect(categoryOf(context, context.notes[0]!.id)).toBeNull();
  });

  it('keeps the category on the copy made from an overtaken edit', () => {
    const context = seedNotes(['Milk']);
    const milk = context.notes[0]!;
    context.store.updateNote(milk.id, { category: 'Dairy' });
    const updated = context.store
      .snapshot(context.explorationId)
      .notes.find((n) => n.id === milk.id)!;
    context.store.updateNote(milk.id, { topic: 'Elsewhere' }, 'phone');
    context.store.updateNote(
      milk.id,
      { topic: 'Late', baseUpdatedAt: updated.updatedAt - 1, editedAt: updated.updatedAt - 1 },
      'laptop',
    );
    const copy = context.store
      .snapshot(context.explorationId)
      .notes.find((note) => note.topic?.endsWith('(other version)'));
    expect(copy?.category).toBe('Dairy');
  });

  it('accepts a category over REST', async () => {
    const { request, store } = createTestApp();
    const { explorationId } = seedConversation(store);
    const send = (path: string, method: string, body: object) =>
      request(path, { method, json: body });
    const group = await (
      await send(`/api/explorations/${explorationId}/note-groups`, 'POST', {})
    ).json();
    const note = await (
      await send(`/api/explorations/${explorationId}/notes`, 'POST', {
        groupId: group.id,
        topic: 'Milk',
        category: 'Dairy',
      })
    ).json();
    expect(note.category).toBe('Dairy');
    const cleared = await send(`/api/notes/${note.id}`, 'PATCH', { category: null });
    expect((await cleared.json()).category).toBeNull();
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
      id: 'note_nte0000001',
      groupId: group.id,
      topic: 'First',
    });
    expect(created.status).toBe(201);
    await json(`/api/explorations/${explorationId}/notes`, 'POST', {
      id: 'note_nte0000002',
      groupId: group.id,
      description: 'Second',
    });
    expect(
      (await json('/api/notes/note_nte0000001', 'PATCH', { checked: true, topic: 'One' })).status,
    ).toBe(200);
    expect(
      await (
        await json('/api/notes/note_nte0000002/reorder', 'POST', { afterNoteId: 'note_nte0000001' })
      ).json(),
    ).toEqual({ groupId: group.id, noteIds: ['note_nte0000001', 'note_nte0000002'] });
    expect(
      await (await json('/api/notes/note_nte0000002/group', 'PUT', { groupId: backlog.id })).json(),
    ).toMatchObject({ note: { groupId: backlog.id }, noteIds: ['note_nte0000002'] });
    expect((await json('/api/note-groups/grp0000001', 'PATCH', { checklist: true })).status).toBe(
      200,
    );

    const snapshot = await (await request(`/api/explorations/${explorationId}`)).json();
    expect(snapshot.noteGroups.map((each: { name: string }) => each.name)).toEqual([
      'General',
      'Backlog',
    ]);
    expect(snapshot.notes).toHaveLength(2);

    expect((await json('/api/notes/note_nte0000001', 'DELETE')).status).toBe(200);
    expect((await json('/api/notes/note_nte0000001', 'DELETE')).status).toBe(404);
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

describe('forking from a note', () => {
  it('starts a fork of the main fork at once, holding the message that names the note', () => {
    const { store, explorationId, mainForkId, answer, events } = setup();
    const group = store.createNoteGroup(explorationId, {});
    const note = store.createNote(explorationId, { groupId: group.id, topic: 'Cache [v2]' });
    const comment = draft(store, explorationId, {
      messageId: answer.id,
      viewForkId: mainForkId,
      body: 'Unrelated draft',
    });

    const submission = store.forkFromNote(note.id, '  How do we invalidate it?  ', {
      id: 'sbm0000001',
      forkId: 'fork_frk0000001',
    });

    expect(submission).toMatchObject({ forkId: 'fork_frk0000001', newFork: false });
    expect(
      store.snapshot(explorationId).forks.find((fork) => fork.id === 'fork_frk0000001'),
    ).toMatchObject({
      parentForkId: mainForkId,
      baseMessageId: answer.id,
      tipMessageId: null,
      summary: 'How do we invalidate it?',
    });
    expect(submission.globalMessage).toBe(
      `Regarding note [Cache \\[v2\\]](/e/${explorationId}/notes#n-${note.id}) (id \`${note.id}\`):\n\nHow do we invalidate it?`,
    );
    expect(
      store.snapshot(explorationId).comments.find((each) => each.id === comment.id),
    ).toMatchObject({ status: 'draft' });
    expect(store.forkFromNote(note.id, 'Again', { id: 'sbm0000001' })).toEqual(submission);
    expect(events.filter((event) => event.type === 'submission.queued')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'fork.created')).toHaveLength(1);

    store.deliverQueued(explorationId);
    const [pending] = store.pendingForks(explorationId);
    expect(pending).toMatchObject({
      forkId: 'fork_frk0000001',
      isNewFork: true,
      baseMessageId: answer.id,
      userMessages: [{ text: submission.globalMessage }],
    });
  });

  it('names a note without a topic by its id, and needs a message', () => {
    const { store, explorationId } = setup();
    const group = store.createNoteGroup(explorationId, {});
    const note = store.createNote(explorationId, { groupId: group.id, description: 'Only words' });
    expect(noteForkMessage(note, 'Hi')).toContain(`[${note.id}](`);
    expect(() => store.forkFromNote(note.id, '  ')).toThrow('Write a message for the new fork.');
  });

  it('is offered through REST', async () => {
    const { request, store } = createTestApp();
    const { explorationId } = seedConversation(store);
    const group = store.createNoteGroup(explorationId, {});
    const note = store.createNote(explorationId, { groupId: group.id, topic: 'Topic' });
    const created = await request(`/api/notes/${note.id}/fork`, {
      method: 'POST',
      json: { id: 'sbm0000001', forkId: 'fork_frk0000001', message: 'Tell me more' },
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id: 'sbm0000001', forkId: 'fork_frk0000001' });
    const empty = await request(`/api/notes/${note.id}/fork`, {
      method: 'POST',
      json: { message: '' },
    });
    expect(empty.status).toBe(400);
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

describe('note comments', () => {
  function noteComment(
    context: ReturnType<typeof setup>,
    input: {
      body: string;
      noteGroupId?: string | null;
      quote?: string;
      startOffset?: number;
      endOffset?: number;
    },
  ) {
    return context.store.createComment(context.explorationId, {
      messageId: context.answer.id,
      viewForkId: context.mainForkId,
      quote: 'some text',
      startOffset: 16,
      endOffset: 25,
      type: 'note',
      ...input,
    });
  }

  it('turns a general comment into a note with only its text', () => {
    const context = setup();
    const { store, explorationId, mainForkId } = context;
    noteComment(context, { body: 'Remember this', quote: '', startOffset: 0, endOffset: 0 });
    store.submit(explorationId, mainForkId, '');
    expect(store.snapshot(explorationId).notes[0]).toMatchObject({
      description: 'Remember this',
    });
  });

  it('turns into a note on Submit without asking Claude anything', () => {
    const context = setup();
    const { store, explorationId, mainForkId, answer } = context;
    const shopping = store.createNoteGroup(explorationId, { name: 'Shopping' });
    store.createNoteGroup(explorationId, { name: 'Backlog' });
    const comment = noteComment(context, { body: 'Buy this', noteGroupId: shopping.id });

    store.submit(explorationId, mainForkId, '');

    const snapshot = store.snapshot(explorationId);
    const [note] = snapshot.notes;
    expect(note).toMatchObject({
      groupId: shopping.id,
      topic: null,
      description: '> some text\n\nBuy this',
      sourceForkId: mainForkId,
      sourceMessageId: answer.id,
      sourceQuote: 'some text',
      sourceCommentId: comment.id,
      createdBy: 'user',
    });
    expect(snapshot.comments[0]).toMatchObject({ status: 'submitted', createdNoteId: note!.id });
    expect(snapshot.queuedSubmissions).toEqual([]);
    expect(store.pendingForks(explorationId)).toEqual([]);
  });

  it('makes a new group only on Submit, one for all the comments that ask for it', () => {
    const context = setup();
    const { store, explorationId, mainForkId } = context;
    store.createNoteGroup(explorationId, { name: 'Facts' });
    noteComment(context, { body: 'First' });
    noteComment(context, { body: 'Second', noteGroupId: null });
    expect(store.snapshot(explorationId).noteGroups).toHaveLength(1);
    store.submit(explorationId, mainForkId, '');
    const { noteGroups, notes } = store.snapshot(explorationId);
    expect(noteGroups.map((group) => group.name)).toEqual(['Facts', 'Group 2']);
    expect(notes.map((note) => note.groupId)).toEqual([noteGroups[1]!.id, noteGroups[1]!.id]);
  });

  it('sends the rest of a mixed Submit to Claude and keeps the notes on cancel', () => {
    const context = setup();
    const { store, explorationId, mainForkId, answer } = context;
    noteComment(context, { body: 'Keep this' });
    draft(store, explorationId, { messageId: answer.id, viewForkId: mainForkId, body: 'Why?' });
    const submission = store.submit(explorationId, mainForkId, 'And more');
    expect(store.queuedSubmissions(explorationId)).toHaveLength(1);
    store.cancelSubmission(submission.id);
    const snapshot = store.snapshot(explorationId);
    expect(snapshot.notes).toHaveLength(1);
    expect(snapshot.comments.map((comment) => [comment.type, comment.status])).toEqual([
      ['note', 'submitted'],
      ['inline', 'draft'],
    ]);
  });

  it('makes one note for a repeated Submit', () => {
    const context = setup();
    const { store, explorationId, mainForkId } = context;
    noteComment(context, { body: 'Once' });
    store.submit(explorationId, mainForkId, '', { id: 'sbm0000001' });
    store.submit(explorationId, mainForkId, '', { id: 'sbm0000001' });
    expect(store.snapshot(explorationId).notes).toHaveLength(1);
  });

  it('needs more than notes to start a new fork', () => {
    const context = setup();
    const { store, explorationId, mainForkId } = context;
    noteComment(context, { body: 'A note' });
    expect(() => store.submit(explorationId, mainForkId, '', { newFork: true })).toThrow(
      expect.objectContaining({ code: 'invalid' }),
    );
  });

  it('rejects a group from another chat', () => {
    const context = setup();
    const other = seedConversation(context.store);
    const otherGroup = context.store.createNoteGroup(other.explorationId, {});
    expect(() => noteComment(context, { body: 'x', noteGroupId: otherGroup.id })).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
  });
});

describe('Claude and notes', () => {
  function attached() {
    const context = setup();
    context.store.attach({
      explorationId: context.explorationId,
      shimId: 'shim-a',
      sessionId: 'session-a',
      takeover: false,
    });
    return context;
  }

  it('adds notes first in the group, in order, linked to the message that asked', () => {
    const { store, explorationId, mainForkId, answer } = attached();
    const group = store.createNoteGroup(explorationId, { name: 'Shopping', checklist: true });
    store.createNote(explorationId, { groupId: group.id, topic: 'Old' });
    const { noteIds } = store.addNotes({
      explorationId,
      groupId: group.id,
      notes: [{ topic: 'Lemon' }, { topic: 'Milk', description: '1.5%' }],
      sourceMessageId: answer.id,
    });
    const notes = store.snapshot(explorationId).notes;
    expect(notes.map((note) => note.topic)).toEqual(['Lemon', 'Milk', 'Old']);
    expect(notes.map((note) => note.id).slice(0, 2)).toEqual(noteIds);
    expect(notes[0]).toMatchObject({
      createdBy: 'claude',
      sourceForkId: mainForkId,
      sourceMessageId: answer.id,
      sourceQuote: null,
    });
  });

  it('marks a note for deletion until the user keeps or deletes it', () => {
    const { store, notes, events } = seedNotes(['A']);
    const requested = store.requestNoteDeletion(notes[0]!.id);
    expect(requested.deletionRequestedAt).not.toBeNull();
    expect(events.at(-1)).toEqual({ type: 'note.updated', note: requested });
    expect(store.keepNote(notes[0]!.id).deletionRequestedAt).toBeNull();
  });

  it('lists notes without their text and reads chosen ones in full', () => {
    const { store, explorationId, group, notes } = seedNotes(['A', 'B']);
    store.requestNoteDeletion(notes[1]!.id);
    store.updateNote(notes[0]!.id, { description: 'Lemons for the cake' });
    expect(store.notesIndex(explorationId)).toEqual({
      groups: [
        {
          id: group.id,
          name: 'General',
          checklist: false,
          notes: [
            { id: notes[0]!.id, topic: 'A', category: null, checked: false },
            { id: notes[1]!.id, topic: 'B', category: null, checked: false },
          ],
        },
      ],
    });
    const listed = store.listNotes(explorationId, group.id).groups[0]!.notes;
    expect(listed[0]).toMatchObject({ topic: 'A', length: 19, createdBy: 'user' });
    expect(listed[0]).not.toHaveProperty('description');
    expect(listed[1]).toMatchObject({ topic: 'B', length: 0, deletionRequested: true });

    expect(store.readNotes(explorationId, [notes[0]!.id])).toEqual({
      notes: [
        expect.objectContaining({
          id: notes[0]!.id,
          groupId: group.id,
          groupName: 'General',
          description: 'Lemons for the cake',
        }),
      ],
      notShown: [],
    });
    const oldId = notes[0]!.id.replace('note_', '');
    expect(store.readNotes(explorationId, [oldId]).notes[0]!.id).toBe(notes[0]!.id);
  });

  it('leaves out of a read the notes past its size limit, for another call', () => {
    const { store, explorationId, notes } = seedNotes(['A', 'B', 'C']);
    for (const note of notes) store.updateNote(note.id, { description: 'x'.repeat(25_000) });
    const read = store.readNotes(
      explorationId,
      notes.map((note) => note.id),
    );
    expect(read.notes.map((note) => note.topic)).toEqual(['A']);
    expect(read.notShown).toEqual([
      { id: notes[1]!.id, topic: 'B', length: 25_000 },
      { id: notes[2]!.id, topic: 'C', length: 25_000 },
    ]);
    // A single note larger than the limit is still read, as nothing smaller can stand for it.
    store.updateNote(notes[0]!.id, { description: 'x'.repeat(50_000) });
    expect(store.readNotes(explorationId, [notes[0]!.id]).notes).toHaveLength(1);
  });

  it('reads only notes of the same chat', () => {
    const { store, notes } = seedNotes(['A']);
    const { exploration: other } = store.createExploration();
    expect(() => store.readNotes(other.id, [notes[0]!.id])).toThrow(/not in this chat/);
  });

  it('finds notes holding every word, with a snippet around them', () => {
    const { store, explorationId, notes } = seedNotes(['Shopping', 'Deploy', 'Cloud']);
    store.updateNote(notes[0]!.id, { description: 'Milk and bread' });
    store.updateNote(notes[1]!.id, {
      description: `${'Intro. '.repeat(30)}Use Cloud Run with a CDN in front.`,
    });
    store.updateNote(notes[2]!.id, { description: 'Run it on GCP' });
    const found = store.searchNotes(explorationId, 'cloud RUN');
    expect(found.more).toBe(false);
    expect(found.notes.map((note) => note.topic)).toEqual(['Deploy', 'Cloud']);
    expect(found.notes[0]!.snippet).toMatch(/^….*Use Cloud Run with a CDN in front\.$/);
    expect(found.notes[1]!.snippet).toBe('Run it on GCP');
    expect(() => store.searchNotes(explorationId, '  ')).toThrow(/at least one word/);
  });

  it('wakes a waiting session for a note without a topic, once', async () => {
    const { store, hub, explorationId } = attached();
    const group = store.createNoteGroup(explorationId, {});
    const waiting = hub.waitForFeedback({ explorationId, shimId: 'shim-a', waitMs: 60_000 });
    const note = store.createNote(explorationId, { groupId: group.id, description: 'Words' });
    expect(await waiting).toMatchObject({
      status: 'feedback',
      forks: [],
      notesNeedingTopic: [{ noteId: note.id, groupId: group.id, description: 'Words' }],
      notes: { groups: [{ id: group.id, notes: [{ id: note.id, topic: null }] }] },
    });
    expect(await hub.waitForFeedback({ explorationId, shimId: 'shim-a', waitMs: 10 })).toEqual({
      status: 'timeout',
    });
    store.updateNote(note.id, { topic: 'Named' });
    expect(store.notesNeedingTopic(explorationId)).toEqual([]);
    hub.stop();
  });

  it('starts a background session for a note without a topic', () => {
    const { store, explorationId, launches } = setup();
    const group = store.createNoteGroup(explorationId, {});
    store.createNote(explorationId, { groupId: group.id, topic: 'Has one' });
    expect(launches).toHaveLength(0);
    expect(store.explorationsAwaitingClaude()).toEqual([]);
    store.createNote(explorationId, { groupId: group.id, description: 'Needs one' });
    expect(launches).toHaveLength(1);
    expect(store.explorationsAwaitingClaude()).toEqual([explorationId]);
  });
});
