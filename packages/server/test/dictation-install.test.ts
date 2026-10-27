import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureModel, InstallError } from '../src/dictation/install.js';

const modelBytes = Buffer.alloc(300_000, 7);
const sha256 = createHash('sha256').update(modelBytes).digest('hex');

let server: Server;
let url: string;
let requests: number;
let breakDownload: boolean;
let directory: string;

beforeEach(async () => {
  requests = 0;
  breakDownload = false;
  directory = mkdtempSync(join(tmpdir(), 'chat-explorer-models-'));
  server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { 'content-length': modelBytes.length });
    if (!breakDownload) return response.end(modelBytes);
    response.write(modelBytes.subarray(0, 1000));
    setTimeout(() => response.destroy(), 10);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.bin`;
});

afterEach(() => server.close());

const install = (expectedSha256 = sha256) => {
  const progress: number[] = [];
  const modelPath = join(directory, 'model.bin');
  const result = ensureModel({
    file: { fileName: 'model.bin', url, bytes: modelBytes.length, sha256: expectedSha256 },
    modelPath,
    onProgress: (receivedBytes) => progress.push(receivedBytes),
  });
  return { result, progress, modelPath };
};

describe('model download', () => {
  it('downloads and verifies the model, reporting progress', async () => {
    const { result, progress, modelPath } = install();
    expect(await result).toEqual({ downloaded: true });
    expect(readFileSync(modelPath)).toEqual(modelBytes);
    expect(progress.at(-1)).toBe(modelBytes.length);
    expect(readdirSync(directory)).toEqual(['model.bin']);
  });

  it('keeps a model that is already in place', async () => {
    writeFileSync(join(directory, 'model.bin'), modelBytes);
    expect(await install().result).toEqual({ downloaded: false });
    expect(requests).toBe(0);
  });

  it('replaces a damaged model', async () => {
    writeFileSync(join(directory, 'model.bin'), 'damaged');
    expect(await install().result).toEqual({ downloaded: true });
    expect(readFileSync(join(directory, 'model.bin'))).toEqual(modelBytes);
  });

  it('throws away a download that does not match the checksum', async () => {
    await expect(install('0'.repeat(64)).result).rejects.toThrow(InstallError);
    expect(readdirSync(directory)).toEqual([]);
  });

  it('leaves no model behind when the download breaks off', async () => {
    breakDownload = true;
    const { result, modelPath } = install();
    await expect(result).rejects.toThrow();
    expect(existsSync(modelPath)).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  });
});
