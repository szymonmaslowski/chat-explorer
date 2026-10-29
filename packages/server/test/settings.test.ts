import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { loadSettings, SettingsError } from '../src/settings.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'chat-explorer-settings-'));
  vi.stubEnv('CHAT_EXPLORER_HOME', home);
  vi.stubEnv('CHAT_EXPLORER_PUBLIC_URL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const writeSettings = (content: string) => writeFileSync(join(home, 'config.json'), content);

describe('settings', () => {
  it('uses defaults without a settings file', () => {
    expect(loadSettings(loadConfig())).toEqual({
      publicUrl: null,
      defaultModel: 'sonnet',
      idleMinutes: 60,
      maxSessions: 3,
      dictation: { model: 'large-v3-turbo-q5_0', language: 'auto' },
      speech: { engine: 'chatterbox', cacheMegabytes: 1024 },
    });
  });

  it('reads the file and keeps only the origin of the public URL', () => {
    writeSettings('{ "publicUrl": "https://mac.tailnet.ts.net/", "defaultModel": "opus" }');
    expect(loadSettings(loadConfig())).toMatchObject({
      publicUrl: 'https://mac.tailnet.ts.net',
      defaultModel: 'opus',
    });
  });

  it('lets the environment override the public URL', () => {
    writeSettings('{ "publicUrl": "https://old.example" }');
    vi.stubEnv('CHAT_EXPLORER_PUBLIC_URL', 'https://mac.tailnet.ts.net');
    expect(loadSettings(loadConfig()).publicUrl).toBe('https://mac.tailnet.ts.net');
  });

  it('names the problem in an invalid file', () => {
    writeSettings('{ "defaultModel": "gpt", "idelMinutes": 5 }');
    expect(() => loadSettings(loadConfig())).toThrow(SettingsError);
    expect(() => loadSettings(loadConfig())).toThrow(/defaultModel/);
    writeSettings('{ not json');
    expect(() => loadSettings(loadConfig())).toThrow(/not valid JSON/);
  });
});
