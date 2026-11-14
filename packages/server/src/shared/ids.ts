// The daemon makes ids, and so does the page for changes it queues while offline.
export const idAlphabet = '0123456789abcdefghjkmnpqrstvwxyz';
export const idLength = 10;
export const idPattern = new RegExp(`^[${idAlphabet}]{${idLength}}$`);

// The ids people see and copy name their kind. Ids from before the prefixes are the same ids
// without them, so withPrefix turns an old one into the new one.
export const idPrefixes = { chat: 'chat_', fork: 'fork_', note: 'note_' } as const;
export type PrefixedKind = keyof typeof idPrefixes;

export const prefixedIdPattern = new RegExp(
  `^(?:${Object.values(idPrefixes).join('|')})?[${idAlphabet}]{${idLength}}$`,
);

export const withPrefix = (kind: PrefixedKind, id: string) =>
  idPattern.test(id) ? `${idPrefixes[kind]}${id}` : id;
