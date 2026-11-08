import { describe, expect, it } from 'vitest';
import { lineBoxes, nestingLevels, outlinePath } from '../src/lib/outlines';

const box = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});

describe('lineBoxes', () => {
  it('joins the rects of one line and drops empty ones', () => {
    expect(
      lineBoxes([box(50, 2, 90, 20), box(0, 0, 40, 20), box(95, 0, 95, 20), box(0, 30, 70, 50)]),
    ).toEqual([box(0, 0, 90, 20), box(0, 30, 70, 50)]);
  });
});

describe('outlinePath', () => {
  it('draws one box around a single line', () => {
    expect(outlinePath([box(10, 0, 50, 20)], 2)).toBe('M 8 -2 H 52 V 22 H 8 V -2 Z');
  });

  it('draws one shape around lines that follow each other, meeting halfway', () => {
    expect(outlinePath([box(40, 0, 100, 20), box(0, 30, 60, 50)], 1)).toBe(
      'M 39 -1 H 101 V 25 H 61 V 51 H -1 V 25 H 39 V -1 Z',
    );
  });

  it('draws separate shapes for lines that do not overlap or are far apart', () => {
    const notOverlapping = outlinePath([box(80, 0, 100, 20), box(0, 30, 40, 50)], 0);
    expect(notOverlapping.match(/M /g)).toHaveLength(2);
    const farApart = outlinePath([box(0, 0, 100, 20), box(0, 200, 100, 220)], 0);
    expect(farApart.match(/M /g)).toHaveLength(2);
  });
});

describe('nestingLevels', () => {
  const span = (id: string, startOffset: number, endOffset: number, messageId = 'm1') => ({
    id,
    messageId,
    startOffset,
    endOffset,
  });

  it('counts the spans nested inside each span', () => {
    const levels = nestingLevels([
      span('section', 0, 100),
      span('sentence', 0, 30),
      span('word', 5, 10),
      span('overlapping', 25, 40),
      span('elsewhere', 0, 100, 'm2'),
    ]);
    expect(Object.fromEntries(levels)).toEqual({
      section: 2,
      sentence: 1,
      word: 0,
      overlapping: 0,
      elsewhere: 0,
    });
  });

  it('nests spans with the same text one inside the other', () => {
    const levels = nestingLevels([span('first', 0, 10), span('second', 0, 10)]);
    expect([...levels.values()].sort()).toEqual([0, 1]);
  });
});
