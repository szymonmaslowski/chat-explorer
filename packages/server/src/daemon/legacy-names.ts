import { existsSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { idPattern, withPrefix, type PrefixedKind } from '@chat-explorer/shared/ids.js';

// Folders and files named after a chat or fork before ids had prefixes take the prefix too, so a
// fork's engine sessions are found under its new id.
export function prefixLegacyNames(directory: string, kind: PrefixedKind, extension = '') {
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(extension)) continue;
    const id = name.slice(0, name.length - extension.length);
    if (!idPattern.test(id)) continue;
    const target = join(directory, `${withPrefix(kind, id)}${extension}`);
    if (!existsSync(target)) renameSync(join(directory, name), target);
  }
}
