import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Config } from '../config.js';
import { dictationAvailability, findOnPath, whisperCommand } from './availability.js';
import {
  whisperModelFiles,
  whisperModels,
  whisperModelPath,
  type WhisperModel,
  type WhisperModelFile,
} from './models.js';
import { Transcriber } from './transcriber.js';
import { runWhisper, silentWav } from './whisper.js';

const spareBytes = 100 * 1024 * 1024;

export class InstallError extends Error {}

export type DownloadProgress = (receivedBytes: number, totalBytes: number) => void;

export const megabytes = (bytes: number) => Math.round(bytes / 1024 / 1024);

export async function installDictation(input: {
  config: Config;
  model: WhisperModel;
  log: (line: string) => void;
  onProgress: DownloadProgress;
}) {
  if (!findOnPath(whisperCommand)) {
    throw new InstallError(`${whisperCommand} is not installed. Run: brew install whisper-cpp`);
  }
  const modelPath = whisperModelPath(input.config.modelsPath, input.model);
  const { downloaded } = await ensureModel({
    file: whisperModelFiles[input.model],
    modelPath,
    onProgress: input.onProgress,
  });
  input.log(downloaded ? `Downloaded ${modelPath}.` : `${modelPath} is already in place.`);
  input.log('Running Whisper once; the very first run compiles GPU code and takes a while…');
  await warmUp(modelPath);
  return { modelPath };
}

export async function ensureModel(input: {
  file: WhisperModelFile;
  modelPath: string;
  onProgress: DownloadProgress;
}) {
  const { file, modelPath } = input;
  if (existsSync(modelPath) && (await fileSha256(modelPath)) === file.sha256) {
    return { downloaded: false };
  }
  await mkdir(dirname(modelPath), { recursive: true });
  await checkDiskSpace(dirname(modelPath), file.bytes);
  const partPath = `${modelPath}.part`;
  try {
    const sha256 = await download(file.url, partPath, file.bytes, input.onProgress);
    if (sha256 !== file.sha256) {
      throw new InstallError(
        `The downloaded model does not match its checksum (got ${sha256}). Try again.`,
      );
    }
    await rename(partPath, modelPath);
  } finally {
    await rm(partPath, { force: true });
  }
  return { downloaded: true };
}

async function checkDiskSpace(directory: string, bytes: number) {
  const stats = await statfs(directory);
  const freeBytes = stats.bavail * stats.bsize;
  if (freeBytes < bytes + spareBytes) {
    throw new InstallError(
      `Not enough disk space: the model needs ${megabytes(bytes)} MB plus ${megabytes(spareBytes)} MB spare, ${megabytes(freeBytes)} MB are free.`,
    );
  }
}

async function download(
  url: string,
  path: string,
  totalBytes: number,
  onProgress: DownloadProgress,
) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new InstallError(`Downloading ${url} failed with HTTP ${response.status}.`);
  }
  const body = response.body;
  const hash = createHash('sha256');
  let receivedBytes = 0;
  await pipeline(async function* () {
    for await (const chunk of body) {
      hash.update(chunk);
      receivedBytes += chunk.length;
      onProgress(receivedBytes, totalBytes);
      yield chunk;
    }
  }, createWriteStream(path));
  return hash.digest('hex');
}

async function fileSha256(path: string) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function warmUp(modelPath: string) {
  const transcriber = new Transcriber({
    language: 'auto',
    checkAvailability: () => dictationAvailability(modelPath),
    run: runWhisper,
  });
  await transcriber.transcribe({
    wav: silentWav(1),
    hint: '',
    signal: new AbortController().signal,
  });
}

export async function uninstallDictation(config: Config) {
  const removed: string[] = [];
  for (const model of whisperModels) {
    const modelPath = whisperModelPath(config.modelsPath, model);
    for (const path of [modelPath, `${modelPath}.part`]) {
      if (!existsSync(path)) continue;
      await rm(path);
      removed.push(path);
    }
  }
  return removed;
}
