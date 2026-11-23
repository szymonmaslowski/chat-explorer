import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createShim } from '@chat-explorer/mcp/shim.js';
import { loadConfig } from '@chat-explorer/shared/config.js';
import { buildRunContext } from '../src/store/run-context.js';
import { RequestStore } from '../src/store/requests.js';
import { createTestApp, seedConversation } from './helpers.js';

const coordinationTools = ['request_fork', 'request_message', 'request_fork_settings'];

// A runner's job on a fork, with an MCP client on its tools endpoint.
async function jobOn(context: ReturnType<typeof createTestApp>, forkId: string) {
  const { store, runs } = context;
  store.submit(store.fork(forkId).explorationId, forkId, 'Plan the work');
  const lease = runs.claim(forkId, 'runner-a')!;
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL('http://host.docker.internal:4999/api/tools/mcp'),
    {
      requestInit: { headers: { authorization: `Bearer ${lease.toolsToken}` } },
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
  const tools = async () => (await client.listTools()).tools.map((tool) => tool.name);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    return { isError: result.isError === true, value: result.isError ? text : JSON.parse(text) };
  };
  return { lease, tools, call };
}

describe("the runner's request tools", () => {
  it('are there only for the main fork with Coordination on', async () => {
    const context = createTestApp();
    const { store } = context;
    const { mainForkId, answer } = seedConversation(store);
    const child = store.forkAtAnswer(answer.id);
    store.setForkCoordination(mainForkId, false);
    const off = await jobOn(context, mainForkId);
    expect(await off.tools()).not.toEqual(expect.arrayContaining(['request_fork']));
    store.setForkCoordination(mainForkId, true);
    expect(await off.tools()).toEqual(expect.arrayContaining(coordinationTools));
    // No tool can change Coordination or Autonomous: only the user sets them.
    expect((await off.tools()).filter((name) => /autonom|coordinat|setting/.test(name))).toEqual([
      'request_fork_settings',
    ]);
    const other = await jobOn(context, child.id);
    expect(await other.tools()).not.toEqual(expect.arrayContaining(['request_fork']));
  });

  it('create waiting requests and change nothing', async () => {
    const context = createTestApp();
    const { store } = context;
    const { mainForkId, explorationId, answer } = seedConversation(store);
    const child = store.forkAtAnswer(answer.id);
    store.setForkCoordination(mainForkId, true);
    const { call } = await jobOn(context, mainForkId);
    const forked = await call('request_fork', {
      title: 'Research CI',
      brief: 'Find out how to run e2e tests in CI.',
      model: 'opus',
    });
    expect(forked.value).toMatchObject({ status: 'waiting for approval' });
    expect(forked.value.forkId).toMatch(/^fork_/);
    const messaged = await call('request_message', { forkId: child.id, text: 'Go on.' });
    const settings = await call('request_fork_settings', {
      forkId: child.id,
      coding: true,
      registries: ['npm'],
    });
    expect(messaged.value.requestId).toBe(forked.value.requestId);
    expect(settings.value.requestId).toBe(forked.value.requestId);
    const snapshot = store.snapshot(explorationId);
    expect(snapshot.forks.map((fork) => fork.id)).not.toContain(forked.value.forkId);
    expect(store.fork(child.id).coding).toBe(false);
    expect(store.readFork(child.id).messages.some((m) => m.text.includes('Go on.'))).toBe(false);
    const [request] = snapshot.requests;
    expect(request?.requestedBy).toBe('fork');
    expect(request?.items.map((item) => item.original.kind)).toEqual([
      'fork',
      'message',
      'fork_settings',
    ]);
    expect(request?.items[0]?.original).toMatchObject({
      awareness: 'aware',
      coding: false,
      model: 'opus',
    });
    expect(request?.items[2]?.original).toMatchObject({
      changes: { coding: true, registries: ['npm'] },
    });
  });

  it('refuse a fork of another chat', async () => {
    const context = createTestApp();
    const { store } = context;
    const { mainForkId } = seedConversation(store);
    const other = seedConversation(store);
    store.setForkCoordination(mainForkId, true);
    const { call } = await jobOn(context, mainForkId);
    const result = await call('request_message', { forkId: other.mainForkId, text: 'Hi' });
    expect(result).toMatchObject({ isError: true });
    expect(result.value).toMatch(/not found/);
  });

  it('tell the coordinator its role, and the outcome on the next message', async () => {
    const context = createTestApp();
    const { store, runs } = context;
    const { mainForkId } = seedConversation(store);
    store.setForkCoordination(mainForkId, true);
    const { call, lease } = await jobOn(context, mainForkId);
    const requests = new RequestStore(store);
    const prompt = buildRunContext(store, mainForkId, {
      resume: false,
      pendingIds: new Set(),
      requests,
    }).systemPrompt;
    expect(prompt).toContain('you are this chat');
    const { value } = await call('request_fork', { title: 'A', brief: 'Do A.' });
    requests.decide(value.requestId, { decision: 'approve' });
    const handled = runs.pendingInput(mainForkId, lease.leaseId).at(-1)!.id;
    runs.finishTurn(mainForkId, lease.leaseId, handled);
    store.submit(store.fork(mainForkId).explorationId, mainForkId, 'Next');
    const response = await context.request(`/api/runner/forks/${mainForkId}/input`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-machine-token' },
      json: { leaseId: lease.leaseId, waitMs: 0 },
    });
    const input = await response.json();
    expect(input.others).toContain('The user decided on your requests:');
    expect(input.others).toContain(`Request ${value.requestId}, approved by the user`);
    const history = buildRunContext(store, mainForkId, {
      resume: false,
      pendingIds: new Set(),
      requests,
    }).history;
    expect(history).toContain(`<requests>\n- Request ${value.requestId}`);
  });

  it('give a separate fork no coordinator prompt', () => {
    const context = createTestApp();
    const { store } = context;
    const { answer } = seedConversation(store);
    const child = store.forkAtAnswer(answer.id);
    const { systemPrompt } = buildRunContext(store, child.id, {
      resume: true,
      pendingIds: new Set(),
    });
    expect(systemPrompt).not.toContain('you are this chat');
  });
});

describe("the terminal's request tools", () => {
  let server: Server | null = null;
  const shims: ReturnType<typeof createShim>[] = [];

  afterEach(async () => {
    await Promise.all(shims.splice(0).map((shim) => shim.close()));
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server!.close(resolve));
      server = null;
    }
  });

  it('create waiting requests in the main fork, without a setting', async () => {
    process.env.CHAT_EXPLORER_PORT = String(40_000 + Math.floor(Math.random() * 20_000));
    const config = loadConfig();
    const context = createTestApp();
    server = createServer(
      getRequestListener((request) => {
        const url = new URL(request.url);
        // The test app answers only on its own port.
        const headers = new Headers(request.headers);
        headers.delete('host');
        return context.request(`${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          body: request.body,
          // @ts-expect-error Node's fetch needs it for a streamed body.
          duplex: 'half',
        });
      }),
    );
    await new Promise<void>((resolve) => server!.listen(config.port, '127.0.0.1', resolve));
    const shim = createShim({
      config,
      version: '0',
      openUrl: () => {},
      ensureDaemon: async () => {},
    });
    shims.push(shim);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await shim.server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientTransport);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
      return {
        isError: result.isError === true,
        text,
        value: result.isError ? null : JSON.parse(text),
      };
    };
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(coordinationTools));
    for (const removed of ['message_fork', 'stop_fork', 'retry_fork']) {
      expect(names).not.toContain(removed);
    }

    const { explorationId, mainForkId } = seedConversation(context.store);
    expect(context.store.fork(mainForkId).coordination).toBe(false);
    await call('attach_exploration', { explorationId, sessionId: 'session-a' });
    const asked = await call('request_fork', { title: 'B', brief: 'Do B.', coding: true });
    expect(asked.text).toContain('waiting for approval');
    const [request] = context.store.snapshot(explorationId).requests;
    expect(request).toMatchObject({
      forkId: mainForkId,
      requestedBy: 'terminal',
      status: 'waiting',
    });
    expect(context.store.snapshot(explorationId).forks).toHaveLength(1);
  });
});
