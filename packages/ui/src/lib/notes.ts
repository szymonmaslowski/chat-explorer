import type { Note, NoteGroup } from '@shared/types';

export const sortedGroups = (groups: Map<string, NoteGroup>) =>
  [...groups.values()].sort((first, second) => first.position - second.position);

export const notesInGroup = (notes: Map<string, Note>, groupId: string) =>
  [...notes.values()]
    .filter((note) => note.groupId === groupId)
    .sort((first, second) => first.position - second.position);

// Positions of notes or groups follow the given order; the ones it does not list keep theirs.
export function applyOrder<Item extends { position: number }>(
  items: Map<string, Item>,
  ids: string[],
) {
  ids.forEach((id, index) => {
    const item = items.get(id);
    if (item && item.position !== index + 1) items.set(id, { ...item, position: index + 1 });
  });
}

export const renumberGroup = (notes: Map<string, Note>, groupId: string) =>
  applyOrder(
    notes,
    notesInGroup(notes, groupId).map((note) => note.id),
  );

export const checklistOrders = ['original', 'unchecked-first'] as const;
export type ChecklistOrder = (typeof checklistOrders)[number];

const checklistOrderKey = (groupId: string) => `chat-explorer.checklist-order.${groupId}`;

export function readChecklistOrder(groupId: string): ChecklistOrder {
  try {
    const stored = localStorage.getItem(checklistOrderKey(groupId));
    return checklistOrders.find((order) => order === stored) ?? 'original';
  } catch {
    return 'original';
  }
}

export function storeChecklistOrder(groupId: string, order: ChecklistOrder) {
  try {
    localStorage.setItem(checklistOrderKey(groupId), order);
  } catch {}
}

export const uncheckedFirst = (notes: Note[]) => [
  ...notes.filter((note) => !note.checked),
  ...notes.filter((note) => note.checked),
];

export interface NoteSection {
  // Null for the notes with no category, which come first and have no heading.
  name: string | null;
  notes: Note[];
}

// The notes of a group in the order they are shown: those with no category first, then each
// category where its first note stands, the notes in each keeping their order. Takes the notes in
// their stored order.
export function noteSections(notes: Note[]): NoteSection[] {
  const sections = new Map<string | null, Note[]>([[null, []]]);
  for (const note of notes) {
    const section = sections.get(note.category);
    if (section) section.push(note);
    else sections.set(note.category, [note]);
  }
  return [...sections]
    .filter(([, each]) => each.length > 0)
    .map(([name, each]) => ({ name, notes: each }));
}

const collapsedKey = (groupId: string) => `chat-explorer.collapsed-categories.${groupId}`;

// Folding is a choice of the device, so it is kept here and not with the notes.
export function readCollapsedCategories(groupId: string): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(collapsedKey(groupId)) ?? '[]');
    return Array.isArray(stored) ? stored.filter((name) => typeof name === 'string') : [];
  } catch {
    return [];
  }
}

export function storeCollapsedCategories(groupId: string, names: string[]) {
  try {
    if (names.length === 0) localStorage.removeItem(collapsedKey(groupId));
    else localStorage.setItem(collapsedKey(groupId), JSON.stringify(names));
  } catch {}
}

// Where a dragged note may land among the other shown notes. It stays in its own category, and
// with unchecked notes first in its own part of it, so a drag never moves it to another category
// or ticks or unticks it.
export function dropRange(shown: Note[], noteId: string, keepsParts: boolean) {
  const others = shown.filter((note) => note.id !== noteId);
  const dragged = shown.find((note) => note.id === noteId);
  if (!dragged) return { first: 0, last: others.length };
  const together = (note: Note) =>
    note.category === dragged.category && (!keepsParts || note.checked === dragged.checked);
  const first = others.findIndex(together);
  if (first === -1) return { first: shown.indexOf(dragged), last: shown.indexOf(dragged) };
  return { first, last: first + others.filter(together).length };
}

// The note to put the dragged one after, in the stored order, for a drop at `index` among the
// other shown notes: its new neighbour above, or, first in its part, just before the one below.
export function dropAnchor(
  shown: Note[],
  stored: Note[],
  noteId: string,
  index: number,
  keepsParts: boolean,
) {
  const others = shown.filter((note) => note.id !== noteId);
  if (index > dropRange(shown, noteId, keepsParts).first) return others[index - 1]?.id ?? null;
  const storedOthers = stored.filter((note) => note.id !== noteId);
  const below = others[index];
  if (!below) return storedOthers.at(-1)?.id ?? null;
  const belowPosition = storedOthers.findIndex((note) => note.id === below.id);
  return storedOthers[belowPosition - 1]?.id ?? null;
}
