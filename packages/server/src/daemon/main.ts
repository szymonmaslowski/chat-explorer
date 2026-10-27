import '../suppress-warnings.js';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import { createApp } from '../api/app.js';
import { loadConfig } from '../config.js';
import { dictationAvailability } from '../dictation/availability.js';
import { whisperModelPath } from '../dictation/models.js';
import { Transcriber } from '../dictation/transcriber.js';
import { runWhisper } from '../dictation/whisper.js';
import { findTranscript } from '../import/transcript.js';
import { BackgroundSessions } from '../sessions/background-sessions.js';
import { claudeLauncher } from '../sessions/launch-claude.js';
import { loadSettings, SettingsError } from '../settings.js';
import { Database } from '../db/database.js';
import { EventBus } from '../store/event-bus.js';
import { FeedbackHub } from '../store/feedback-hub.js';
import { ChatStore } from '../store/store.js';
import { packageVersion } from '../version.js';
import { probe } from './control.js';

export const portInUseExitCode = 3;

const config = loadConfig();
mkdirSync(config.home, { recursive: true });
const settings = loadSettingsOrExit();

const database = new Database(config.databasePath);
const bus = new EventBus();
const store = new ChatStore(database, bus);
const sessions = new BackgroundSessions({
  store,
  bus,
  settings,
  sessionsPath: config.sessionsPath,
  launch: claudeLauncher(config),
  canResume: (sessionId) => findTranscript(sessionId) !== null,
  onStatusChange: (explorationId) => hub.refreshStatus(explorationId),
});
const hub = new FeedbackHub(store, bus, Date.now, sessions);
const modelPath = whisperModelPath(config.modelsPath, settings.dictation.model);
const transcriber = new Transcriber({
  language: settings.dictation.language,
  checkAvailability: () => dictationAvailability(modelPath),
  run: runWhisper,
});

const shutdown = () => {
  sessions.stopAll();
  hub.stop();
  server.close();
  server.closeAllConnections();
  database.close();
  process.exit(0);
};

const app = createApp({
  store,
  hub,
  bus,
  sessions,
  transcriber,
  defaultModel: settings.defaultModel,
  port: config.port,
  publicUrl: settings.publicUrl,
  version: packageVersion,
  uiDirectory: fileURLToPath(new URL('../ui', import.meta.url)),
  onShutdown: shutdown,
});

const server = createServer(getRequestListener(app.fetch));

// Exiting with 0 when another chat-explorer daemon holds the port stops launchd from retrying.
server.on('error', async (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EADDRINUSE') throw error;
  database.close();
  if ((await probe(config.baseUrl)).state === 'running') {
    console.log(`chat-explorer is already running on port ${config.port}.`);
    process.exit(0);
  }
  console.error(`Port ${config.port} is already in use.`);
  process.exit(portInUseExitCode);
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(
    `chat-explorer ${packageVersion} listening on ${config.baseUrl} (pid ${process.pid})`,
  );
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function loadSettingsOrExit() {
  try {
    return loadSettings(config);
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
