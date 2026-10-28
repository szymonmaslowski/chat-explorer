import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { findOnPath } from '../dictation/availability.js';
import type { SpeechInspection } from './voices.js';

const execFileAsync = promisify(execFile);

// JavaScript for Automation: Apple's language recogniser and the installed voices.
const inspectScript = `
ObjC.import('NaturalLanguage');
ObjC.import('AVFAudio');
function run(argv) {
  const recognizer = $.NLLanguageRecognizer.alloc.init;
  recognizer.processString(argv[0]);
  const language = ObjC.unwrap(recognizer.dominantLanguage) ?? null;
  const voices = ObjC.unwrap($.AVSpeechSynthesisVoice.speechVoices).map((voice) => ({
    identifier: ObjC.unwrap(voice.identifier),
    language: ObjC.unwrap(voice.language),
    quality: Number(voice.quality),
  }));
  const preferred = language ? $.AVSpeechSynthesisVoice.voiceWithLanguage(language) : null;
  const preferredVoice = preferred && !preferred.isNil() ? ObjC.unwrap(preferred.identifier) : null;
  return JSON.stringify({ language, voices, preferredVoice });
}`;

const inspectionSchema = z.object({
  language: z.string().nullable(),
  voices: z.array(z.object({ identifier: z.string(), language: z.string(), quality: z.number() })),
  preferredVoice: z.string().nullable(),
});

export const macosSpeechAvailable = () =>
  process.platform === 'darwin' && findOnPath('say') !== null && findOnPath('osascript') !== null;

export async function inspectSpeech(text: string): Promise<SpeechInspection> {
  const { stdout } = await execFileAsync('osascript', [
    '-l',
    'JavaScript',
    '-e',
    inspectScript,
    '--',
    text,
  ]);
  return inspectionSchema.parse(JSON.parse(stdout));
}

export async function synthesizeSpeech(text: string, voice: string | null, signal: AbortSignal) {
  const directory = await mkdtemp(join(tmpdir(), 'chat-explorer-speech-'));
  try {
    const textPath = join(directory, 'text.txt');
    const audioPath = join(directory, 'speech.m4a');
    await writeFile(textPath, text);
    await execFileAsync(
      'say',
      [
        ...(voice ? ['-v', voice] : []),
        '-f',
        textPath,
        '-o',
        audioPath,
        '--file-format=m4af',
        '--data-format=aac',
      ],
      { signal, killSignal: 'SIGKILL' },
    );
    return new Uint8Array(await readFile(audioPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
