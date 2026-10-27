import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { claudeArguments } from '../src/sessions/launch-claude.js';
import { createTestApp, createTestSessions, createTestStore, seedConversation } from './helpers.js';

function setup() {
  const context = createTestStore();
  return { ...context, ...seedConversation(context.store) };
}

const attachLaunched = (
  context: ReturnType<typeof setup>,
  launchIndex: number,
  shimId = `shim-${launchIndex}`,
) => {
  const { spec } = context.launches[launchIndex]!;
  context.store.attach({
    explorationId: spec.explorationId,
    shimId,
    sessionId: spec.sessionId,
    takeover: false,
  });
};

const minutes = (count: number) => count * 60_000;

describe('background sessions', () => {
  it('starts one session when feedback is queued and nobody is attached', () => {
    const context = setup();
    const { store, hub, launches, explorationId, mainForkId } = context;
    store.submit(explorationId, mainForkId, 'first');
    store.submit(explorationId, mainForkId, 'second');
    expect(launches).toHaveLength(1);
    expect(launches[0]!.spec).toMatchObject({ explorationId, model: 'sonnet', resume: false });
    expect(store.backgroundSession(explorationId).sessionId).toBe(launches[0]!.spec.sessionId);
    expect(hub.status(explorationId)).toBe('starting');

    attachLaunched(context, 0);
    expect(hub.status(explorationId)).toBe('attached');
  });

  it('leaves an exploration alone while a live session is attached', () => {
    const { store, launches, explorationId, mainForkId } = setup();
    store.attach({ explorationId, shimId: 'terminal', sessionId: 'terminal', takeover: false });
    store.submit(explorationId, mainForkId, 'hello');
    expect(launches).toHaveLength(0);
  });

  it('reports a session that exits before attaching, with the end of its log', () => {
    const { store, hub, sessions, launches, events, explorationId, mainForkId } = setup();
    store.submit(explorationId, mainForkId, 'hello');
    writeFileSync(
      launches[0]!.spec.logPath,
      '--- earlier run\nold output\n--- now\nError: not logged in\n',
    );
    launches[0]!.exit(1);
    expect(sessions.error(explorationId)).toBe(
      'Claude exited with code 1 before it could answer.\n\nError: not logged in',
    );
    expect(events.at(-2)).toMatchObject({ type: 'session.error' });
    expect(hub.status(explorationId)).toBe('detached');
    expect(store.queuedSubmissions(explorationId)).toHaveLength(1);

    store.submit(explorationId, mainForkId, 'again');
    expect(launches).toHaveLength(2);
    expect(sessions.error(explorationId)).toBeNull();
  });

  it('reports a missing claude command', () => {
    const { store, sessions, launches, explorationId, mainForkId } = setup();
    store.submit(explorationId, mainForkId, 'hello');
    launches[0]!.exit(null, 'spawn claude ENOENT');
    expect(sessions.error(explorationId)).toMatch(
      /^Claude could not be started: spawn claude ENOENT/,
    );
  });

  it('stops an idle session and resumes it on the next submit', () => {
    const context = setup();
    const { clock, store, hub, sessions, launches, explorationId, mainForkId } = context;
    store.submit(explorationId, mainForkId, 'hello');
    attachLaunched(context, 0);
    store.deliverQueued(explorationId);
    const [pending] = store.pendingForks(explorationId);
    store.addAssistantMessage({
      shimId: 'shim-0',
      forkId: mainForkId,
      inReplyTo: pending!.inReplyTo,
      content: 'Hi',
    });

    clock.now += minutes(59);
    sessions.stopIdle();
    expect(launches[0]!.stopped).toBe(false);
    clock.now += minutes(2);
    sessions.stopIdle();
    expect(launches[0]!.stopped).toBe(true);

    launches[0]!.exit(0);
    expect(store.attachment(explorationId)).toBeNull();
    expect(hub.status(explorationId)).toBe('detached');
    expect(sessions.error(explorationId)).toBeNull();

    store.submit(explorationId, mainForkId, 'later');
    expect(launches[1]!.spec).toMatchObject({
      resume: true,
      sessionId: launches[0]!.spec.sessionId,
    });
  });

  it('keeps a session that still has a question to answer', () => {
    const context = setup();
    const { clock, store, sessions, launches, explorationId, mainForkId } = context;
    store.submit(explorationId, mainForkId, 'hello');
    attachLaunched(context, 0);
    store.deliverQueued(explorationId);
    clock.now += minutes(120);
    sessions.stopIdle();
    expect(launches[0]!.stopped).toBe(false);
  });

  it('starts again for feedback queued while the session was stopping', () => {
    const context = setup();
    const { clock, store, sessions, launches, explorationId, mainForkId } = context;
    store.submit(explorationId, mainForkId, 'hello');
    attachLaunched(context, 0);
    store.deliverQueued(explorationId);
    store.addAssistantMessage({
      shimId: 'shim-0',
      forkId: mainForkId,
      inReplyTo: store.pendingForks(explorationId)[0]!.inReplyTo,
      content: 'Hi',
    });
    clock.now += minutes(61);
    sessions.stopIdle();
    store.submit(explorationId, mainForkId, 'just in time');
    expect(launches).toHaveLength(1);
    launches[0]!.exit(0);
    expect(launches).toHaveLength(2);
  });

  it('starts for feedback left queued when the session that held it went away', () => {
    const { clock, store, sessions, launches, explorationId, mainForkId } = setup();
    store.attach({ explorationId, shimId: 'terminal', sessionId: 'terminal', takeover: false });
    store.submit(explorationId, mainForkId, 'hello');
    sessions.startForUnansweredQueues();
    expect(launches).toHaveLength(0);
    clock.now += minutes(1);
    sessions.startForUnansweredQueues();
    expect(launches).toHaveLength(1);
  });

  it('does not retry a failed start on its own', () => {
    const { store, sessions, launches, explorationId, mainForkId } = setup();
    store.submit(explorationId, mainForkId, 'hello');
    launches[0]!.exit(1);
    sessions.startForUnansweredQueues();
    expect(launches).toHaveLength(1);
  });

  it('releases attachments of background sessions from an earlier daemon', () => {
    const context = setup();
    const { store, bus, explorationId, mainForkId } = context;
    store.submit(explorationId, mainForkId, 'hello');
    attachLaunched(context, 0);
    createTestSessions({ store, bus, onStatusChange: () => {} });
    expect(store.attachment(explorationId)).toBeNull();
  });

  it('stops the session of an archived exploration and starts none for it', () => {
    const context = setup();
    const { store, sessions, launches, explorationId, mainForkId } = context;
    store.submit(explorationId, mainForkId, 'hello');
    attachLaunched(context, 0);
    store.archiveExploration(explorationId);
    expect(launches[0]!.stopped).toBe(true);
    launches[0]!.exit(0);
    expect(launches).toHaveLength(1);
    expect(sessions.error(explorationId)).toBeNull();
    expect(() => sessions.start(explorationId)).toThrow(
      expect.objectContaining({ code: 'archived' }),
    );
  });

  it('makes room by stopping the session idle longest', () => {
    const context = createTestStore();
    const { clock, store, sessions, launches } = context;
    const conversations = [1, 2, 3].map(() => seedConversation(store));
    for (const [index, conversation] of conversations.slice(0, 2).entries()) {
      store.submit(conversation.explorationId, conversation.mainForkId, 'hello');
      store.attach({
        explorationId: conversation.explorationId,
        shimId: `shim-${index}`,
        sessionId: launches[index]!.spec.sessionId,
        takeover: false,
      });
      clock.now += 1_000;
    }
    const [busy, idle, third] = conversations;
    store.deliverQueued(busy!.explorationId);
    store.deliverQueued(idle!.explorationId);
    store.addAssistantMessage({
      shimId: 'shim-1',
      forkId: idle!.mainForkId,
      inReplyTo: store.pendingForks(idle!.explorationId)[0]!.inReplyTo,
      content: 'Done',
    });

    store.submit(third!.explorationId, third!.mainForkId, 'hello');
    expect(launches[1]!.stopped).toBe(true);
    expect(launches[0]!.stopped).toBe(false);
    expect(launches[2]!.spec.explorationId).toBe(third!.explorationId);

    const fourth = seedConversation(store);
    store.submit(fourth.explorationId, fourth.mainForkId, 'hello');
    expect(launches).toHaveLength(3);
    expect(sessions.error(fourth.explorationId)).toMatch(/2 Claude sessions are busy/);
  });

  it('restarts a running session with the new model', async () => {
    const context = createTestApp();
    const { store, launches, request } = context;
    const response = await request('/api/explorations', {
      method: 'POST',
      json: { message: 'What is a monad?' },
    });
    expect(response.status).toBe(201);
    const { explorationId } = await response.json();
    expect(launches[0]!.spec).toMatchObject({ explorationId, model: 'sonnet' });
    expect(store.queuedSubmissions(explorationId)).toMatchObject([
      { globalMessage: 'What is a monad?' },
    ]);
    store.attach({
      explorationId,
      shimId: 'shim-0',
      sessionId: launches[0]!.spec.sessionId,
      takeover: false,
    });

    await request(`/api/explorations/${explorationId}`, {
      method: 'PATCH',
      json: { model: 'opus' },
    });
    expect(launches[0]!.stopped).toBe(true);
    launches[0]!.exit(0);
    expect(launches[1]!.spec).toMatchObject({ model: 'opus', resume: true });
  });

  it('passes only web search and the chat-explorer tools to Claude', () => {
    expect(
      claudeArguments(
        {
          explorationId: 'abc',
          model: 'opus',
          sessionId: 'session',
          resume: true,
          logPath: '/tmp/abc.log',
        },
        '/plugin',
      ),
    ).toEqual([
      '-p',
      '/explore-chat abc',
      '--model',
      'opus',
      '--resume',
      'session',
      '--plugin-dir',
      '/plugin',
      '--tools',
      'WebSearch',
      '--allowedTools',
      'WebSearch',
      'mcp__plugin_chat-explorer_chat-explorer',
      '--permission-prompts',
      'none',
    ]);
  });
});
