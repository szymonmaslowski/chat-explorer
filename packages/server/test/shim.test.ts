import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { loadConfig } from '../src/config.js';
import { Database } from '../src/db/database.js';
import { FileStorage } from '../src/files/file-storage.js';
import { createShim } from '../src/mcp/shim.js';
import { EventBus } from '../src/store/event-bus.js';
import { FeedbackHub } from '../src/store/feedback-hub.js';
import { RunStore } from '../src/store/runs.js';
import { ChatStore } from '../src/store/store.js';
import {
  createTestSessions,
  createTestSpeaker,
  createTestTranscriber,
  testMachineToken,
} from './helpers.js';

const version = '0.0.0-test';
let server: Server;
let hub: FeedbackHub;
let config: ReturnType<typeof loadConfig>;
const shims: ReturnType<typeof createShim>[] = [];

beforeEach(async () => {
  process.env.CHAT_EXPLORER_PORT = String(40_000 + Math.floor(Math.random() * 20_000));
  config = loadConfig();
  const bus = new EventBus();
  const database = new Database(':memory:');
  const store = new ChatStore(database, bus);
  const { sessions } = createTestSessions({
    store,
    bus,
    onStatusChange: (explorationId) => hub.refreshStatus(explorationId),
  });
  hub = new FeedbackHub(store, bus, Date.now, sessions);
  const app = createApp({
    store,
    hub,
    bus,
    sessions,
    runs: new RunStore(database, bus, store),
    machineToken: testMachineToken,
    transcriber: createTestTranscriber().transcriber,
    speaker: createTestSpeaker().speaker,
    fileStorage: new FileStorage(store, '/nonexistent'),
    defaultModel: 'sonnet',
    port: config.port,
    publicUrl: null,
    version,
    uiDirectory: null,
    onShutdown: () => {},
  });
  server = createServer(getRequestListener(app.fetch));
  await new Promise<void>((resolve) => server.listen(config.port, '127.0.0.1', resolve));
});

afterEach(async () => {
  await Promise.all(shims.splice(0).map((shim) => shim.close()));
  hub.stop();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

async function connectClient() {
  const openedUrls: string[] = [];
  const shim = createShim({ config, version, openUrl: (url) => openedUrls.push(url) });
  shims.push(shim);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await shim.server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
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
  return { call, openedUrls };
}

const daemonRequest = (path: string, json?: object) =>
  fetch(`${config.baseUrl}${path}`, {
    method: json ? 'POST' : 'GET',
    headers: json ? { 'content-type': 'application/json' } : {},
    body: json ? JSON.stringify(json) : null,
  }).then((response) => response.json());

describe('MCP shim', () => {
  it('runs the feedback loop end to end', async () => {
    const { call, openedUrls } = await connectClient();
    const { value: started } = await call('start_exploration', {
      sessionId: 'session-a',
      title: 'Live',
    });
    expect(openedUrls).toEqual([started.url]);

    const waiting = call('await_feedback', { timeoutSeconds: 30 });
    await daemonRequest(`/api/explorations/${started.explorationId}/submit`, {
      forkId: started.mainForkId,
      globalMessage: 'What is a fork?',
    });
    const { value: feedback } = await waiting;
    expect(feedback).toMatchObject({
      status: 'feedback',
      forks: [{ forkId: started.mainForkId, userMessages: [{ text: 'What is a fork?' }] }],
    });

    const stale = await call('add_message', {
      forkId: started.mainForkId,
      inReplyTo: 'wrong',
      content: 'x',
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain('Call read_fork');

    await call('add_message', {
      forkId: started.mainForkId,
      inReplyTo: feedback.forks[0].inReplyTo,
      content: 'A branch of the conversation.',
    });
    await call('update_fork', { forkId: started.mainForkId, summary: 'Forks explained' });
    await call('update_exploration', { title: 'Forks', summary: 'What forks are' });

    const { value: read } = await call('read_fork', { forkId: started.mainForkId });
    expect(read.messages.map((message: { text: string }) => message.text)).toEqual([
      'What is a fork?',
      'A branch of the conversation.',
    ]);
    const { value: map } = await call('get_map');
    expect(map.forks).toMatchObject([{ summary: 'Forks explained', awaitingAnswer: false }]);
    const { value: list } = await call('list_explorations');
    expect(list).toMatchObject([
      { id: started.explorationId, title: 'Forks', sessionStatus: 'attached' },
    ]);
  });

  it('lets Claude keep notes and write their topics', async () => {
    const { call } = await connectClient();
    const { value: started } = await call('start_exploration', { sessionId: 'session-a' });
    const { explorationId, mainForkId } = started;
    const waiting = call('await_feedback', { timeoutSeconds: 30 });
    await daemonRequest(`/api/explorations/${explorationId}/submit`, {
      forkId: mainForkId,
      globalMessage: 'Make a shopping list',
    });
    const { value: feedback } = await waiting;
    expect(feedback).toMatchObject({ notesNeedingTopic: [], notes: { groups: [] } });

    const { value: group } = await call('add_note_group', { name: 'Shopping', checklist: true });
    const { value: added } = await call('add_notes', {
      groupId: group.id,
      notes: [{ topic: 'Lemon' }, { topic: 'Milk' }],
      sourceMessageId: feedback.forks[0].inReplyTo,
    });
    const [lemon, milk] = added.noteIds;
    await call('update_note', { noteId: lemon, checked: true });
    await call('reorder_note', { noteId: milk, afterNoteId: null });
    const { value: other } = await call('add_note_group', {});
    await call('change_note_group', { noteId: lemon, groupId: other.id });
    await call('request_note_deletion', { noteId: milk });

    const { value: notes } = await call('list_notes');
    expect(notes.groups).toMatchObject([
      { name: 'Shopping', notes: [{ topic: 'Milk', deletionRequested: true }] },
      { name: 'Group 2', notes: [{ topic: 'Lemon', checked: true, createdBy: 'claude' }] },
    ]);

    const userNote = await daemonRequest(`/api/explorations/${explorationId}/notes`, {
      groupId: group.id,
      description: 'Bread for the weekend',
    });
    const { value: topics } = await call('await_feedback', { timeoutSeconds: 30 });
    expect(topics).toMatchObject({
      status: 'feedback',
      forks: [{ forkId: mainForkId }],
      notesNeedingTopic: [{ noteId: userNote.id, description: 'Bread for the weekend' }],
    });
    await call('update_note', { noteId: userNote.id, topic: 'Bread' });
    expect((await call('list_notes', { groupId: group.id })).value.groups[0].notes).toMatchObject([
      { topic: 'Bread' },
      { topic: 'Milk' },
    ]);
  });

  it('returns timeout when nothing arrives', async () => {
    const { call } = await connectClient();
    await call('start_exploration', { sessionId: 'session-a' });
    expect((await call('await_feedback', { timeoutSeconds: 1 })).value).toEqual({
      status: 'timeout',
      next: expect.stringContaining('Call await_feedback again'),
    });
  });

  it('requires an attachment for write tools', async () => {
    const { call } = await connectClient();
    const result = await call('await_feedback', { timeoutSeconds: 1 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('start_exploration or attach_exploration');
  });

  it('detaches the old session when another one takes over', async () => {
    const first = await connectClient();
    const { value: started } = await first.call('start_exploration', { sessionId: 'session-a' });
    const waiting = first.call('await_feedback', { timeoutSeconds: 30 });

    const second = await connectClient();
    const refused = await second.call('attach_exploration', {
      explorationId: started.explorationId,
      sessionId: 'session-b',
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('takeover');

    const attached = await second.call('attach_exploration', {
      explorationId: started.explorationId,
      sessionId: 'session-b',
      takeover: true,
    });
    expect(attached.value.forks).toHaveLength(1);
    expect((await waiting).value).toEqual({ status: 'detached' });
    expect((await first.call('update_exploration', { title: 'x' })).isError).toBe(true);
  });
});
