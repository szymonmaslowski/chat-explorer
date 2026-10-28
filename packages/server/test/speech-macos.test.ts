import { describe, expect, it } from 'vitest';
import { inspectSpeech, macosSpeechAvailable, synthesizeSpeech } from '../src/speech/macos.js';
import { chooseVoice } from '../src/speech/voices.js';

describe.skipIf(!macosSpeechAvailable())('macOS speech', () => {
  it('detects the language and finds a voice for it', async () => {
    const inspection = await inspectSpeech('Wydaje mi się, że to działa całkiem dobrze.');
    expect(inspection.language).toBe('pl');
    expect(inspection.voices.length).toBeGreaterThan(0);
    expect(chooseVoice(inspection).identifier).toMatch(/^com\.apple\.voice\..*pl-PL/);
  });

  it('passes text that looks like an option to the script', async () => {
    expect((await inspectSpeech('--help is what you type to see the options.')).language).toBe(
      'en',
    );
  });

  it('renders speech as AAC in an MP4 container', async () => {
    const audio = await synthesizeSpeech(
      '-v is not an option here.',
      null,
      AbortSignal.timeout(20_000),
    );
    expect(Buffer.from(audio.subarray(4, 8)).toString('ascii')).toBe('ftyp');
  });
});
