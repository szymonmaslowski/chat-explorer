import { existsSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

const port = 4519;
const home = join(tmpdir(), 'chat-explorer-e2e');
const backend = '../backend/dist';
const cli = '../cli/dist';
const fakeWhisper = resolve('e2e/fake-whisper');
const microphoneAudio = join(tmpdir(), 'chat-explorer-e2e-microphone.wav');
// Node alone, not its whole folder: a global npm install puts `claude` beside node, as in the coding
// image, and the tests need it missing.
const nodeOnly = join(tmpdir(), 'chat-explorer-e2e-node');
const nodeLink = join(nodeOnly, 'node');
// Each test worker loads this file again while the daemon runs, so the link is replaced only when
// it points elsewhere.
mkdirSync(nodeOnly, { recursive: true });
if (!existsSync(nodeLink) || readlinkSync(nodeLink) !== process.execPath) {
  rmSync(nodeLink, { force: true });
  symlinkSync(process.execPath, nodeLink);
}

// Chrome's fake microphone plays this file: a tone loud enough to count as speech.
function writeToneWav(path: string, seconds: number, sampleRate = 48_000) {
  const sampleCount = seconds * sampleRate;
  const wav = Buffer.alloc(44 + sampleCount * 2);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + sampleCount * 2, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(sampleCount * 2, 40);
  for (let index = 0; index < sampleCount; index++) {
    const sample = Math.sin((2 * Math.PI * 220 * index) / sampleRate) * 0.4;
    wav.writeInt16LE(Math.round(sample * 0x7fff), 44 + index * 2);
  }
  writeFileSync(path, wav);
}

writeToneWav(microphoneAudio, 5);

// In a coding fork's container, the image sets this to its Chromium: there is no Google Chrome
// there. Its sandbox needs privileges the container drops, and /dev/shm is small.
const containerChrome = process.env.CHAT_EXPLORER_CHROME;

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    ...(containerChrome ? {} : { channel: 'chrome' as const }),
    // Page routes do not reach requests a service worker makes, so tests run without one, except
    // those about it.
    serviceWorkers: 'block',
    viewport: { width: 1100, height: 700 },
    permissions: ['microphone'],
    launchOptions: {
      ...(containerChrome ? { executablePath: containerChrome } : {}),
      args: [
        ...(containerChrome ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${microphoneAudio}`,
      ],
    },
  },
  webServer: {
    command: `rm -rf "${home}" && mkdir -p "${home}/models" && touch "${home}/models/ggml-large-v3-turbo-q5_0.bin" && node ${backend}/dev/seed.js && node ${cli}/daemon/main.js`,
    url: `http://127.0.0.1:${port}/api/health`,
    // Without `claude` on PATH, background sessions fail to start instead of running Claude.
    // A fake whisper-cli stands in for Whisper, with an empty model file next to it.
    env: {
      CHAT_EXPLORER_HOME: home,
      CHAT_EXPLORER_PORT: String(port),
      PATH: `${fakeWhisper}:${nodeOnly}:/usr/bin:/bin`,
    },
    reuseExistingServer: false,
  },
});
