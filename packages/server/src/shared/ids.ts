// The daemon makes ids, and so does the page for changes it queues while offline.
export const idAlphabet = '0123456789abcdefghjkmnpqrstvwxyz';
export const idLength = 10;
export const idPattern = new RegExp(`^[${idAlphabet}]{${idLength}}$`);
