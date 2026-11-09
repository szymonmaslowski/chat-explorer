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
import { FileStorage } from '../files/file-storage.js';
import { findTranscript } from '../import/transcript.js';
import { BackgroundSessions } from '../sessions/background-sessions.js';
import { claudeLauncher } from '../sessions/launch-claude.js';
import { loadSettings, SettingsError } from '../settings.js';
import { chatterboxEngine } from '../speech/chatterbox.js';
import { inspectSpeech, sayEngine } from '../speech/macos.js';
import { Speaker } from '../speech/speaker.js';
import { SpeechCache } from '../speech/speech-cache.js';
import { Database } from '../db/database.js';
import { EventBus } from '../store/event-bus.js';
import { FeedbackHub } from '../store/feedback-hub.js';
import { RunStore } from '../store/runs.js';
import { ChatStore } from '../store/store.js';
import { ensureMachineToken } from '../runner/machine-token.js';
import { superviseRunner } from '../runner/supervisor.js';
import { packageVersion } from '../version.js';
import { probe } from './control.js';

export const portInUseExitCode = 3;

const config = loadConfig();
mkdirSync(config.home, { recursive: true });
const settings = loadSettingsOrExit();

const database = new Database(config.databasePath);
const bus = new EventBus();
const store = new ChatStore(database, bus);
const runs = new RunStore(database, bus, store);
const sessions = new BackgroundSessions({
  store,
  bus,
  settings,
  sessionsPath: config.sessionsPath,
  launch: claudeLauncher(config),
  canResume: (sessionId) => findTranscript(sessionId) !== null,
  onStatusChange: (explorationId) => hub.refreshStatus(explorationId),
  autoStart: !settings.runner.enabled,
});
const machineToken = ensureMachineToken(config.machineTokenPath);
let runner: ReturnType<typeof superviseRunner> | null = null;
const hub = new FeedbackHub(store, bus, Date.now, sessions, settings.runner.enabled ? runs : null);
const modelPath = whisperModelPath(config.modelsPath, settings.dictation.model);
const transcriber = new Transcriber({
  language: settings.dictation.language,
  checkAvailability: () => dictationAvailability(modelPath),
  run: runWhisper,
});
const fileStorage = new FileStorage(store, config.filesPath);
const staleDraftSweepMs = 60 * 60 * 1000;
void fileStorage.removeStaleDrafts();
setInterval(() => void fileStorage.removeStaleDrafts(), staleDraftSweepMs).unref();
const chatterbox = chatterboxEngine(config.speechPath);
const speaker = new Speaker({
  engines: settings.speech.engine === 'say' ? [sayEngine()] : [chatterbox, sayEngine()],
  inspect: inspectSpeech,
  cache: new SpeechCache(config.speechCachePath, settings.speech.cacheMegabytes * 1024 * 1024),
});
bus.subscribe((_explorationId, event) => {
  if (event.type !== 'message.added') return;
  const { message } = event;
  if (message.role === 'assistant' && message.source === 'live') {
    void speaker.prepare(message.id, message.content);
  }
});

const shutdown = async () => {
  await runner?.stop();
  sessions.stopAll();
  chatterbox.stop();
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
  runs,
  machineToken,
  transcriber,
  speaker,
  fileStorage,
  defaultModel: settings.defaultModel,
  port: config.port,
  publicUrl: settings.publicUrl,
  version: packageVersion,
  uiDirectory: fileURLToPath(new URL('../ui', import.meta.url)),
  onShutdown: () => void shutdown(),
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
  if (!settings.runner.enabled) return;
  runner = superviseRunner({
    logPath: config.runnerLogPath,
    env: { CHAT_EXPLORER_HOME: config.home, CHAT_EXPLORER_PORT: String(config.port) },
  });
});

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

function loadSettingsOrExit() {
  try {
    return loadSettings(config);
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
