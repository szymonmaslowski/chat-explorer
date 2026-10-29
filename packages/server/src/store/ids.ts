import { customAlphabet } from 'nanoid';
import { idAlphabet, idLength } from '../shared/ids.js';

export const newId = customAlphabet(idAlphabet, idLength);
