import { beforeEach, describe, expect, it } from 'vitest';
import { renderMarkdown } from '@shared/markdown';
import { sitsApartFromText } from '../src/lib/comment-placement';
import { locateAnchor } from '../src/lib/anchoring';

let root: HTMLElement;
const source =
  'Intro **bold** text.\n\n| Step | Time |\n|---|---|\n| clone | 1 s |\n\n```ts\nconst a = 1;\n```\n\n- outer\n  - inner item\n';

beforeEach(() => {
  root = document.createElement('div');
  root.dataset.anchorRoot = 'm';
  root.innerHTML = renderMarkdown(source);
  document.body.replaceChildren(root);
});

const apart = (quote: string) => {
  const startOffset = root.textContent!.indexOf(quote);
  const range = locateAnchor(root, { quote, startOffset, endOffset: startOffset + quote.length })!;
  return sitsApartFromText(range);
};

describe('a card away from its text', () => {
  it('is one for a quote in a table cell or a code block', () => {
    expect(apart('clone')).toBe(true);
    expect(apart('const a')).toBe(true);
  });

  it('is not one for a paragraph, a bold word or a nested list item', () => {
    expect(apart('Intro')).toBe(false);
    expect(apart('bold')).toBe(false);
    expect(apart('inner item')).toBe(false);
  });
});
