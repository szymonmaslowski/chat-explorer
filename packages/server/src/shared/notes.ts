import type { Note } from './types.js';

export function defaultGroupName(takenNames: string[]) {
  if (takenNames.length === 0) return 'General';
  const taken = new Set(takenNames);
  let number = takenNames.length + 1;
  while (taken.has(`Group ${number}`)) number += 1;
  return `Group ${number}`;
}

// A null `afterNoteId` puts the note first. An anchor that is gone leaves the order as it was.
export function reorderedIds(noteIds: string[], noteId: string, afterNoteId: string | null) {
  const others = noteIds.filter((id) => id !== noteId);
  if (!noteIds.includes(noteId)) return noteIds;
  if (afterNoteId === null) return [noteId, ...others];
  const anchor = others.indexOf(afterNoteId);
  if (anchor === -1) return noteIds;
  return [...others.slice(0, anchor + 1), noteId, ...others.slice(anchor + 1)];
}

// A fork started from a note opens with this line: the id lets Claude look the note up, and the
// link opens it from the chat.
export function noteForkMessage(
  note: Pick<Note, 'id' | 'explorationId' | 'topic'>,
  message: string,
) {
  const title = (note.topic ?? note.id).replace(/[[\]\\]/g, '\\$&');
  const link = `[${title}](/e/${note.explorationId}/notes#n-${note.id})`;
  return `Regarding note ${link} (id \`${note.id}\`):\n\n${message.trim()}`;
}
