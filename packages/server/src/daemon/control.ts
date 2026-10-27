import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.js';

interface Health {
  name: 'chat-explorer';
  version: string;
  apiVersion: number;
  pid: number;
}

type Probe = { state: 'running'; health: Health } | { state: 'stopped' } | { state: 'foreign' };

export interface DaemonTarget {
  version: string;
  apiVersion: number;
  daemonEntry?: string;
}

const startTimeoutMs = 5_000;
const pollIntervalMs = 100;
export const defaultDaemonEntry = fileURLToPath(new URL('./main.js', import.meta.url));

export class DaemonStartError extends Error {}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function probe(baseUrl: string): Promise<Probe> {
  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
    const body: Partial<Health> = await response.json();
    return body.name === 'chat-explorer'
      ? { state: 'running', health: body as Health }
      : { state: 'foreign' };
  } catch (error) {
    return isConnectionRefused(error) ? { state: 'stopped' } : { state: 'foreign' };
  }
}

export function compareVersions(left: string, right: string) {
  const [leftCore = '', leftPrerelease] = left.split('-', 2);
  const [rightCore = '', rightPrerelease] = right.split('-', 2);
  const leftParts = leftCore.split('.').map(Number);
  const rightParts = rightCore.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (leftPrerelease === rightPrerelease) return 0;
  if (leftPrerelease === undefined) return 1;
  if (rightPrerelease === undefined) return -1;
  return leftPrerelease < rightPrerelease ? -1 : 1;
}

export async function ensureDaemon(config: Config, target: DaemonTarget) {
  const current = await probe(config.baseUrl);
  if (current.state === 'foreign') throw portTakenError(config);
  if (current.state === 'running') {
    const order = compareVersions(current.health.version, target.version);
    if (order === 0) return { health: current.health, started: false };
    if (order > 0) {
      if (current.health.apiVersion === target.apiVersion) {
        return { health: current.health, started: false };
      }
      throw new DaemonStartError(
        `chat-explorer was upgraded to ${current.health.version}: restart this Claude session.`,
      );
    }
    await stopDaemon(config);
  }
  spawnDaemon(config, target.daemonEntry ?? defaultDaemonEntry);
  return { health: await waitForHealth(config), started: true };
}

export async function stopDaemon(config: Config) {
  const current = await probe(config.baseUrl);
  if (current.state !== 'running') return false;
  await fetch(`${config.baseUrl}/api/shutdown`, { method: 'POST' });
  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    if ((await probe(config.baseUrl)).state === 'stopped') return true;
    await sleep(pollIntervalMs);
  }
  throw new DaemonStartError(`The daemon on port ${config.port} did not stop.`);
}

function spawnDaemon(config: Config, daemonEntry: string) {
  mkdirSync(config.home, { recursive: true });
  const log = openSync(config.logPath, 'a');
  const child = spawn(process.execPath, [daemonEntry], {
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      CHAT_EXPLORER_PORT: String(config.port),
      CHAT_EXPLORER_HOME: config.home,
    },
  });
  child.unref();
}

export async function waitForHealth(config: Config) {
  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    const current = await probe(config.baseUrl);
    if (current.state === 'running') return current.health;
    await sleep(pollIntervalMs);
  }
  throw new DaemonStartError(
    `The daemon did not start within ${startTimeoutMs / 1000} s. See ${config.logPath}.`,
  );
}

function portTakenError(config: Config) {
  return new DaemonStartError(
    `Port ${config.port} is used by another program. Set CHAT_EXPLORER_PORT to use a different port.`,
  );
}

function isConnectionRefused(error: unknown) {
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof Error && 'code' in cause && cause.code === 'ECONNREFUSED';
}
