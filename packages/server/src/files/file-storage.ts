import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { StoreError } from '../store/errors.js';
import { newId } from '../store/ids.js';
import type { ChatStore } from '../store/store.js';
import { classifyFile, maxFileBytes, storedFileName } from './kinds.js';

const draftLifetimeMs = 24 * 60 * 60 * 1000;

// Each file sits in a directory named by its id, under the name it was uploaded with.
export class FileStorage {
  constructor(
    private readonly store: ChatStore,
    private readonly directory: string,
    private readonly now: () => number = Date.now,
  ) {}

  async add(input: { name: string; mediaType: string; bytes: Uint8Array }) {
    if (input.bytes.length > maxFileBytes) {
      throw new StoreError('too_large', `${input.name} is larger than 10 MB.`);
    }
    const fileClass = classifyFile(input.name, input.mediaType, input.bytes);
    if (!fileClass) {
      throw new StoreError(
        'unsupported_file',
        `${input.name} is not an image, a PDF or a text file.`,
      );
    }
    const id = newId();
    const name = storedFileName(input.name, fileClass);
    const path = join(this.directory, id, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.bytes);
    return this.store.createFile({
      id,
      name,
      kind: fileClass.kind,
      mediaType: fileClass.mediaType,
      size: input.bytes.length,
      path,
    });
  }

  async removeDraft(fileId: string) {
    await this.removeFiles([this.store.deleteDraftFile(fileId).path]);
  }

  async removeFiles(paths: string[]) {
    await Promise.all(paths.map((path) => rm(dirname(path), { recursive: true, force: true })));
  }

  removeStaleDrafts() {
    return this.removeFiles(this.store.deleteDraftFilesBefore(this.now() - draftLifetimeMs));
  }
}
