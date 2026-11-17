import { describe, expect, it } from 'vitest';
import { repairMarkdown } from '../src/store/repair-markdown.js';
import { createTestStore, seedConversation } from './helpers.js';

describe('repairMarkdown', () => {
  it('separates a numbered list from the line before it', () => {
    expect(repairMarkdown('**Where it lives**\n4. Scope\n5. Header list')).toBe(
      '**Where it lives**\n\n4. Scope\n5. Header list',
    );
    expect(repairMarkdown('Steps to take:\n1) Build')).toBe('Steps to take:\n\n1) Build');
  });

  it('separates text from a bold heading above it', () => {
    expect(repairMarkdown('**Data**\nStored in the database.')).toBe(
      '**Data**\n\nStored in the database.',
    );
    expect(repairMarkdown('**Data:**\n- one')).toBe('**Data:**\n\n- one');
  });

  it('leaves lists, nested items, bold sentences and code as they are', () => {
    const untouched = [
      '1. First\n2. Second',
      '- item\n  continued\n3. next',
      '1. **Normalise on save.** When\n   - nested',
      '**Bold start.** and more text\nnext line',
      'Text\n\n2. Already separated',
      '```\nconst list = [\n1. not a list\n**x**\ny\n```',
    ];
    for (const source of untouched) expect(repairMarkdown(source)).toBe(source);
  });
});

describe('saving an answer', () => {
  it('repairs the markdown of an answer from Claude', () => {
    const { store } = createTestStore();
    const { explorationId, mainForkId } = seedConversation(store);
    store.attach({ explorationId, shimId: 'shim-a', sessionId: 'session-a', takeover: false });
    store.submit(explorationId, mainForkId, 'Another question');
    store.deliverQueued(explorationId);
    const [pending] = store.pendingForks(explorationId);

    const answer = store.addAssistantMessage({
      shimId: 'shim-a',
      forkId: mainForkId,
      inReplyTo: pending!.inReplyTo,
      content: '**Data**\n8. Stored',
    });

    expect(answer.content).toBe('**Data**\n\n8. Stored');
  });
});
