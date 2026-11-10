import { describe, expect, it } from 'vitest';
import { groupBy, keepSameGroups, keepSameList } from '../src/lib/stable';

describe('keepSameList', () => {
  it('keeps the previous list when it holds the same items', () => {
    const first = { id: 'a' };
    const previous = [first];
    expect(keepSameList(previous, [first])).toBe(previous);
  });

  it('takes the new list when an item changed', () => {
    const next = [{ id: 'a' }];
    expect(keepSameList([{ id: 'a' }], next)).toBe(next);
  });
});

describe('keepSameGroups', () => {
  it('keeps unchanged groups and replaces changed ones', () => {
    const [a, b, c] = [{ key: 'x' }, { key: 'y' }, { key: 'y' }];
    const previous = groupBy([a, b], (item) => item.key);
    const next = keepSameGroups(
      previous,
      groupBy([a, b, c], (item) => item.key),
    );
    expect(next.get('x')).toBe(previous.get('x'));
    expect(next.get('y')).toEqual([b, c]);
    expect(next.get('y')).not.toBe(previous.get('y'));
  });

  it('keeps the previous map when no group changed', () => {
    const item = { key: 'x' };
    const previous = groupBy([item], (each) => each.key);
    expect(keepSameGroups(previous, groupBy([item], (each) => each.key))).toBe(previous);
  });

  it('leaves out items without a key', () => {
    expect([...groupBy([{ key: null }], (item) => item.key).keys()]).toEqual([]);
  });
});
