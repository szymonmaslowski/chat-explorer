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
