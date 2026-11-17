// What the terminal's and the runner's note tools share.
export const readNotesLimit = 10;

export const readNotesDescription = `Read the full text of notes by their ids, up to ${readNotesLimit} at a time, with each note's group.`;

export const searchNotesDescription =
  "Find notes holding every word of the query in their topic or text. Returns each match's id, topic and a snippet around the words; read the whole note with read_notes.";
