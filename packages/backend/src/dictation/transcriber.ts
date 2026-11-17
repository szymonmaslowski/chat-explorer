import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoreError } from '../store/errors.js';
import type { DictationAvailability } from './availability.js';
import { transcriptText, whisperArguments, type WhisperRunner } from './whisper.js';

export interface TranscriberOptions {
  language: string;
  checkAvailability: () => DictationAvailability;
  run: WhisperRunner;
  timeoutMs?: number;
}

interface TranscriptionRequest {
  wav: Uint8Array;
  hint: string;
  signal: AbortSignal;
}

const defaultTimeoutMs = 120_000;
// Whisper keeps at most 224 prompt tokens; a few hundred characters stay well inside that.
const maxHintLength = 600;
const errorTailLines = 5;

export function dictationHint(hint: string) {
  return hint.trim().slice(0, maxHintLength);
}

export class Transcriber {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: TranscriberOptions) {}

  available() {
    return this.options.checkAvailability().available;
  }

  // One run at a time: a second whisper-cli would only compete for the same GPU.
  transcribe(input: TranscriptionRequest) {
    const turn = this.queue.then(() => this.run(input));
    this.queue = turn.catch(() => {});
    return turn;
  }

  private async run({ wav, hint, signal }: TranscriptionRequest) {
    if (signal.aborted) throw new StoreError('cancelled', 'The transcription was cancelled.');
    const availability = this.options.checkAvailability();
    if (!availability.available) {
      throw new StoreError('dictation_unavailable', availability.reason);
    }
    const directory = await mkdtemp(join(tmpdir(), 'chat-explorer-dictation-'));
    try {
      const audioPath = join(directory, 'audio.wav');
      await writeFile(audioPath, wav);
      const args = whisperArguments({
        modelPath: availability.modelPath,
        audioPath,
        language: this.options.language,
        hint,
      });
      const timeout = AbortSignal.timeout(this.options.timeoutMs ?? defaultTimeoutMs);
      const result = await this.options
        .run(availability.whisperPath, args, AbortSignal.any([signal, timeout]))
        .catch((error: Error) => {
          if (timeout.aborted) {
            throw new StoreError('transcription_timeout', 'Whisper took too long and was stopped.');
          }
          if (signal.aborted) throw new StoreError('cancelled', 'The transcription was cancelled.');
          throw error;
        });
      if (result.code === 0) return transcriptText(result.stdout);
      if (result.stderr.includes('failed to read audio')) {
        throw new StoreError('invalid_audio', 'Whisper could not read the recording.');
      }
      const tail = result.stderr.trimEnd().split('\n').slice(-errorTailLines).join('\n');
      throw new StoreError(
        'transcription_failed',
        `Whisper exited with code ${result.code}.\n\n${tail}`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
