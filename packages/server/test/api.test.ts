import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
