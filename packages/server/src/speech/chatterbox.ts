import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpeechEngine } from './engines.js';
import { SpeechWorker } from './speech-worker.js';
import { primaryLanguage } from './voices.js';

const chatterboxLanguages = new Set([
  'ar',
  'da',
  'de',
  'el',
  'en',
  'es',
  'fi',
  'fr',
  'he',
  'hi',
  'it',
  'ja',
  'ko',
  'ms',
  'nl',
  'no',
  'pl',
  'pt',
  'ru',
  'sv',
  'sw',
  'tr',
  'zh',
]);

const idleMs = 10 * 60 * 1000;

export const speechWorkerScript = fileURLToPath(new URL('./speech_worker.py', import.meta.url));

export function chatterboxPaths(speechPath: string) {
  return {
    venv: join(speechPath, 'venv'),
    python: join(speechPath, 'venv', 'bin', 'python'),
    // Written last by `speech install`, so a half-finished install is not used.
    installedMarker: join(speechPath, 'installed'),
  };
}

// The model goes next to the Python environment, so `speech uninstall` removes both.
export const chatterboxEnvironment = (speechPath: string) => ({
  ...process.env,
  HF_HOME: join(speechPath, 'huggingface'),
  PYTHONUNBUFFERED: '1',
});

export function chatterboxEngine(speechPath: string): SpeechEngine & { stop: () => void } {
  const paths = chatterboxPaths(speechPath);
  const worker = new SpeechWorker({
    command: paths.python,
    args: [speechWorkerScript],
    env: chatterboxEnvironment(speechPath),
    idleMs,
  });
  return {
    name: 'chatterbox',
    contentType: 'audio/mpeg',
    rendersAhead: true,
    timeoutMs: 5 * 60 * 1000,
    available: () => existsSync(paths.installedMarker),
    voiceFor: ({ language }) => {
      const primary = language && primaryLanguage(language);
      return primary && chatterboxLanguages.has(primary) ? primary : null;
    },
    async synthesize(text, language, signal) {
      const directory = await mkdtemp(join(tmpdir(), 'chat-explorer-speech-'));
      // The model cannot be interrupted mid-sentence, so a stopped request restarts the worker.
      const stopWorker = () => worker.stop();
      signal.addEventListener('abort', stopWorker, { once: true });
      try {
        const output = join(directory, 'speech.mp3');
        await worker.render(text, language, output);
        return new Uint8Array(await readFile(output));
      } finally {
        signal.removeEventListener('abort', stopWorker);
        await rm(directory, { recursive: true, force: true });
      }
    },
    stop: () => worker.stop(),
  };
}
