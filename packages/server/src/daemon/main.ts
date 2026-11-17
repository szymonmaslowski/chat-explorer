import '@chat-explorer/shared/suppress-warnings.js';
import { mkdirSync } from 'node:fs';
import { loadSettings, runnerSettingsEnv, SettingsError } from '@chat-explorer/backend/settings.js';
import { startBackend } from '@chat-explorer/backend/server.js';
import { loadConfig } from '@chat-explorer/shared/config.js';
import { superviseRunner } from '../runner/supervisor.js';

// The daemon: the backend in this process, and the runner next to it when the settings enable it.
const config = loadConfig();
mkdirSync(config.home, { recursive: true });
const settings = loadSettingsOrExit();

let runner: ReturnType<typeof superviseRunner> | null = null;
const backend = startBackend({
  config,
  settings,
  onListening: () => {
    if (!settings.runner.enabled) return;
    runner = superviseRunner({
      logPath: config.runnerLogPath,
      env: {
        CHAT_EXPLORER_HOME: config.home,
        CHAT_EXPLORER_PORT: String(config.port),
        ...runnerSettingsEnv(settings),
      },
    });
  },
  beforeShutdown: async () => {
    await runner?.stop();
  },
});

process.on('SIGTERM', () => void backend.shutdown());
process.on('SIGINT', () => void backend.shutdown());

function loadSettingsOrExit() {
  try {
    return loadSettings(config);
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
