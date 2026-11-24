import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import type { Config } from '@chat-explorer/shared/config.js';
import { probe } from '@chat-explorer/shared/health.js';
import { ensureMachineToken } from '@chat-explorer/shared/machine-token.js';
import { packageVersion } from '@chat-explorer/shared/version.js';
import { createApp } from './api/app.js';
import { createToolsApp } from './api/tools-app.js';
import { Database } from './db/database.js';
import { dictationAvailability } from './dictation/availability.js';
import { whisperModelPath } from './dictation/models.js';
import { Transcriber } from './dictation/transcriber.js';
import { runWhisper } from './dictation/whisper.js';
import { FileStorage } from './files/file-storage.js';
import { prefixLegacyNames } from './legacy-names.js';
import type { Settings } from './settings.js';
import { chatterboxEngine } from './speech/chatterbox.js';
import { inspectSpeech, sayEngine } from './speech/macos.js';
import { Speaker } from './speech/speaker.js';
import { SpeechCache } from './speech/speech-cache.js';
import { EventBus } from './store/event-bus.js';
import { FeedbackHub } from './store/feedback-hub.js';
import { leaseMs, RunStore } from './store/runs.js';
import { ChatStore } from './store/store.js';

export const portInUseExitCode = 3;
// The tools port is taken; the main port may be free.
export const toolsPortInUseExitCode = 4;

// The backend in this process: the store, the API and the web UI on the configured port. The
// daemon around it adds the processes it supervises, such as the runner, through the two hooks.
export function startBackend(options: {
  config: Config;
  settings: Settings;
  onListening: () => void;
  beforeShutdown: () => Promise<void>;
}) {
  const { config, settings } = options;
  const database = new Database(config.databasePath);
  prefixLegacyNames(join(config.runnerPath, 'forks'), 'fork');
  const bus = new EventBus();
  const store = new ChatStore(database, bus);
  const runs = new RunStore(database, bus, store);
  const machineToken = ensureMachineToken(config.machineTokenPath);
  const hub = new FeedbackHub(
    store,
    bus,
    Date.now,
    settings.runner.enabled ? runs : null,
  );
  const modelPath = whisperModelPath(config.modelsPath, settings.dictation.model);
  const transcriber = new Transcriber({
    language: settings.dictation.language,
    checkAvailability: () => dictationAvailability(modelPath),
    run: runWhisper,
  });
  const fileStorage = new FileStorage(store, config.filesPath);
  const staleDraftSweepMs = 60 * 60 * 1000;
  void fileStorage.removeStaleDrafts();
  void fileStorage.addMissingImageSizes();
  // The change log keeps about three months; a device that was away longer loads its chats fresh.
  const changeLogMs = 90 * 24 * 60 * 60 * 1000;
  const pruneChanges = () => store.pruneChanges(Date.now() - changeLogMs);
  pruneChanges();
  setInterval(pruneChanges, staleDraftSweepMs).unref();
  setInterval(() => void fileStorage.removeStaleDrafts(), staleDraftSweepMs).unref();
  setInterval(() => runs.releaseStaleFollowUps(), leaseMs / 2).unref();
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
      void speaker.prepare(message.id, message.content, store.answeredPart);
    }
  });

  const shutdown = async () => {
    await options.beforeShutdown();
    chatterbox.stop();
    hub.stop();
    server.close();
    server.closeAllConnections();
    toolsServer.close();
    toolsServer.closeAllConnections();
    database.close();
    process.exit(0);
  };

  const app = createApp({
    store,
    hub,
    bus,
    runs,
    machineToken,
    transcriber,
    speaker,
    fileStorage,
    defaultModel: settings.defaultModel,
    port: config.port,
    publicUrl: settings.publicUrl,
    version: packageVersion,
    uiDirectory: fileURLToPath(new URL('./ui', import.meta.url)),
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

  // Coding containers reach only this one, through the egress proxy.
  const toolsServer = createServer(
    getRequestListener(createToolsApp({ store, runs, toolsPort: config.toolsPort }).fetch),
  );
  toolsServer.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EADDRINUSE') throw error;
    console.error(
      `The tools port ${config.toolsPort} is already in use. Set CHAT_EXPLORER_TOOLS_PORT to use a different port.`,
    );
    database.close();
    process.exit(toolsPortInUseExitCode);
  });
  toolsServer.listen(config.toolsPort, '127.0.0.1');

  server.listen(config.port, '127.0.0.1', () => {
    console.log(
      `chat-explorer ${packageVersion} listening on ${config.baseUrl} (pid ${process.pid})`,
    );
    options.onListening();
  });

  return { shutdown };
}
