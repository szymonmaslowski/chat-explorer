import type { Note, NoteGroup } from '@shared/types';

export const sortedGroups = (groups: Map<string, NoteGroup>) =>
  [...groups.values()].sort((first, second) => first.position - second.position);

export const notesInGroup = (notes: Map<string, Note>, groupId: string) =>
  [...notes.values()]
    .filter((note) => note.groupId === groupId)
    .sort((first, second) => first.position - second.position);

// Positions follow the given order; notes it does not list keep theirs.
export function applyNoteOrder(notes: Map<string, Note>, noteIds: string[]) {
  noteIds.forEach((noteId, index) => {
    const note = notes.get(noteId);
    if (note && note.position !== index + 1) notes.set(noteId, { ...note, position: index + 1 });
  });
}

export const renumberGroup = (notes: Map<string, Note>, groupId: string) =>
  applyNoteOrder(
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

// Where a dragged note may land among the other shown notes. With unchecked notes first it stays
// in its own part, so a drag never ticks or unticks it.
export function dropRange(shown: Note[], noteId: string, keepsParts: boolean) {
  const others = shown.filter((note) => note.id !== noteId);
  const dragged = shown.find((note) => note.id === noteId);
  if (!keepsParts || !dragged) return { first: 0, last: others.length };
  const uncheckedCount = others.filter((note) => !note.checked).length;
  return dragged.checked
    ? { first: uncheckedCount, last: others.length }
    : { first: 0, last: uncheckedCount };
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
