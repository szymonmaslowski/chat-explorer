import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Config } from './config.js';
import { defaultWhisperModel, whisperModels } from './dictation/models.js';
import { claudeModels, defaultClaudeModel } from './shared/models.js';

const settingsSchema = z
  .object({
    publicUrl: z
      .url({ protocol: /^https?$/ })
      .nullable()
      .default(null)
      .transform((url) => (url ? new URL(url).origin : null)),
    defaultModel: z.enum(claudeModels).default(defaultClaudeModel),
    idleMinutes: z.number().positive().default(60),
    maxSessions: z.number().int().positive().default(3),
    dictation: z
      .object({
        model: z.enum(whisperModels).default(defaultWhisperModel),
        language: z.string().default('auto'),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type Settings = z.infer<typeof settingsSchema>;

export class SettingsError extends Error {}

export function loadSettings(config: Config): Settings {
  const fromFile: object = existsSync(config.settingsPath)
    ? parseJson(readFileSync(config.settingsPath, 'utf8'), config.settingsPath)
    : {};
  const publicUrl = process.env.CHAT_EXPLORER_PUBLIC_URL;
  const result = settingsSchema.safeParse(publicUrl ? { ...fromFile, publicUrl } : fromFile);
  if (!result.success) {
    throw new SettingsError(
      `Invalid settings in ${config.settingsPath}:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

function parseJson(text: string, path: string): object {
  try {
    return JSON.parse(text);
  } catch {
    throw new SettingsError(`${path} is not valid JSON.`);
  }
}
