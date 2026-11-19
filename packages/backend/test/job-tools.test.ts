import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { createTestApp, seedConversation } from './helpers.js';

async function setup() {
  const context = createTestApp();
  const conversation = seedConversation(context.store);
  const { store, runs } = context;
  store.submit(conversation.explorationId, conversation.mainForkId, 'Note this down');
  const lease = runs.claim(conversation.mainForkId, 'runner-a')!;
  const [question] = runs.pendingInput(conversation.mainForkId, lease.leaseId);
  const connect = async (token: string) => {
    const client = new Client({ name: 'test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL('http://host.docker.internal:4999/api/tools/mcp'),
      {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        fetch: async (url, init) =>
          context.app.request(String(url), {
            ...init,
            headers: {
              ...Object.fromEntries(new Headers(init?.headers)),
              host: 'host.docker.internal:4999',
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
    const group = await call(client, 'add_note_group', { name: 'Facts' });
    await call(client, 'add_notes', {
      groupId: group.value.id,
      notes: [{ topic: 'Redis' }],
      sourceMessageId: question.id,
    });

    const snapshot = store.snapshot(explorationId);
    expect(snapshot.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Noted, more soon.',
    });
    expect(snapshot.forks.find((fork) => fork.id === mainForkId)!.summary).toBe('Caching notes');
    expect(snapshot.notes[0]).toMatchObject({ topic: 'Redis', sourceMessageId: question.id });
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
