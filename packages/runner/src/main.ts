import { loadConfig } from '@chat-explorer/shared/config.js';
import { readMachineToken } from '@chat-explorer/shared/machine-token.js';
import { startRunner } from './start.js';

// The runner as its own process. It reaches the backend only over HTTP with the machine token, so
// the backend can be the daemon next to it or, later, one in the cloud.
const config = loadConfig();
const backendUrl = process.env.CHAT_EXPLORER_BACKEND_URL ?? config.baseUrl;
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

const runner = await startRunner({
  baseUrl: backendUrl,
  port: config.port,
  machineToken: readMachineToken(config.machineTokenPath),
  runnerPath: config.runnerPath,
  filesPath: config.filesPath,
  workspacesPath: config.workspacesPath,
  maxParallel: runnerSetting('CHAT_EXPLORER_RUNNER_MAX_PARALLEL'),
  idleMinutes: runnerSetting('CHAT_EXPLORER_RUNNER_IDLE_MINUTES'),
  log,
});

// The daemon reads the settings file and passes the runner its part when it starts it.
function runnerSetting(name: string) {
  const value = Number(process.env[name]);
  if (!(value > 0)) throw new Error(`${name} is not set: start the runner through the daemon.`);
  return value;
}

const stop = async () => {
  await runner.stop();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
