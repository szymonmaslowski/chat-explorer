// A list or group rebuilt by a computed keeps its previous copy when it holds the same items, so
// the components that get it as a prop do not render again for nothing.

export const noItems: readonly never[] = Object.freeze([]);

const sameItems = <Item>(left: readonly Item[], right: readonly Item[]) =>
  left.length === right.length && left.every((item, index) => item === right[index]);

export const keepSameList = <Item>(previous: Item[] | undefined, next: Item[]) =>
  previous && sameItems(previous, next) ? previous : next;

export function groupBy<Item>(items: Iterable<Item>, keyOf: (item: Item) => string | null) {
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (key === null) continue;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

export const keepSameMap = <Value>(
  previous: Map<string, Value> | undefined,
  next: Map<string, Value>,
) =>
  previous &&
  previous.size === next.size &&
  [...next].every(([key, value]) => previous.get(key) === value)
    ? previous
    : next;

export function keepSameGroups<Item>(
  previous: Map<string, Item[]> | undefined,
  next: Map<string, Item[]>,
) {
  if (!previous) return next;
  for (const [key, items] of next) next.set(key, keepSameList(previous.get(key), items));
  return keepSameMap(previous, next);
}
