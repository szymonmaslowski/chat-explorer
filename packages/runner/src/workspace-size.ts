import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// The bytes a workspace takes, counting a symlink as the link itself. The agent writes this folder
// and can plant links to anywhere on the host, so nothing here follows one.
export async function workspaceSize(path: string): Promise<number> {
  const stats = await lstat(path);
  if (!stats.isDirectory()) return stats.size;
  let total = stats.size;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    total += entry.isDirectory() ? await workspaceSize(entryPath) : (await lstat(entryPath)).size;
  }
  return total;
}
