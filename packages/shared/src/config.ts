import { homedir } from 'node:os';
import { join } from 'node:path';

export const apiVersion = 1;
export const defaultPort = 4517;

export function loadConfig() {
  const port = Number(process.env.CHAT_EXPLORER_PORT ?? defaultPort);
  // Coding containers reach the daemon only here, where nothing but the job tools is served.
  const toolsPort = Number(process.env.CHAT_EXPLORER_TOOLS_PORT ?? port + 1);
  const home = process.env.CHAT_EXPLORER_HOME ?? join(homedir(), '.chat-explorer');
  return {
    port,
    toolsPort,
    home,
    databasePath: join(home, 'chat-explorer.db'),
    logPath: join(home, 'daemon.log'),
    settingsPath: join(home, 'config.json'),
    modelsPath: join(home, 'models'),
    filesPath: join(home, 'files'),
    // A coding fork's project, per chat and fork: real files the user can open.
    workspacesPath: join(home, 'workspaces'),
    speechPath: join(home, 'speech'),
    speechCachePath: join(home, 'speech-cache'),
    runnerPath: join(home, 'runner'),
    machineTokenPath: join(home, 'runner', 'machine-token'),
    runnerLogPath: join(home, 'runner.log'),
    baseUrl: `http://127.0.0.1:${port}`,
  };
}

export type Config = ReturnType<typeof loadConfig>;
