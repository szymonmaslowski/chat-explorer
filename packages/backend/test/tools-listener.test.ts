import { describe, expect, it } from 'vitest';
import { createToolsApp } from '../src/api/tools-app.js';
import { createTestApp, seedConversation, testPort } from './helpers.js';

const toolsPort = testPort + 1;

// A coding container reaches the daemon through the egress proxy, by host.docker.internal. The
// main port no longer answers that name, and the tools listener serves the job tools only.
function setup() {
  const context = createTestApp();
  const conversation = seedConversation(context.store);
  const tools = createToolsApp({ store: context.store, runs: context.runs, toolsPort });
  const toTools = (path: string, init: RequestInit & { json?: object } = {}) => {
    const { json, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (!headers.has('host')) headers.set('host', `host.docker.internal:${toolsPort}`);
    if (json) headers.set('content-type', 'application/json');
    return tools.request(`http://host.docker.internal:${toolsPort}${path}`, {
      ...rest,
      headers,
      body: json ? JSON.stringify(json) : rest.body,
    });
  };
  return { ...context, ...conversation, toTools };
}

const mcpCall = {
  method: 'POST',
  headers: { accept: 'application/json, text/event-stream' },
  json: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
};

describe('the main port', () => {
  it("refuses the containers' name for the daemon, on page routes and the tools", async () => {
    const { request, mainForkId } = setup();
    const host = { host: `host.docker.internal:${testPort}` };
    const network = await request(`/api/forks/${mainForkId}/network`, {
      method: 'PATCH',
      headers: host,
      json: { hosts: ['evil.example.com:443'], registries: [] },
    });
    expect(network.status).toBe(403);
    expect((await request('/api/explorations', { headers: host })).status).toBe(403);
    expect((await request('/api/tools/mcp', { ...mcpCall, headers: host })).status).toBe(403);
  });

  // A forged Host: 127.0.0.1 passes this guard, which is why containers must not reach this port
  // at all: the proxy refuses it, and the runner points them at the tools port.
  it('still serves local callers', async () => {
    const { request } = setup();
    expect((await request('/api/explorations')).status).toBe(200);
  });
});

describe('the tools listener', () => {
  it('answers 404 to every page route, whatever the Host', async () => {
    const { toTools, mainForkId, store } = setup();
    const network = await toTools(`/api/forks/${mainForkId}/network`, {
      method: 'PATCH',
      json: { hosts: ['evil.example.com:443'], registries: [] },
    });
    expect(network.status).toBe(404);
    expect(store.fork(mainForkId).network.hosts).toEqual([]);
    expect((await toTools('/api/explorations')).status).toBe(404);
    expect((await toTools('/')).status).toBe(404);
    const forged = await toTools('/api/explorations', {
      headers: { host: `127.0.0.1:${toolsPort}` },
    });
    expect(forged.status).toBe(404);
  });

  it('serves the job tools with a valid token and refuses them without one', async () => {
    const { toTools, store, runs, explorationId, mainForkId } = setup();
    store.submit(explorationId, mainForkId, 'Hello');
    const lease = runs.claim(mainForkId, 'runner-a')!;
    const withToken = await toTools('/api/tools/mcp', {
      ...mcpCall,
      headers: { ...mcpCall.headers, authorization: `Bearer ${lease.toolsToken}` },
    });
    expect(withToken.status).toBe(200);
    expect(JSON.stringify(await withToken.json())).toContain('read_fork');
    expect((await toTools('/api/tools/mcp', mcpCall)).status).toBe(401);
    const wrong = await toTools('/api/tools/mcp', {
      ...mcpCall,
      headers: { ...mcpCall.headers, authorization: 'Bearer nope' },
    });
    expect(wrong.status).toBe(401);
  });

  it('refuses a foreign Host', async () => {
    const { toTools } = setup();
    const response = await toTools('/api/tools/mcp', {
      ...mcpCall,
      headers: { ...mcpCall.headers, host: 'evil.example:5000' },
    });
    expect(response.status).toBe(403);
  });
});
