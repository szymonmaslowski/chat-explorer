import { beforeEach, describe, expect, it } from 'vitest';
import { anchorOfRange, clampToRoot, locateAnchor, rangeFromOffsets } from '../src/lib/anchoring';

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement('div');
  root.innerHTML = '<p>First <strong>bold</strong> line.</p><p>Second line.</p>';
  document.body.replaceChildren(root);
});

const selectText = (startNode: Node, startOffset: number, endNode: Node, endOffset: number) => {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
};

describe('anchoring', () => {
  it('turns a selection across elements into text offsets', () => {
    const first = root.querySelector('p')!.firstChild!;
    const bold = root.querySelector('strong')!.firstChild!;
    expect(anchorOfRange(root, selectText(first, 2, bold, 3))).toEqual({
      quote: 'rst bol',
      startOffset: 2,
      endOffset: 9,
    });
  });

  it('rejects a selection outside the root or with only whitespace', () => {
    const outside = document.createElement('p');
    outside.textContent = 'elsewhere';
    document.body.append(outside);
    expect(
      anchorOfRange(root, selectText(outside.firstChild!, 0, outside.firstChild!, 4)),
    ).toBeNull();
    const first = root.querySelector('p')!.firstChild!;
    expect(anchorOfRange(root, selectText(first, 5, first, 6))).toBeNull();
  });

  it('leaves surrounding whitespace out of the quote', () => {
    const second = root.querySelectorAll('p')[1]!;
    root.insertBefore(document.createTextNode('\n'), second);
    const first = root.querySelector('p')!.firstChild!;
    expect(anchorOfRange(root, selectText(first, 5, second.firstChild!, 0))).toEqual({
      quote: 'bold line.',
      startOffset: 6,
      endOffset: 16,
    });
  });

  it('clamps a selection that ends outside the root', () => {
    const outside = document.createElement('p');
    outside.textContent = 'elsewhere';
    document.body.append(outside);
    const second = root.querySelectorAll('p')[1]!.firstChild!;
    const clamped = clampToRoot(root, selectText(second, 7, outside.firstChild!, 0));
    expect(anchorOfRange(root, clamped)?.quote).toBe('line.');
  });

  it('rebuilds a range from offsets', () => {
    expect(rangeFromOffsets(root, 6, 15)?.toString()).toBe('bold line');
    expect(rangeFromOffsets(root, 0, 999)).toBeNull();
  });

  it('uses stored offsets when they still match the quote', () => {
    const text = root.textContent!;
    const start = text.lastIndexOf('line');
    expect(
      locateAnchor(root, { quote: 'line', startOffset: start, endOffset: start + 4 })?.startOffset,
    ).toBe(start - text.indexOf('Second'));
  });

  it('searches for the quote when the offsets drifted', () => {
    const range = locateAnchor(root, { quote: 'Second', startOffset: 0, endOffset: 6 });
    expect(range?.toString()).toBe('Second');
    expect(locateAnchor(root, { quote: 'missing', startOffset: 0, endOffset: 7 })).toBeNull();
  });
});
