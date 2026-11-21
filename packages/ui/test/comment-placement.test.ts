import { beforeEach, describe, expect, it } from 'vitest';
import { renderMarkdown } from '@shared/markdown';
import {
  insertInTableRow,
  removeMount,
  sitsApartFromText,
  tableCellAt,
} from '../src/lib/comment-placement';
import { locateAnchor } from '../src/lib/anchoring';
import { blockClipboardText } from '../src/lib/clipboard';

let root: HTMLElement;
const source =
  'Intro **bold** text.\n\n| Step | Time |\n|---|---|\n| clone | 1 s |\n| install | 13 s |\n\n```ts\nconst a = 1;\n```\n\n- outer\n  - inner item\n';

beforeEach(() => {
  root = document.createElement('div');
  root.dataset.anchorRoot = 'm';
  root.innerHTML = renderMarkdown(source);
  document.body.replaceChildren(root);
});

const rangeOf = (quote: string) => {
  const startOffset = root.textContent!.indexOf(quote);
  const endOffset = startOffset + quote.length;
  return { range: locateAnchor(root, { quote, startOffset, endOffset })!, endOffset };
};

function openInRow(quote: string) {
  const { range, endOffset } = rangeOf(quote);
  const mount = document.createElement('span');
  mount.setAttribute('data-inserted', '');
  mount.textContent = `card:${quote}`;
  insertInTableRow(tableCellAt(range)!, mount, endOffset);
  return mount;
}

const rowTexts = () =>
  [...root.querySelectorAll('tr')].map((row) =>
    row.classList.contains('comment-row') ? row.textContent : row.cells[0]!.textContent,
  );

describe('a card away from its text', () => {
  it('is one for a quote in a code block only', () => {
    expect(sitsApartFromText(rangeOf('const a').range)).toBe(true);
    for (const quote of ['clone', 'Intro', 'bold', 'inner item']) {
      expect(sitsApartFromText(rangeOf(quote).range)).toBe(false);
    }
  });
});

describe('a card on a table cell', () => {
  it('goes in a row of its own right under the cell, across all columns', () => {
    const mount = openInRow('clone');
    const row = mount.closest('tr')!;
    expect(rowTexts()).toEqual(['Step', 'clone', 'card:clone', 'install']);
    expect(row.previousElementSibling).toBe(root.querySelectorAll('tbody tr')[0]);
    expect(row.cells).toHaveLength(1);
    expect(row.cells[0]!.colSpan).toBe(2);
  });

  it('goes to the top of the body for a header cell', () => {
    openInRow('Step');
    expect(rowTexts()).toEqual(['Step', 'card:Step', 'clone', 'install']);
    expect(root.querySelector('thead')!.querySelectorAll('tr')).toHaveLength(1);
  });

  it('keeps the cards of one row in the order of their quotes', () => {
    openInRow('1 s');
    openInRow('clone');
    expect(rowTexts()).toEqual(['Step', 'clone', 'card:clone', 'card:1 s', 'install']);
  });

  it('leaves with its row, and the table is as it was', () => {
    const before = root.querySelector('table')!.outerHTML;
    removeMount(openInRow('install'));
    expect(root.querySelector('table')!.outerHTML).toBe(before);
  });

  it('is left out of a copied table', () => {
    openInRow('clone');
    const copied = blockClipboardText(root.querySelector('table')!);
    expect(copied.plain).toBe('Step\tTime\nclone\t1 s\ninstall\t13 s');
    expect(copied.html).not.toContain('card:clone');
  });
});
