import type { Note } from './types.js';

export function defaultGroupName(takenNames: string[]) {
  if (takenNames.length === 0) return 'General';
  const taken = new Set(takenNames);
  let number = takenNames.length + 1;
  while (taken.has(`Group ${number}`)) number += 1;
  return `Group ${number}`;
}

// Moves a note or a group. A null `afterId` puts it first. An anchor that is gone leaves the
// order as it was.
export function reorderedIds(ids: string[], movedId: string, afterId: string | null) {
  const others = ids.filter((id) => id !== movedId);
  if (!ids.includes(movedId)) return ids;
  if (afterId === null) return [movedId, ...others];
  const anchor = others.indexOf(afterId);
  if (anchor === -1) return ids;
  return [...others.slice(0, anchor + 1), movedId, ...others.slice(anchor + 1)];
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
