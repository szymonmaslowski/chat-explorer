import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { createToolsApp } from '../src/api/tools-app.js';
import { RequestStore } from '../src/store/requests.js';
import { createTestApp, seedConversation } from './helpers.js';

const testToolsPort = 5000;

async function setup() {
  const context = createTestApp();
  const conversation = seedConversation(context.store);
  const { store, runs } = context;
  const tools = createToolsApp({ store, runs, toolsPort: testToolsPort });
  store.submit(conversation.explorationId, conversation.mainForkId, 'Note this down');
  const lease = runs.claim(conversation.mainForkId, 'runner-a')!;
  const [question] = runs.pendingInput(conversation.mainForkId, lease.leaseId);
  const connect = async (token: string) => {
    const client = new Client({ name: 'test', version: '1.0.0' });
    // As a coding container reaches them: on the tools listener, not the main port.
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://host.docker.internal:${testToolsPort}/api/tools/mcp`),
      {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        fetch: async (url, init) =>
          tools.request(String(url), {
            ...init,
            headers: {
              ...Object.fromEntries(new Headers(init?.headers)),
              host: `host.docker.internal:${testToolsPort}`,
            },
          }),
      },
    );
    await client.connect(transport);
    return client;
  };
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const [content] = result.content as { text: string }[];
    return {
      isError: result.isError === true,
      value: result.isError ? content!.text : JSON.parse(content!.text),
    };
  };
  return { ...context, ...conversation, lease, question: question!, connect, call };
}

describe('job tools', () => {
  it('sets the topic of an untitled note with no card, and refuses a note with one', async () => {
    const { connect, call, lease, store, explorationId } = await setup();
    const group = store.createNoteGroup(explorationId, {});
    const untitled = store.createNote(explorationId, { groupId: group.id, description: 'Bread' });
    const client = await connect(lease.toolsToken);
    const set = await call(client, 'set_note_topic', { noteId: untitled.id, topic: 'Bread' });
    expect(set.value.topic).toBe('Bread');
    const again = await call(client, 'set_note_topic', { noteId: untitled.id, topic: 'Rye' });
    expect(again).toMatchObject({ isError: true });
    expect(again.value).toMatch(/already has a topic/);
    expect(store.note(untitled.id).topic).toBe('Bread');
    expect(store.snapshot(explorationId).requests).toEqual([]);
    const other = seedConversation(store);
    const foreignGroup = store.createNoteGroup(other.explorationId, {});
    const foreign = store.createNote(other.explorationId, {
      groupId: foreignGroup.id,
      description: 'x',
    });
    expect((await call(client, 'set_note_topic', { noteId: foreign.id, topic: 'X' })).isError).toBe(
      true,
    );
  });

  it('answers right away, names the fork and adds notes linked to the asking message', async () => {
    const { connect, call, lease, store, explorationId, mainForkId, question } = await setup();
    const client = await connect(lease.toolsToken);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(tools).toEqual(
      expect.arrayContaining([
        'answer',
        'set_fork_summary',
        'list_forks',
        'read_fork',
        'add_notes',
        'list_notes',
        'read_notes',
        'search_notes',
      ]),
    );

    await call(client, 'answer', { text: 'Noted, more soon.' });
    await call(client, 'set_fork_summary', { summary: 'Caching notes' });
    // Notes wait for the user's approval, in one card; the group's id is known at once.
    const group = await call(client, 'add_note_group', { name: 'Facts' });
    expect(group.value).toMatchObject({ status: 'waiting for approval' });
    const notes = await call(client, 'add_notes', {
      groupId: group.value.groupId,
      notes: [{ topic: 'Redis' }],
      sourceMessageId: question.id,
    });
    expect(notes.value.requestId).toBe(group.value.requestId);
    expect(store.snapshot(explorationId).notes).toHaveLength(0);
    new RequestStore(store).decide(group.value.requestId, { decision: 'approve' });

    const snapshot = store.snapshot(explorationId);
    expect(snapshot.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Noted, more soon.',
    });
    expect(snapshot.forks.find((fork) => fork.id === mainForkId)!.summary).toBe('Caching notes');
    expect(snapshot.notes[0]).toMatchObject({ topic: 'Redis', sourceMessageId: question.id });
  });

  it("uses the main fork's summary as the title only while the chat has none", async () => {
    const { connect, call, lease, store, explorationId } = await setup();
    const client = await connect(lease.toolsToken);
    store.updateExploration({ explorationId, title: '' });
    expect(store.snapshot(explorationId).exploration.title).toBe('');
    await call(client, 'set_fork_summary', { summary: 'Caching notes' });
    expect(store.snapshot(explorationId).exploration.title).toBe('Caching notes');
    await call(client, 'set_fork_summary', { summary: 'Something else' });
    expect(store.snapshot(explorationId).exploration.title).toBe('Caching notes');
  });

  it('sets the title and summary with set_chat_summary', async () => {
    const { connect, call, lease, store, explorationId } = await setup();
    const client = await connect(lease.toolsToken);
    await call(client, 'set_chat_summary', { title: 'Caching', summary: 'How to cache.' });
    expect(store.snapshot(explorationId).exploration).toMatchObject({
      title: 'Caching',
      summary: 'How to cache.',
    });
  });

  it('files notes under a category, renames it and lists it', async () => {
    const { connect, call, lease, store, explorationId, mainForkId } = await setup();
    // With notes autonomous they run at once, and the result has what the store answered.
    store.setForkAutonomous(mainForkId, ['notes']);
    const client = await connect(lease.toolsToken);
    const group = await call(client, 'add_note_group', { name: 'Shopping' });
    expect(group.value.status).toBe('done');
    await call(client, 'add_notes', {
      groupId: group.value.resultId,
      notes: [{ topic: 'Milk', category: 'Dairy' }, { topic: 'Salt' }],
    });
    const [milk] = store.snapshot(explorationId).notes.filter((note) => note.topic === 'Milk');
    expect(milk!.category).toBe('Dairy');
    expect(
      (
        await call(client, 'rename_note_category', {
          groupId: group.value.resultId,
          from: 'Dairy',
          to: 'Nabiał',
        })
      ).value.result.noteIds,
    ).toEqual([milk!.id]);
    expect(
      (await call(client, 'update_note', { noteId: milk!.id, category: 'Dairy' })).value.result
        .category,
    ).toBe('Dairy');
    const listed = await call(client, 'list_notes', {});
    expect(
      listed.value.groups[0].notes.map((note: { category: string | null }) => note.category),
    ).toEqual(['Dairy', null]);
    const missing = await call(client, 'rename_note_category', {
      groupId: group.value.resultId,
      from: 'Bread',
      to: 'Bakery',
    });
    expect(missing.value.status).toBe('failed');
  });

  it('reads and arranges the board of the job chat, and only that chat', async () => {
    const { connect, call, lease, store, explorationId, mainForkId } = await setup();
    store.setForkAutonomous(mainForkId, ['board']);
    const client = await connect(lease.toolsToken);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['list_board', 'arrange_board']),
    );
    await call(client, 'arrange_board', { action: 'add_column', name: 'system' });
    const renamed = await call(client, 'arrange_board', {
      action: 'rename_column',
      column: 'system',
      name: 'platform',
    });
    expect(renamed.value.result.columns.map((column: { name: string }) => column.name)).toEqual([
      'platform',
    ]);
    expect((await call(client, 'list_board')).value).toEqual({
      columns: [expect.objectContaining({ name: 'platform', forks: [] })],
      ungrouped: [],
    });
    expect(store.snapshot(explorationId).exploration.boardColumns).toHaveLength(1);

    // The main fork is not on the board, and a fork of another chat looks like none at all.
    const mainFork = await call(client, 'arrange_board', {
      action: 'move_fork',
      forkId: mainForkId,
      column: 'platform',
    });
    expect(mainFork.value.status).toBe('failed');
    const other = seedConversation(store);
    const foreign = await call(client, 'arrange_board', {
      action: 'move_fork',
      forkId: other.mainForkId,
      column: null,
    });
    expect(foreign.isError).toBe(true);
    const unknown = await call(client, 'arrange_board', { action: 'delete_column', column: 'x' });
    expect(unknown.value.detail).toMatch(/no column/);
  });

  it('lists notes as an index, reads them by id and finds them by their words', async () => {
    const { connect, call, lease, store, explorationId } = await setup();
    const group = store.createNoteGroup(explorationId, { name: 'Facts' });
    const note = store.createNote(explorationId, { groupId: group.id, topic: 'Redis' });
    store.updateNote(note.id, { description: 'Use Redis for the session cache.' });
    const client = await connect(lease.toolsToken);

    const listed = await call(client, 'list_notes', {});
    expect(listed.value.groups[0].notes[0]).toMatchObject({ id: note.id, length: 32 });
    expect(listed.value.groups[0].notes[0]).not.toHaveProperty('description');
    const read = await call(client, 'read_notes', { noteIds: [note.id] });
    expect(read.value.notes[0]).toMatchObject({ description: 'Use Redis for the session cache.' });
    const found = await call(client, 'search_notes', { query: 'session cache' });
    expect(found.value.notes).toEqual([
      {
        id: note.id,
        groupId: group.id,
        topic: 'Redis',
        snippet: 'Use Redis for the session cache.',
      },
    ]);
  });

  it('pages back through a fork with a cursor', async () => {
    const { connect, call, lease, mainForkId } = await setup();
    const client = await connect(lease.toolsToken);
    const latest = await call(client, 'read_fork', { forkId: mainForkId, limit: 1 });
    expect(latest.value.messages.map((message: { text: string }) => message.text)).toEqual([
      'Note this down',
    ]);
    expect(latest.value.messages[0].createdAt).toEqual(expect.any(Number));
    const earlier = await call(client, 'read_fork', {
      forkId: mainForkId,
      limit: 2,
      before: latest.value.nextBefore,
    });
    expect(earlier.value.messages.map((message: { role: string }) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(earlier.value.nextBefore).toBeNull();
  });

  it('reads longer messages on request, in pages that stay within a tool result', async () => {
    const { connect, call, lease, mainForkId } = await setup();
    const client = await connect(lease.toolsToken);
    await call(client, 'answer', { text: 'a'.repeat(30_000) });
    await call(client, 'answer', { text: 'b'.repeat(30_000) });
    const sizes = (page: { messages: { text: string; truncated: boolean }[] }) =>
      page.messages.map((message) => [message.text.length, message.truncated]);

    const cut = await call(client, 'read_fork', { forkId: mainForkId, limit: 2 });
    expect(sizes(cut.value)).toEqual([
      [2_001, true],
      [2_001, true],
    ]);
    const longer = await call(client, 'read_fork', {
      forkId: mainForkId,
      limit: 2,
      maxChars: 5_000,
    });
    expect(sizes(longer.value)).toEqual([
      [5_001, true],
      [5_001, true],
    ]);
    const whole = await call(client, 'read_fork', { forkId: mainForkId, limit: 2, maxChars: 0 });
    expect(sizes(whole.value)).toEqual([[30_000, false]]);
    const before = await call(client, 'read_fork', {
      forkId: mainForkId,
      limit: 2,
      maxChars: 0,
      before: whole.value.nextBefore,
    });
    expect(sizes(before.value)).toEqual([
      ['Note this down'.length, false],
      [30_000, false],
    ]);
  });

  it("keeps to the job's chat and stops working when the lease ends", async () => {
    const { connect, call, lease, store, runs, mainForkId } = await setup();
    const other = store.createExploration({ title: 'Other' });
    const client = await connect(lease.toolsToken);
    const foreign = await call(client, 'read_fork', { forkId: other.mainFork.id });
    expect(foreign).toMatchObject({ isError: true, value: expect.stringContaining('not found') });

    runs.release(mainForkId, lease.leaseId);
    await expect(connect(lease.toolsToken)).rejects.toThrow();
  });

  it('drafts a comment in another fork for the user to send, never in its own', async () => {
    const { connect, call, lease, store, runs, explorationId, mainForkId, answer } = await setup();
    const side = store.forkAtAnswer(answer.id);
    const empty = await call(await connect(lease.toolsToken), 'draft_comment', {
      forkId: side.id,
      text: 'Too early',
    });
    expect(empty).toMatchObject({ isError: true, value: expect.stringContaining('no message') });
    store.submit(explorationId, side.id, 'Side question');
    const sideLease = runs.claim(side.id, 'runner-b')!;
    const [sideQuestion] = runs.pendingInput(side.id, sideLease.leaseId);
    const other = store.createExploration({ title: 'Other' });
    const client = await connect(lease.toolsToken);

    const drafted = await call(client, 'draft_comment', {
      forkId: side.id,
      text: 'From the main fork: check this.',
    });
    expect(drafted.isError).toBe(false);
    const comment = store
      .snapshot(explorationId)
      .comments.find((each) => each.id === drafted.value.commentId);
    expect(comment).toMatchObject({
      viewForkId: side.id,
      messageId: sideQuestion!.id,
      quote: '',
      body: 'From the main fork: check this.',
      status: 'draft',
      draftedByForkId: mainForkId,
    });

    const own = await call(client, 'draft_comment', { forkId: mainForkId, text: 'Hi' });
    expect(own).toMatchObject({ isError: true, value: expect.stringContaining('another fork') });
    const foreign = await call(client, 'draft_comment', { forkId: other.mainFork.id, text: 'Hi' });
    expect(foreign).toMatchObject({ isError: true, value: expect.stringContaining('not found') });
  });

  it('lets a separate fork read only itself', async () => {
    const { connect, call, lease, store, mainForkId, answer } = await setup();
    const side = store.forkAtAnswer(answer.id);
    store.setForkAwareness(mainForkId, 'separate');
    const client = await connect(lease.toolsToken);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(tools).not.toContain('list_forks');
    expect(tools).not.toContain('draft_comment');
    expect(await call(client, 'read_fork', { forkId: side.id })).toMatchObject({ isError: true });
    expect(await call(client, 'read_fork', { forkId: mainForkId })).toMatchObject({
      isError: false,
    });
  });
});
