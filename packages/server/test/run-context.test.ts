import { describe, expect, it } from 'vitest';
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
