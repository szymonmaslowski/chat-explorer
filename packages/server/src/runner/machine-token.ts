import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// The secret a runner sends with every request. The daemon makes it once; a runner on the same
// machine reads it from the same file.
export function ensureMachineToken(path: string) {
  if (existsSync(path)) return readMachineToken(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('base64url');
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

export const readMachineToken = (path: string) => readFileSync(path, 'utf8').trim();
