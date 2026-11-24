import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { APIRequestContext } from '@playwright/test';

// A new chat, and its main fork from the chat's snapshot.
export async function newChat(request: APIRequestContext, message: string) {
  const { explorationId } = await (
    await request.post('/api/explorations', { data: { message } })
  ).json();
  const snapshot = await (await request.get(`/api/explorations/${explorationId}`)).json();
  const mainForkId: string = snapshot.forks.find(
    (fork: { parentForkId: string | null }) => fork.parentForkId === null,
  ).id;
  return { explorationId, mainForkId };
}

// Plays a runner against the daemon's runner API, with the machine token the daemon made.
export function fakeRunner(request: APIRequestContext) {
  const token = readFileSync(
    join(tmpdir(), 'chat-explorer-e2e', 'runner', 'machine-token'),
    'utf8',
  ).trim();
  const call = async (path: string, data: object) =>
    (
      await request.post(`/api/runner/${path}`, {
        data,
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
  const tool = async (toolsToken: string, name: string, args: object) =>
    (
      await request.post('/api/tools/mcp', {
        headers: {
          authorization: `Bearer ${toolsToken}`,
          accept: 'application/json, text/event-stream',
        },
        data: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        },
      })
    ).json();
  return { call, tool };
}
