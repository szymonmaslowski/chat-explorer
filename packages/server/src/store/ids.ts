import { customAlphabet } from 'nanoid';
import { idAlphabet, idLength, idPrefixes, type PrefixedKind } from '@chat-explorer/shared/ids.js';

export const newId = customAlphabet(idAlphabet, idLength);

export const newPrefixedId = (kind: PrefixedKind) => `${idPrefixes[kind]}${newId()}`;
