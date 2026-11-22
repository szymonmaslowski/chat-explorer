import { describe, expect, it } from 'vitest';
import type { ForkNetwork } from '@chat-explorer/shared/network.js';
import { buildRunContext, historyBudget } from '../src/store/run-context.js';
import { createTestStore } from './helpers.js';

describe('the context of a new engine session', () => {
  it('holds the fork so far, newest messages first in the budget, with a pointer to the rest', () => {
    const { store } = createTestStore();
    const long = 'x'.repeat(historyBudget / 2);
    const { mainFork } = store.createExploration({
      messages: [
        { role: 'user', content: 'Oldest question' },
        { role: 'assistant', content: long },
        { role: 'user', content: 'Second question' },
        { role: 'assistant', content: long },
        { role: 'user', content: 'New question' },
      ],
    });
    const pending = store.readFork(mainFork.id).messages.at(-1)!;
    const context = buildRunContext(store, mainFork.id, {
      resume: false,
      pendingIds: new Set([pending.id]),
    });
    expect(context.model).toBe('sonnet');
    expect(context.history).toContain('Second question');
    expect(context.history).not.toContain('Oldest question');
    expect(context.history).toMatch(/2 earlier messages are left out; read them with read_fork/);
    expect(context.history).not.toContain('New question');
    expect(context.systemPrompt).toContain('[c:');
  });

  it("runs a fork on its own model, or on the chat's when it picks none", () => {
    const { store } = createTestStore();
    const { mainFork } = store.createExploration({
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    const model = () =>
      buildRunContext(store, mainFork.id, { resume: true, pendingIds: new Set() }).model;
    expect(model()).toBe('sonnet');
    expect(store.setForkModel(mainFork.id, 'opus').model).toBe('opus');
    expect(model()).toBe('opus');
    store.setForkModel(mainFork.id, null);
    expect(model()).toBe('sonnet');
  });

  it('tells a new fork to name itself, and gives a resumed session no history', () => {
    const { store } = createTestStore();
    const { mainFork } = store.createExploration({
      messages: [{ role: 'user', content: 'Hello' }],
    });
    const fresh = buildRunContext(store, mainFork.id, { resume: false, pendingIds: new Set() });
    expect(fresh.history).toContain('This fork is new');
    expect(
      buildRunContext(store, mainFork.id, { resume: true, pendingIds: new Set() }).history,
    ).toBeNull();
  });
});

describe('the chat title line', () => {
  it('asks for a title while the chat has none, and stops once it has one', () => {
    const { store } = createTestStore();
    const { exploration, mainFork } = store.createExploration({
      messages: [{ role: 'user', content: 'Hello' }],
    });
    const history = () =>
      buildRunContext(store, mainFork.id, { resume: false, pendingIds: new Set() }).history;
    expect(history()).toContain('This chat has no title yet');
    expect(history()).toContain('set_chat_summary');
    store.updateExploration({ explorationId: exploration.id, title: 'Caching' });
    expect(history()).not.toContain('This chat has no title yet');
  });
});

describe("the fork's coding switch", () => {
  it('is off for a new fork, and the context carries it once it is turned on', () => {
    const { store } = createTestStore();
    const { mainFork } = store.createExploration({
      messages: [{ role: 'user', content: 'Hello' }],
    });
    const context = (resume: boolean) =>
      buildRunContext(store, mainFork.id, { resume, pendingIds: new Set() });
    expect(store.fork(mainFork.id).coding).toBe(false);
    expect(context(false).coding).toBe(false);
    expect(store.setForkCoding(mainFork.id, true).coding).toBe(true);
    expect(context(false).coding).toBe(true);
    expect(context(true).coding).toBe(true);
  });

  it("carries the fork's allowed hosts, new session or resumed", () => {
    const { store } = createTestStore();
    const { mainFork } = store.createExploration({
      messages: [{ role: 'user', content: 'Hello' }],
    });
    const network: ForkNetwork = {
      hosts: ['github.com:443'],
      registries: ['npm'],
      credentials: [],
    };
    store.setForkNetwork(mainFork.id, network);
    for (const resume of [false, true]) {
      expect(
        buildRunContext(store, mainFork.id, { resume, pendingIds: new Set() }).network,
      ).toEqual(network);
    }
  });
});

describe("hearing about the chat's other forks", () => {
  function chatWithTwoForks() {
    const context = createTestStore();
    const { exploration, mainFork } = context.store.createExploration({
      messages: [
        { role: 'user', content: 'Question' },
        { role: 'assistant', content: 'Answer' },
      ],
    });
    const answer = context.store.readFork(mainFork.id).messages.at(-1)!;
    const side = context.store.forkAtAnswer(answer.id);
    context.store.updateForkSummary({ forkId: side.id, summary: 'Side topic' });
    return { ...context, explorationId: exploration.id, mainFork, side };
  }

  it('gives a new session of an aware fork a digest of the others, and a separate one none', () => {
    const { store, mainFork, side } = chatWithTwoForks();
    const aware = buildRunContext(store, mainFork.id, { resume: false, pendingIds: new Set() });
    expect(aware.history).toContain(`- [${side.id}] Side topic`);
    store.setForkAwareness(mainFork.id, 'separate');
    const separate = buildRunContext(store, mainFork.id, { resume: false, pendingIds: new Set() });
    expect(separate.history).not.toContain(side.id);
  });

  it('gives a new session the index of note topics, without their text', () => {
    const { store, explorationId, mainFork } = chatWithTwoForks();
    expect(
      buildRunContext(store, mainFork.id, { resume: false, pendingIds: new Set() }).history,
    ).not.toContain("The chat's notes");
    const group = store.createNoteGroup(explorationId, { name: 'Facts' });
    const note = store.createNote(explorationId, { groupId: group.id, topic: 'Redis' });
    store.updateNote(note.id, { description: 'Secret detail' });
    const { history } = buildRunContext(store, mainFork.id, {
      resume: false,
      pendingIds: new Set(),
    });
    expect(history).toContain(`- Facts [${group.id}]\n  - [${note.id}] Redis`);
    expect(history).not.toContain('Secret detail');
  });

  it('tells a running fork which other forks changed since it last heard', () => {
    const { store, runs, explorationId, mainFork, side } = chatWithTwoForks();
    store.submit(explorationId, mainFork.id, 'Main question');
    const lease = runs.claim(mainFork.id, 'runner-a')!;
    expect(runs.othersUpdate(mainFork.id, lease.leaseId)).toBeNull();

    store.submit(explorationId, side.id, 'Side question');
    store.deliverQueued(explorationId);
    expect(runs.othersUpdate(mainFork.id, lease.leaseId)).toBe(
      `Meanwhile in this chat's other forks (read one with read_fork if it matters here):\n- [${side.id}] Side topic: 1 new message`,
    );
    expect(runs.othersUpdate(mainFork.id, lease.leaseId)).toBeNull();
  });
});
