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
  it('places a card just above its anchor', () => {
    expect(layoutCards([request('a', 300, 40)], 700)).toEqual([
      { id: 'a', top: 244, left: 40, width: 200 },
    ]);
  });

  it('keeps cards inside the layer', () => {
    expect(layoutCards([request('a', 300, 650)], 700)[0]!.left).toBe(500);
  });

  it('stacks overlapping cards upwards', () => {
    const [first, second] = layoutCards([request('a', 300, 40), request('b', 300, 120)], 700);
    expect(first!.top).toBe(244);
    expect(second!.top).toBe(first!.top - 6 - 50);
  });

  it('leaves cards that do not overlap alone', () => {
    const [first, second] = layoutCards([request('a', 300, 0), request('b', 300, 400)], 700);
    expect(first!.top).toBe(second!.top);
  });
});
