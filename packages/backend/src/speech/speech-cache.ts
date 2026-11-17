import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

export const speechCacheKey = (engine: string, voice: string, text: string) =>
  createHash('sha256')
    .update(JSON.stringify([engine, voice, text]))
    .digest('hex');

// Rendered speech on disk, least recently played removed first once it outgrows its size.
export class SpeechCache {
  constructor(
    private readonly directory: string,
    private readonly maxBytes: number,
  ) {}

  has(key: string) {
    return access(join(this.directory, key)).then(
      () => true,
      () => false,
    );
  }

  async read(key: string) {
    const path = join(this.directory, key);
    try {
      const audio = new Uint8Array(await readFile(path));
      const now = new Date();
      await utimes(path, now, now);
      return audio;
    } catch {
      return null;
    }
  }

  async write(key: string, audio: Uint8Array) {
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, key);
    await writeFile(`${path}.part`, audio);
    await rename(`${path}.part`, path);
    await this.evict();
  }

  private async evict() {
    const names = (await readdir(this.directory)).filter((name) => !name.endsWith('.part'));
    // Another write may evict a file between the listing and its stat.
    const files = (
      await Promise.all(
        names.map((name) =>
          stat(join(this.directory, name)).then(
            ({ size, mtimeMs }) => ({ name, size, mtimeMs }),
            () => null,
          ),
        ),
      )
    ).filter((file) => file !== null);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files.sort((first, second) => first.mtimeMs - second.mtimeMs)) {
      if (total <= this.maxBytes) return;
      await rm(join(this.directory, file.name), { force: true });
      total -= file.size;
    }
  }
}
