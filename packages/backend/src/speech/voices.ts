export interface SystemVoice {
  identifier: string;
  language: string;
  quality: number;
}

export interface SpeechInspection {
  language: string | null;
  voices: SystemVoice[];
  preferredVoice: string | null;
}

export interface SpeakingVoice {
  language: string | null;
  identifier: string | null;
}

// Only these are regular voices `say` can use: the others are novelty voices (Bells, Zarvox),
// the robotic Eloquence voices, or Siri voices, which `say` cannot open.
const regularVoicePrefix = 'com.apple.voice.';

export const primaryLanguage = (language: string) => language.split(/[-_]/)[0]!.toLowerCase();

export function chooseVoice({ language, voices, preferredVoice }: SpeechInspection): SpeakingVoice {
  if (!language) return { language: null, identifier: null };
  const [best] = voices
    .filter(
      (voice) =>
        voice.identifier.startsWith(regularVoicePrefix) &&
        primaryLanguage(voice.language) === language,
    )
    .sort(
      (first, second) =>
        second.quality - first.quality ||
        Number(second.identifier === preferredVoice) -
          Number(first.identifier === preferredVoice) ||
        first.identifier.localeCompare(second.identifier),
    );
  return { language, identifier: best?.identifier ?? null };
}
