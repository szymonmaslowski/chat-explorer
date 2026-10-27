import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dictationAvailability, findOnPath } from '../src/dictation/availability.js';
import { dictationHint } from '../src/dictation/transcriber.js';
import { silentWav, transcriptText, whisperArguments } from '../src/dictation/whisper.js';
import { createTestApp, createTestTranscriber } from './helpers.js';

const wav = new Uint8Array(silentWav(1));
const transcribe = (
  transcriber: ReturnType<typeof createTestTranscriber>['transcriber'],
  signal = new AbortController().signal,
) => transcriber.transcribe({ wav, hint: '', signal });
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('whisper command', () => {
  it('passes the model, audio, language and hint', () => {
    expect(
      whisperArguments({
        modelPath: '/models/turbo.bin',
        audioPath: '/tmp/audio.wav',
        language: 'auto',
        hint: 'Redis, ETag',
      }),
    ).toEqual([
      '-m',
      '/models/turbo.bin',
      '-f',
      '/tmp/audio.wav',
      '-l',
      'auto',
      '-nt',
      '-np',
      '--prompt',
      'Redis, ETag',
    ]);
  });

  it('joins the printed segments into one line', () => {
    expect(transcriptText('\n Wydaje mi się,\n że to działa.\n')).toBe(
      'Wydaje mi się, że to działa.',
    );
  });

  it('keeps the hint short', () => {
    expect(dictationHint(`  Title\n${'x'.repeat(1000)}`)).toHaveLength(600);
  });
});

describe('dictation availability', () => {
  it('finds whisper-cli on PATH and the model on disk', () => {
    const directory = mkdtempSync(join(tmpdir(), 'chat-explorer-path-'));
    const binDirectory = join(directory, 'bin');
    mkdirSync(binDirectory);
    const whisperPath = join(binDirectory, 'whisper-cli');
    writeFileSync(whisperPath, '#!/bin/sh\n');
    expect(findOnPath('whisper-cli', binDirectory)).toBeNull();
    chmodSync(whisperPath, 0o755);
    expect(findOnPath('whisper-cli', `/missing:${binDirectory}`)).toBe(whisperPath);

    const modelPath = join(directory, 'model.bin');
    const originalPath = process.env.PATH;
    process.env.PATH = binDirectory;
    try {
      expect(dictationAvailability(modelPath)).toMatchObject({
        available: false,
        reason: expect.stringContaining('chat-explorer dictation install'),
      });
      writeFileSync(modelPath, 'model');
      expect(dictationAvailability(modelPath)).toEqual({
        available: true,
        whisperPath,
        modelPath,
      });
      process.env.PATH = '/missing';
      expect(dictationAvailability(modelPath)).toMatchObject({
        available: false,
        reason: expect.stringContaining('brew install whisper-cpp'),
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe('transcriber', () => {
  it('runs one recording at a time, in order', async () => {
    const { transcriber, calls } = createTestTranscriber();
    const first = transcribe(transcriber);
    const second = transcribe(transcriber);
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.audio).toEqual(Buffer.from(wav));

    calls[0]!.finish({ stdout: ' first\n' });
    expect(await first).toBe('first');
    await settle();
    expect(calls).toHaveLength(2);
    calls[1]!.finish({ stdout: ' second\n' });
    expect(await second).toBe('second');
  });

  it('drops a cancelled recording that is still waiting', async () => {
    const { transcriber, calls } = createTestTranscriber();
    const first = transcribe(transcriber);
    const cancel = new AbortController();
    const second = transcribe(transcriber, cancel.signal);
    cancel.abort();
    await settle();
    calls[0]!.finish({ stdout: 'first' });
    await first;
    await expect(second).rejects.toMatchObject({ code: 'cancelled' });
    expect(calls).toHaveLength(1);
  });

  it('stops a running transcription when cancelled', async () => {
    const { transcriber, calls } = createTestTranscriber();
    const cancel = new AbortController();
    const running = transcribe(transcriber, cancel.signal);
    await settle();
    cancel.abort();
    await expect(running).rejects.toMatchObject({ code: 'cancelled' });
    expect(calls[0]!.signal.aborted).toBe(true);
  });

  it('stops a transcription that takes too long', async () => {
    const { transcriber } = createTestTranscriber({ timeoutMs: 20 });
    await expect(transcribe(transcriber)).rejects.toMatchObject({
      code: 'transcription_timeout',
    });
  });

  it('reports a recording Whisper cannot read', async () => {
    const { transcriber, calls } = createTestTranscriber();
    const running = transcribe(transcriber);
    await settle();
    calls[0]!.finish({ code: 2, stderr: "error: failed to read audio file 'audio.wav'\n" });
    await expect(running).rejects.toMatchObject({ code: 'invalid_audio' });
  });

  it('reports other failures with the end of the output', async () => {
    const { transcriber, calls } = createTestTranscriber();
    const running = transcribe(transcriber);
    await settle();
    calls[0]!.finish({ code: 1, stderr: 'loading\nggml_metal_init: out of memory\n' });
    await expect(running).rejects.toMatchObject({
      code: 'transcription_failed',
      message: expect.stringContaining('out of memory'),
    });
  });

  it('refuses when whisper-cli or the model is missing', async () => {
    const { transcriber, availability, calls } = createTestTranscriber();
    availability.current = { available: false, reason: 'The Whisper model is missing.' };
    expect(transcriber.available()).toBe(false);
    await expect(transcribe(transcriber)).rejects.toMatchObject({
      code: 'dictation_unavailable',
      message: 'The Whisper model is missing.',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('transcription API', () => {
  const upload = (fields: Record<string, string | Blob>) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    return form;
  };

  it('transcribes an uploaded recording with the hint', async () => {
    const { request, whisperCalls } = createTestApp();
    const response = request('/api/transcriptions', {
      method: 'POST',
      body: upload({ audio: new Blob([wav], { type: 'audio/wav' }), hint: 'Caching API' }),
    });
    await settle();
    expect(whisperCalls[0]!.args.slice(-2)).toEqual(['--prompt', 'Caching API']);
    whisperCalls[0]!.finish({ stdout: ' Hello there.\n' });
    expect(await (await response).json()).toEqual({ text: 'Hello there.' });
  });

  it('requires the audio', async () => {
    const { request } = createTestApp();
    const response = await request('/api/transcriptions', {
      method: 'POST',
      body: upload({ hint: 'no audio' }),
    });
    expect(response.status).toBe(400);
  });

  it('refuses a recording over the size limit', async () => {
    const { request, whisperCalls } = createTestApp();
    const response = await request('/api/transcriptions', {
      method: 'POST',
      body: upload({ audio: new Blob([new Uint8Array(21 * 1024 * 1024)]) }),
    });
    expect(response.status).toBe(413);
    expect(whisperCalls).toHaveLength(0);
  });

  it('reports whether dictation is available', async () => {
    const { request } = createTestApp();
    expect(await (await request('/api/settings')).json()).toEqual({
      defaultModel: 'sonnet',
      dictation: true,
    });
  });
});
