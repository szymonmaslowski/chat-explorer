import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export const whisperCommand = 'whisper-cli';

export type DictationAvailability =
  | { available: true; whisperPath: string; modelPath: string }
  | { available: false; reason: string };

export function findOnPath(command: string, path = process.env.PATH ?? '') {
  for (const directory of path.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

export function dictationAvailability(modelPath: string): DictationAvailability {
  const whisperPath = findOnPath(whisperCommand);
  if (!whisperPath) {
    return {
      available: false,
      reason: `${whisperCommand} is not installed. Run: brew install whisper-cpp`,
    };
  }
  if (!existsSync(modelPath)) {
    return {
      available: false,
      reason: `The Whisper model ${modelPath} is missing. Run: chat-explorer dictation install`,
    };
  }
  return { available: true, whisperPath, modelPath };
}
