import { extname } from 'node:path';
import type { FileKind } from '../shared/types.js';

export const maxFileBytes = 10 * 1024 * 1024;
const maxNameLength = 100;

// The image formats Claude reads.
const imageTypesByExtension: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const imageExtensionsByType: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

export interface FileClass {
  kind: FileKind;
  mediaType: string;
  extension: string;
}

function isUtf8Text(bytes: Uint8Array) {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

const startsWith = (bytes: Uint8Array, prefix: string) =>
  Buffer.from(bytes.subarray(0, prefix.length)).toString('latin1') === prefix;

// Browsers report no type or a wrong one for many code files (.ts comes as video/mp2t), so the
// content decides whether a file is text.
export function classifyFile(name: string, mediaType: string, bytes: Uint8Array): FileClass | null {
  const extension = extname(name).toLowerCase();
  const imageType = imageExtensionsByType[mediaType] ? mediaType : imageTypesByExtension[extension];
  if (imageType) {
    return { kind: 'image', mediaType: imageType, extension: imageExtensionsByType[imageType]! };
  }
  if ((mediaType === 'application/pdf' || extension === '.pdf') && startsWith(bytes, '%PDF')) {
    return { kind: 'pdf', mediaType: 'application/pdf', extension: '.pdf' };
  }
  if (isUtf8Text(bytes)) {
    return { kind: 'text', mediaType: 'text/plain', extension: extension || '.txt' };
  }
  return null;
}

// The stored name keeps the original where it can, so Claude sees a meaningful file name, and
// always ends in an extension that matches the content.
export function storedFileName(name: string, fileClass: FileClass) {
  const base =
    name
      .split(/[\\/]/)
      .at(-1)!
      .replace(/[^\w.\- ()]/g, '_')
      .trim() || 'file';
  const stem = base.slice(0, base.length - extname(base).length) || 'file';
  const extension =
    fileClass.kind === 'text' ? extname(base) || fileClass.extension : fileClass.extension;
  return `${stem.slice(0, maxNameLength)}${extension}`;
}
