import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { withoutTagLines, type AnsweredPartLookup } from '../src/shared/answer-tags.js';
import { renderMarkdown } from '../src/shared/markdown.js';
import { createTestStore, draft, seedConversation } from './helpers.js';

const rendered = (markdown: string, answeredPart?: AnsweredPartLookup) =>
  parseHTML(`<!doctype html><html><body>${renderMarkdown(markdown, answeredPart)}</body></html>`)
    .document.body;

const parts: AnsweredPartLookup = (kind, id) => {
  if (kind === 'comment' && id === 'aaaaaaaaaa') {
    return { quote: 'cache keys', text: 'Why "these"?', href: '/e/x/f/y#c-aaaaaaaaaa' };
  }
  if (kind === 'message' && id === 'bbbbbbbbbb') {
    return { quote: '', text: 'And Redis?', href: null };
  }
  return null;
};

describe('answer tags', () => {
  it('tags each comment and the reply text in what Claude reads', () => {
    const { store } = createTestStore();
    const { explorationId, mainForkId, answer } = seedConversation(store);
    const comment = draft(store, explorationId, {
      messageId: answer.id,
      viewForkId: mainForkId,
      body: 'Why?',
    });
    store.submit(explorationId, mainForkId, 'And Redis?');
    store.deliverQueued(explorationId);
    const [pending] = store.pendingForks(explorationId);
    expect(pending!.userMessages[0]!.text).toBe(
      `[c:${comment.id}]\n> some text\nWhy?\n\n[m:${pending!.inReplyTo}]\nAnd Redis?`,
    );
  });

  it('leaves a message without comments untagged', () => {
    const { store } = createTestStore();
    const { explorationId, mainForkId } = seedConversation(store);
    store.submit(explorationId, mainForkId, 'Just a question');
    store.deliverQueued(explorationId);
    expect(store.pendingForks(explorationId)[0]!.userMessages[0]!.text).toBe('Just a question');
  });

  it('shows a tag line as cards that add no text to the answer', () => {
    const body = rendered(
      '[c:aaaaaaaaaa] [m:bbbbbbbbbb]\nFirst part.\n\n[c:zzzzzzzzzz]\nMore.',
      parts,
    );
    const cards = [...body.querySelectorAll('.answer-card')];
    expect(cards.map((card) => card.querySelector('.answer-jump')?.getAttribute('href'))).toEqual([
      '/e/x/f/y#c-aaaaaaaaaa',
      undefined,
      undefined,
    ]);
    expect(cards[0]!.getAttribute('data-comment-id')).toBe('aaaaaaaaaa');
    expect(cards[0]!.getAttribute('data-quote')).toBe('cache keys');
    expect(cards[0]!.getAttribute('data-text')).toBe('Why "these"?');
    expect(cards[1]!.hasAttribute('data-quote')).toBe(false);
    expect(cards[1]!.getAttribute('data-text')).toBe('And Redis?');
    expect(cards[2]!.getAttribute('data-tag')).toBe('[c:zzzzzzzzzz]');
    expect(body.textContent!.replace(/\s+/g, ' ').trim()).toBe('First part. More.');
  });

  it('renders the same blocks without a lookup, as the daemon does for reading aloud', () => {
    const body = rendered('Intro\n[c:aaaaaaaaaa]\nPart');
    expect([...body.children].map((element) => element.tagName)).toEqual(['P', 'DIV', 'P']);
    expect(body.querySelector('.answer-card')!.getAttribute('data-tag')).toBe('[c:aaaaaaaaaa]');
  });

  it('leaves tags in code and next to other text as they are', () => {
    const body = rendered(
      '```\n[c:aaaaaaaaaa]\n```\n\n    [c:aaaaaaaaaa]\n\nSee [c:aaaaaaaaaa]',
      parts,
    );
    expect(body.querySelector('.answer-card')).toBeNull();
    expect(body.textContent).toContain('See [c:aaaaaaaaaa]');
  });

  it('drops tag lines from a copied answer', () => {
    expect(withoutTagLines('[c:aaaaaaaaaa]\nFirst.\n\n[m:bbbbbbbbbb]\n\nSecond.')).toBe(
      'First.\n\nSecond.',
    );
  });
});
