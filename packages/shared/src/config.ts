import { homedir } from 'node:os';
import { join } from 'node:path';

export const apiVersion = 1;
export const defaultPort = 4517;

export class ConfigError extends Error {}

const isPort = (value: number) => Number.isInteger(value) && value >= 1 && value <= 65_535;

// Refused at once with the reason, rather than as a daemon that can't listen.
function readToolsPort(value: string | undefined, port: number) {
  if (value === undefined || value === '') return port + 1;
  const toolsPort = Number(value);
  if (!/^\d+$/.test(value.trim()) || !isPort(toolsPort)) {
    throw new ConfigError(
      `CHAT_EXPLORER_TOOLS_PORT is ${JSON.stringify(value)}: it must be a port number from 1 to 65535.`,
    );
  }
  if (toolsPort === port) {
    throw new ConfigError(
      `CHAT_EXPLORER_TOOLS_PORT is ${toolsPort}, the daemon's main port: the tools need a port of their own.`,
    );
  }
  return toolsPort;
}

export function loadConfig() {
  const port = Number(process.env.CHAT_EXPLORER_PORT ?? defaultPort);
  // Coding containers reach the daemon only here, where nothing but the job tools is served.
  const toolsPort = readToolsPort(process.env.CHAT_EXPLORER_TOOLS_PORT, port);
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
