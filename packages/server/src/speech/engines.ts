import type { SpeechInspection } from './voices.js';

export const speechEngineNames = ['chatterbox', 'say'] as const;
export type SpeechEngineName = (typeof speechEngineNames)[number];

export interface SpeechEngine {
  name: SpeechEngineName;
  contentType: string;
  // A slow engine renders a new answer as soon as it arrives, so playing it later is instant.
  rendersAhead: boolean;
  timeoutMs: number;
  available: () => boolean;
  // Everything besides the text that changes the sound, as part of the cache key. Null when the
  // engine cannot speak the language.
  voiceFor: (inspection: SpeechInspection) => string | null;
  synthesize: (
    text: string,
    voice: string,
    signal: AbortSignal,
  ) => Promise<Uint8Array<ArrayBuffer>>;
}
