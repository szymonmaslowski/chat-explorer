import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dictationAvailability } from '../src/dictation/availability.js';
import { defaultWhisperModel, whisperModelPath } from '../src/dictation/models.js';
import { Transcriber } from '../src/dictation/transcriber.js';
import { runWhisper } from '../src/dictation/whisper.js';

const modelPath = whisperModelPath(
  join(homedir(), '.chat-explorer', 'models'),
  defaultWhisperModel,
);
const canRun = process.platform === 'darwin' && dictationAvailability(modelPath).available;

describe.skipIf(!canRun)('real Whisper', () => {
  it('transcribes speech', { timeout: 60_000 }, async () => {
    const audioPath = join(mkdtempSync(join(tmpdir(), 'chat-explorer-speech-')), 'speech.wav');
    execFileSync('say', [
      '-v',
      'Samantha',
      '-o',
      audioPath,
      '--file-format=WAVE',
      '--data-format=LEI16@16000',
      'Store a version number per entity in Redis.',
    ]);
    const transcriber = new Transcriber({
      language: 'auto',
      checkAvailability: () => dictationAvailability(modelPath),
      run: runWhisper,
    });
    const text = await transcriber.transcribe({
      wav: readFileSync(audioPath),
      hint: 'Redis',
      signal: new AbortController().signal,
    });
    expect(text.toLowerCase()).toMatch(/version number per entity .* redis/);
  });
});
