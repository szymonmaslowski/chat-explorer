import { homedir } from 'node:os';
import { join } from 'node:path';

export const apiVersion = 1;
export const defaultPort = 4517;

export function loadConfig() {
  const port = Number(process.env.CHAT_EXPLORER_PORT ?? defaultPort);
  const home = process.env.CHAT_EXPLORER_HOME ?? join(homedir(), '.chat-explorer');
  return {
    port,
    home,
    databasePath: join(home, 'chat-explorer.db'),
    logPath: join(home, 'daemon.log'),
    settingsPath: join(home, 'config.json'),
    sessionsPath: join(home, 'sessions'),
    baseUrl: `http://127.0.0.1:${port}`,
  };
}

export type Config = ReturnType<typeof loadConfig>;
