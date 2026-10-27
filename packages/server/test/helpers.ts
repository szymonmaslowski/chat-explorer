import { createApp } from '../src/api/app.js';
import { Database } from '../src/db/database.js';
import type { ExplorationEvent } from '../src/shared/types.js';
import { EventBus } from '../src/store/event-bus.js';
import { FeedbackHub } from '../src/store/feedback-hub.js';
import { ChatStore } from '../src/store/store.js';

export const testPort = 4999;

export function createTestStore() {
  const clock = { now: 1_000_000 };
  const now = () => clock.now;
  const database = new Database(':memory:');
  const bus = new EventBus();
  const events: ExplorationEvent[] = [];
  bus.subscribe((_explorationId, event) => events.push(event));
  const store = new ChatStore(database, bus, now);
  const hub = new FeedbackHub(store, bus, now);
  return { clock, database, bus, store, hub, events };
}

export function createTestApp() {
  const context = createTestStore();
  const app = createApp({
    store: context.store,
    hub: context.hub,
    bus: context.bus,
    port: testPort,
    version: '0.0.0-test',
    uiDirectory: null,
    onShutdown: () => {},
  });
  const request = (path: string, init: RequestInit & { json?: object } = {}) => {
    const { json, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (!headers.has('host')) headers.set('host', `127.0.0.1:${testPort}`);
    if (json) headers.set('content-type', 'application/json');
    return app.request(`http://127.0.0.1:${testPort}${path}`, {
      ...rest,
      headers,
      body: json ? JSON.stringify(json) : rest.body,
    });
  };
  return { ...context, app, request };
}

export function seedConversation(store: ChatStore) {
  const { exploration, mainFork } = store.createExploration({
    title: 'Test',
    messages: [
      { role: 'user', content: 'Question one' },
      { role: 'assistant', content: 'Answer one with some text to quote' },
    ],
  });
  const [question, answer] = store.readFork(mainFork.id).messages;
  return {
    explorationId: exploration.id,
    mainForkId: mainFork.id,
    question: question!,
    answer: answer!,
  };
}

export function draft(
  store: ChatStore,
  explorationId: string,
  input: { messageId: string; viewForkId: string; body: string; type?: 'inline' | 'fork' },
) {
  return store.createComment(explorationId, {
    quote: 'some text',
    startOffset: 16,
    endOffset: 25,
    ...input,
  });
}
