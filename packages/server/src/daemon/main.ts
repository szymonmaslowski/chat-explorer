import '../suppress-warnings.js';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import { createApp } from '../api/app.js';
import { loadConfig } from '../config.js';
import { Database } from '../db/database.js';
import { EventBus } from '../store/event-bus.js';
import { FeedbackHub } from '../store/feedback-hub.js';
import { ChatStore } from '../store/store.js';
import { packageVersion } from '../version.js';

export const portInUseExitCode = 3;

const config = loadConfig();
mkdirSync(config.home, { recursive: true });

const database = new Database(config.databasePath);
const bus = new EventBus();
const store = new ChatStore(database, bus);
const hub = new FeedbackHub(store, bus);

const shutdown = () => {
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
  port: config.port,
  version: packageVersion,
  uiDirectory: fileURLToPath(new URL('../ui', import.meta.url)),
  onShutdown: shutdown,
});

const server = createServer(getRequestListener(app.fetch));

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EADDRINUSE') throw error;
  console.error(`Port ${config.port} is already in use.`);
  database.close();
  process.exit(portInUseExitCode);
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(
    `chat-explorer ${packageVersion} listening on ${config.baseUrl} (pid ${process.pid})`,
  );
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
