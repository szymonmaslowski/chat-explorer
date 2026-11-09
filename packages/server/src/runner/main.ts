import { loadConfig } from '../config.js';
import { loadSettings } from '../settings.js';
import { readMachineToken } from './machine-token.js';
import { startRunner } from './start.js';

// The runner as its own process. It reaches the backend only over HTTP with the machine token, so
// the backend can be the daemon next to it or, later, one in the cloud.
const config = loadConfig();
const settings = loadSettings(config);
const backendUrl = process.env.CHAT_EXPLORER_BACKEND_URL ?? config.baseUrl;
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

const runner = await startRunner({
  baseUrl: backendUrl,
  port: config.port,
  machineToken: readMachineToken(config.machineTokenPath),
  runnerPath: config.runnerPath,
  filesPath: config.filesPath,
  maxParallel: settings.runner.maxParallel,
  idleMinutes: settings.runner.idleMinutes,
  log,
});

const stop = async () => {
  await runner.stop();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
