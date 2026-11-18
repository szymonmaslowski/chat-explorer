import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Database } from '../src/db/database.js';
import { migrations } from '../src/db/schema.js';
import { createTestApp, draft, seedConversation, testPort } from './helpers.js';

describe('request guard', () => {
  it('rejects a foreign Host header', async () => {
    const { request } = createTestApp();
    const response = await request('/api/health', { headers: { host: 'evil.example:4999' } });
    expect(response.status).toBe(403);
  });

  it('rejects a cross-origin POST', async () => {
    const { request, store } = createTestApp();
    const { explorationId, mainForkId } = seedConversation(store);
    const response = await request(`/api/explorations/${explorationId}/submit`, {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
      json: { forkId: mainForkId, globalMessage: 'hi' },
    });
    expect(response.status).toBe(403);
  });

  it('accepts a same-origin POST from localhost', async () => {
    const { request, store } = createTestApp();
    const { explorationId, mainForkId } = seedConversation(store);
    const response = await request(`/api/explorations/${explorationId}/submit`, {
      method: 'POST',
      headers: { host: `localhost:${testPort}`, origin: `http://localhost:${testPort}` },
      json: { forkId: mainForkId, globalMessage: 'hi' },
    });
    expect(response.status).toBe(201);
  });

  it('accepts requests through the public URL', async () => {
    const { request, store } = createTestApp({ publicUrl: 'https://mac.tailnet.ts.net' });
    const { explorationId, mainForkId } = seedConversation(store);
    const response = await request(`/api/explorations/${explorationId}/submit`, {
      method: 'POST',
      headers: { host: 'mac.tailnet.ts.net', origin: 'https://mac.tailnet.ts.net' },
      json: { forkId: mainForkId, globalMessage: 'hi' },
    });
    expect(response.status).toBe(201);
  });
});

describe('public API', () => {
  it('reports health with the API version', async () => {
    const { request } = createTestApp();
    expect(await (await request('/api/health')).json()).toMatchObject({
      name: 'chat-explorer',
      version: '0.0.0-test',
      apiVersion: 1,
    });
  });

  it('returns a snapshot with the session status', async () => {
    const { request, store } = createTestApp();
    const { explorationId } = seedConversation(store);
    const snapshot = await (await request(`/api/explorations/${explorationId}`)).json();
    expect(snapshot).toMatchObject({ sessionStatus: 'detached', forks: [{ kind: 'soft' }] });
    expect(snapshot.messages).toHaveLength(2);
  });

  it('compresses a snapshot for a client that accepts it', async () => {
    const { request, store } = createTestApp();
    const { exploration } = store.createExploration({
      title: 'Long',
      messages: [{ role: 'user', content: 'x'.repeat(4_000) }],
    });
    const response = await request(`/api/explorations/${exploration.id}`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(response.headers.get('content-encoding')).toBe('gzip');
    const unzipped = new Response(response.body!.pipeThrough(new DecompressionStream('gzip')));
    expect((await unzipped.json()).exploration.id).toBe(exploration.id);
  });

  it('maps store errors to HTTP statuses', async () => {
    const { request, store } = createTestApp();
    const { explorationId, mainForkId } = seedConversation(store);
    expect((await request('/api/explorations/missing')).status).toBe(404);
    const submitted = await (
      await request(`/api/explorations/${explorationId}/submit`, {
        method: 'POST',
        json: { forkId: mainForkId, globalMessage: 'hi' },
      })
    ).json();
    store.deliverQueued(explorationId);
    const cancel = await request(`/api/submissions/${submitted.id}`, { method: 'DELETE' });
    expect(cancel.status).toBe(409);
    expect(await cancel.json()).toMatchObject({ error: 'already_sent' });
  });

  it('archives, deletes, restores and purges through the API', async () => {
    const { request, store } = createTestApp();
    const { explorationId } = seedConversation(store);
    const ids = async (query = '') =>
      ((await (await request(`/api/explorations${query}`)).json()) as { id: string }[]).map(
        (exploration) => exploration.id,
      );

    await request(`/api/explorations/${explorationId}/archive`, { method: 'POST' });
    expect(await ids()).toEqual([]);
    expect(await ids('?archived=true')).toEqual([explorationId]);

    await request(`/api/explorations/${explorationId}`, { method: 'DELETE' });
    expect(await ids('?archived=true')).toEqual([]);
    expect(await ids('?deleted=true')).toEqual([explorationId]);
    expect((await request(`/api/explorations/${explorationId}`)).status).toBe(404);

    await request(`/api/explorations/${explorationId}/restore`, { method: 'POST' });
    await request(`/api/explorations/${explorationId}/unarchive`, { method: 'POST' });
    expect(await ids()).toEqual([explorationId]);

    await request(`/api/explorations/${explorationId}?purge=true`, { method: 'DELETE' });
    expect(store.listExplorations('deleted')).toEqual([]);
    expect(await ids()).toEqual([]);
  });

  it('starts a chat already archived', async () => {
    const { request, store } = createTestApp();
    const response = await request('/api/explorations', {
      method: 'POST',
      json: { message: 'Quick question', archived: true },
    });
    const { explorationId } = await response.json();
    expect(store.listExplorations('archived').map((exploration) => exploration.id)).toEqual([
      explorationId,
    ]);
    expect(store.queuedSubmissions(explorationId)).toHaveLength(1);
  });

  it('validates request bodies', async () => {
    const { request, store } = createTestApp();
    const { explorationId } = seedConversation(store);
    const response = await request(`/api/explorations/${explorationId}/comments`, {
      method: 'POST',
      json: { body: 'missing fields' },
    });
    expect(response.status).toBe(400);
  });
});

describe('internal API', () => {
  it('imports the transcript when an exploration starts', async () => {
    const { request, store } = createTestApp();
    const directory = mkdtempSync(join(tmpdir(), 'transcript-'));
    const transcriptPath = join(directory, 'session.jsonl');
    writeFileSync(
      transcriptPath,
      [
        { type: 'user', uuid: 'a', parentUuid: null, message: { content: 'Hi' } },
        {
          type: 'assistant',
          uuid: 'b',
          parentUuid: 'a',
          message: { content: [{ type: 'text', text: 'Hello' }] },
        },
        { type: 'ai-title', aiTitle: 'Greeting' },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n'),
    );
    const started = await (
      await request('/api/internal/explorations', {
        method: 'POST',
        json: { shimId: 'shim-a', sessionId: 'session-a', transcriptPath },
      })
    ).json();
    rmSync(directory, { recursive: true });
    expect(started).toMatchObject({ importedMessages: 2, transcriptFound: true });
    const snapshot = store.snapshot(started.explorationId);
    expect(snapshot.exploration.title).toBe('Greeting');
    expect(snapshot.messages.map((message) => [message.role, message.source])).toEqual([
      ['user', 'import'],
      ['assistant', 'import'],
    ]);
  });

  it('rejects a transcript path that does not exist', async () => {
    const { request } = createTestApp();
    const response = await request('/api/internal/explorations', {
      method: 'POST',
      json: { shimId: 'shim-a', sessionId: 'session-a', transcriptPath: '/missing/session.jsonl' },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid' });
  });

  it('runs one feedback round: start, wait, submit, answer', async () => {
    const { request, store } = createTestApp();
    const started = await (
      await request('/api/internal/explorations', {
        method: 'POST',
        json: { shimId: 'shim-a', sessionId: 'session-a', title: 'Live' },
      })
    ).json();
    expect(started.url).toBe(`http://127.0.0.1:${testPort}/e/${started.explorationId}`);

    const waiting = request(`/api/internal/explorations/${started.explorationId}/feedback`, {
      method: 'POST',
      json: { shimId: 'shim-a', waitMs: 60_000 },
    });
    await request(`/api/explorations/${started.explorationId}/submit`, {
      method: 'POST',
      json: { forkId: started.mainForkId, globalMessage: 'Hello' },
    });
    const feedback = await (await waiting).json();
    expect(feedback).toMatchObject({
      status: 'feedback',
      forks: [{ forkId: started.mainForkId, userMessages: [{ text: 'Hello' }] }],
    });

    const answer = await request(`/api/internal/forks/${started.mainForkId}/messages`, {
      method: 'POST',
      json: { shimId: 'shim-a', inReplyTo: feedback.forks[0].inReplyTo, content: 'Hi there' },
    });
    expect(answer.status).toBe(201);
    expect(store.readFork(started.mainForkId).messages.map((message) => message.text)).toEqual([
      'Hello',
      'Hi there',
    ]);
  });

  it('returns the public URL for the phone and the local one for the Mac', async () => {
    const { request } = createTestApp({ publicUrl: 'https://mac.tailnet.ts.net' });
    const started = await (
      await request('/api/internal/explorations', {
        method: 'POST',
        json: { shimId: 'shim-a', sessionId: 'session-a' },
      })
    ).json();
    expect(started).toMatchObject({
      url: `https://mac.tailnet.ts.net/e/${started.explorationId}`,
      localUrl: `http://127.0.0.1:${testPort}/e/${started.explorationId}`,
    });
  });

  it('refuses writes from a detached session', async () => {
    const { request, store } = createTestApp();
    const { explorationId, mainForkId, answer } = seedConversation(store);
    store.attach({ explorationId, shimId: 'shim-a', sessionId: 'session-a', takeover: false });
    draft(store, explorationId, { messageId: answer.id, viewForkId: mainForkId, body: 'x' });
    const response = await request(`/api/internal/forks/${mainForkId}`, {
      method: 'PATCH',
      json: { shimId: 'shim-b', summary: 'nope' },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'detached' });
  });
});

describe('a chat setting', () => {
  it('sets the page a chat opens on, which starts as the map', async () => {
    const { request, store } = createTestApp();
    const { explorationId } = seedConversation(store);
    expect(
      (await (await request(`/api/explorations/${explorationId}`)).json()).exploration,
    ).toMatchObject({ defaultPage: 'map' });
    const response = await request(`/api/explorations/${explorationId}`, {
      method: 'PATCH',
      json: { defaultPage: 'notes' },
    });
    expect(await response.json()).toMatchObject({ defaultPage: 'notes' });
    const empty = await request(`/api/explorations/${explorationId}`, {
      method: 'PATCH',
      json: {},
    });
    expect(empty.status).toBe(400);
  });
});

describe("a fork's coding switch", () => {
  it('turns coding on and off, and accepts only a yes or no', async () => {
    const { request, store } = createTestApp();
    const { mainForkId } = seedConversation(store);
    const set = (json: object) =>
      request(`/api/forks/${mainForkId}/coding`, { method: 'PATCH', json });
    expect(await (await set({ coding: true })).json()).toMatchObject({ coding: true });
    expect(store.fork(mainForkId).coding).toBe(true);
    expect(await (await set({ coding: false })).json()).toMatchObject({ coding: false });
    expect((await set({ coding: 'yes' })).status).toBe(400);
  });
});

describe("a fork's allowed hosts", () => {
  it('saves host:port entries and ticked registries, refusing anything else', async () => {
    const { request, store } = createTestApp();
    const { mainForkId } = seedConversation(store);
    const set = (json: object) =>
      request(`/api/forks/${mainForkId}/network`, { method: 'PATCH', json });
    expect(store.fork(mainForkId).network).toEqual({ hosts: [], registries: [], credentials: [] });
    const saved = await set({
      hosts: ['github.com:443', 'github.com:443', 'git.example.com:2222'],
      registries: ['rust', 'npm', 'rust'],
    });
    expect(await saved.json()).toMatchObject({
      network: { hosts: ['github.com:443', 'git.example.com:2222'], registries: ['rust', 'npm'] },
    });
    expect(store.fork(mainForkId).network.hosts).toEqual([
      'github.com:443',
      'git.example.com:2222',
    ]);
    for (const hosts of [['github.com'], ['10.0.0.1:22'], ['github.com:443 --x']]) {
      expect((await set({ hosts, registries: [] })).status).toBe(400);
    }
    for (const registries of [true, ['cargo'], 'npm']) {
      expect((await set({ hosts: [], registries })).status).toBe(400);
    }
    expect(store.fork(mainForkId).network.registries).toEqual(['rust', 'npm']);
  });

  it("keeps the names of the runner's credentials a fork picked, and only names", async () => {
    const { request, store } = createTestApp();
    const { mainForkId } = seedConversation(store);
    const set = (json: object) =>
      request(`/api/forks/${mainForkId}/network`, { method: 'PATCH', json });
    const network = { hosts: [], registries: [] };
    await set({ ...network, credentials: ['GitHub token', 'GitHub token', 'Home git'] });
    expect(store.fork(mainForkId).network.credentials).toEqual(['GitHub token', 'Home git']);
    // A page from before credentials existed leaves them alone.
    await set({ hosts: ['github.com:443'], registries: [] });
    expect(store.fork(mainForkId).network).toMatchObject({
      hosts: ['github.com:443'],
      credentials: ['GitHub token', 'Home git'],
    });
    for (const credentials of [['../key'], ['a'.repeat(65)], 'GitHub token']) {
      expect((await set({ ...network, credentials })).status).toBe(400);
    }
  });

  it('restarts the container of a fork only while a runner holds one', async () => {
    const { request, store, runs } = createTestApp();
    const { explorationId, mainForkId } = seedConversation(store);
    const restart = async () =>
      (
        await (
          await request(`/api/forks/${mainForkId}/restart-container`, { method: 'POST', json: {} })
        ).json()
      ).restarting;
    expect(await restart()).toBe(false);
    store.submit(explorationId, mainForkId, 'Build it');
    const lease = runs.claim(mainForkId, 'runner-test')!;
    expect(await restart()).toBe(true);
    expect(runs.takeRestart(mainForkId, lease.leaseId)).toBe(true);
    expect(runs.takeRestart(mainForkId, lease.leaseId)).toBe(false);
  });

  it('ticks every registry for a fork that had the one switch for all of them on', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'chat-explorer-migration-')), 'test.db');
    const old = new DatabaseSync(path);
    const before = migrations.findIndex((migration) => migration.includes('new_registries'));
    for (const migration of migrations.slice(0, before)) old.exec(migration);
    old.exec(`PRAGMA user_version = ${before};
      INSERT INTO explorations (id, created_at, updated_at) VALUES ('chat_0000000001', 1, 1);
      INSERT INTO forks (id, exploration_id, registries, created_at, updated_at)
        VALUES ('fork_000000000a', 'chat_0000000001', 1, 1, 1),
          ('fork_000000000b', 'chat_0000000001', 0, 1, 1);`);
    old.close();

    const database = new Database(path);
    expect(database.all('SELECT id, registries FROM forks ORDER BY id')).toEqual([
      { id: 'fork_000000000a', registries: '["npm","pypi","rust","go"]' },
      { id: 'fork_000000000b', registries: '[]' },
    ]);
  });
});

describe('the main fork overseeing the other forks', () => {
  it('lets only the attached session message, stop or retry another fork', async () => {
    const { request, store } = createTestApp();
    const { explorationId, answer } = seedConversation(store);
    store.attach({ explorationId, shimId: 'shim-a', sessionId: 'session-a', takeover: false });
    const side = store.forkAtAnswer(answer.id);
    const send = (shimId: string) =>
      request(`/api/internal/forks/${side.id}/supervisor-messages`, {
        method: 'POST',
        json: { shimId, text: 'Compare it with the first one.' },
      });
    expect((await send('shim-b')).status).toBe(409);
    expect((await send('shim-a')).status).toBe(201);
    for (const action of ['stop', 'retry']) {
      const response = await request(`/api/internal/forks/${side.id}/${action}`, {
        method: 'POST',
        json: { shimId: 'shim-b' },
      });
      expect(response.status).toBe(409);
    }
  });
});

describe("Claude's changes from a terminal session", () => {
  it('come only from the session attached to the chat', async () => {
    const { request, store } = createTestApp();
    const { explorationId, mainForkId } = seedConversation(store);
    store.attach({ explorationId, shimId: 'shim-a', sessionId: 'session-a', takeover: false });
    const group = store.createNoteGroup(explorationId, {});
    const attempts = [
      request(`/api/internal/explorations/${explorationId}/notes`, {
        method: 'POST',
        json: { shimId: 'other', groupId: group.id, notes: [{ topic: 'x' }] },
      }),
      request(`/api/internal/forks/${mainForkId}`, {
        method: 'PATCH',
        json: { shimId: 'other', summary: 'x' },
      }),
      request(`/api/internal/explorations/${explorationId}`, {
        method: 'PATCH',
        json: { shimId: 'other', title: 'x' },
      }),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'detached' });
    }
  });
});
