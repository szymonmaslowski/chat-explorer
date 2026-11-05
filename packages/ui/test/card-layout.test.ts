import { describe, expect, it } from 'vitest';
import { layoutCards } from '../src/lib/card-layout';

const request = (id: string, anchorTop: number, anchorLeft: number, height = 50) => ({
  id,
  anchorTop,
  anchorLeft,
  width: 200,
  height,
});

describe('layoutCards', () => {
  it('places a card in the rail, level with its anchor', () => {
    expect(layoutCards([request('a', 300, 40)], 740)).toEqual([
      { id: 'a', top: 300, left: 740, width: 200 },
    ]);
  });

  it('moves an overlapping card down below the one above', () => {
    const [first, second] = layoutCards([request('a', 300, 40), request('b', 320, 120)], 740);
    expect(first!.top).toBe(300);
    expect(second!.top).toBe(300 + 50 + 6);
  });

  it('orders cards on the same line from left to right', () => {
    const placements = layoutCards([request('b', 300, 400), request('a', 300, 0)], 740);
    expect(placements.map((placement) => placement.id)).toEqual(['a', 'b']);
  });

  it('leaves cards that do not overlap at their anchors', () => {
    const [, second] = layoutCards([request('a', 300, 0), request('b', 600, 0)], 740);
    expect(second!.top).toBe(600);
  });
});
