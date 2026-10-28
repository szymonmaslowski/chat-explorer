import type { SpeechBlock } from '../shared/types.js';
import { StoreError } from '../store/errors.js';
import { speechText } from './announcements.js';
import { chooseVoice, type SpeakingVoice, type SpeechInspection } from './voices.js';

export interface SpeakerOptions {
  available: () => boolean;
  inspect: (text: string) => Promise<SpeechInspection>;
  synthesize: (
    text: string,
    voice: string | null,
    signal: AbortSignal,
  ) => Promise<Uint8Array<ArrayBuffer>>;
  timeoutMs?: number;
}

interface SpeechRequest {
  content: string;
  block: SpeechBlock;
  signal: AbortSignal;
}

const defaultTimeoutMs = 30_000;
// Language detection needs a few sentences; more only makes osascript's argument longer.
const maxInspectedLength = 4_000;

// Code tells nothing about the language of the prose around it.
const proseOf = (markdown: string) =>
  markdown.replace(/```[\s\S]*?```/g, ' ').slice(0, maxInspectedLength);

export class Speaker {
  constructor(private readonly options: SpeakerOptions) {}

  available() {
    return this.options.available();
  }

  async speak({ content, block, signal }: SpeechRequest) {
    if (!this.available()) {
      throw new StoreError('speech_unavailable', 'Reading aloud needs macOS speech (`say`).');
    }
    const voice = await this.voiceFor(content);
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? defaultTimeoutMs);
    return this.options
      .synthesize(
        speechText(block, voice.language),
        voice.identifier,
        AbortSignal.any([signal, timeout]),
      )
      .catch((error: Error) => {
        if (signal.aborted) throw new StoreError('cancelled', 'Reading aloud was cancelled.');
        throw new StoreError(
          'speech_failed',
          timeout.aborted
            ? 'Speech took too long and was stopped.'
            : `Speech failed: ${error.message}`,
        );
      });
  }

  // Chosen again for every block, so a newly installed voice is used at once. The same message
  // always detects as the same language, so its blocks still share one voice.
  private voiceFor(content: string) {
    return this.options
      .inspect(proseOf(content))
      .then(chooseVoice, (): SpeakingVoice => ({ language: null, identifier: null }));
  }
}
