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

  it('pages back through a fork with a cursor', async () => {
    const { connect, call, lease, mainForkId } = await setup();
    const client = await connect(lease.toolsToken);
    const latest = await call(client, 'read_fork', { forkId: mainForkId, limit: 1 });
    expect(latest.value.messages.map((message: { text: string }) => message.text)).toEqual([
      'Note this down',
    ]);
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

  it("keeps to the job's chat and stops working when the lease ends", async () => {
    const { connect, call, lease, store, runs, mainForkId } = await setup();
    const other = store.createExploration({ title: 'Other' });
    const client = await connect(lease.toolsToken);
    const foreign = await call(client, 'read_fork', { forkId: other.mainFork.id });
    expect(foreign).toMatchObject({ isError: true, value: expect.stringContaining('not found') });

    runs.release(mainForkId, lease.leaseId);
    await expect(connect(lease.toolsToken)).rejects.toThrow();
  });
});
