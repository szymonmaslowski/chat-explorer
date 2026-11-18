import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AccessConfigError,
  checkOwnedFile,
  readAccessConfig,
  type AccessConfig,
} from './access-config.js';
import { runnerKnowsHostKey } from './credential-files.js';
import type { DiskLimits } from './disk-guard.js';

// What a coding fork's container may use, in Docker's own units.
export interface ContainerLimits {
  // As `docker run --memory` takes it: a number with m or g, such as 4g.
  memory: string;
  processes: number;
  // Left out, the container may use every CPU Docker has, shared with the others when they're busy.
  cpus?: number;
}

// The runner's own limits, set on this machine. The backend can ask for less, never for more.
export interface RunnerConfig {
  // Where it was read from, to name in messages.
  path: string;
  // Left out, memory is sized from Docker's when the runner starts.
  coding: { enabled: boolean; memory?: string } & Omit<ContainerLimits, 'memory'> &
    DiskLimits &
    AccessConfig;
  // The backend runs on this machine. Coding forks run only then, and only if its address is
  // loopback too: a backend elsewhere needs enrolled devices first.
  localBackend: boolean;
}

export const defaultCodingLimits: Omit<ContainerLimits, 'memory'> & DiskLimits = {
  processes: 512,
  workspaceLimitGb: 10,
  minFreeGb: 10,
};

const memoryPattern = /^[1-9]\d*[mg]$/;

export const runnerConfigPath = (runnerPath: string) => join(runnerPath, 'config.json');

export class RunnerConfigError extends Error {}

interface RunnerConfigFile {
  localBackend?: unknown;
  coding?: {
    allowedHosts?: unknown;
    credentials?: unknown;
    enabled?: unknown;
    memory?: unknown;
    processes?: unknown;
    cpus?: unknown;
    workspaceLimitGb?: unknown;
    minFreeGb?: unknown;
  };
}

export function readRunnerConfig(runnerPath: string): RunnerConfig {
  const path = runnerConfigPath(runnerPath);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {
      path,
      coding: { enabled: false, ...defaultCodingLimits, allowedHosts: null, credentials: [] },
      localBackend: true,
    };
  }
  try {
    checkOwnedFile(path, "The runner's config", { secret: false });
  } catch (error) {
    throw new RunnerConfigError((error as Error).message);
  }
  let parsed: RunnerConfigFile;
  try {
    parsed = JSON.parse(text) as RunnerConfigFile;
  } catch {
    throw new RunnerConfigError(`${path} is not valid JSON.`);
  }
  const enabled = parsed.coding?.enabled ?? false;
  if (typeof enabled !== 'boolean') {
    throw new RunnerConfigError(`coding.enabled in ${path} must be true or false.`);
  }
  const memory = parsed.coding?.memory;
  if (memory !== undefined && (typeof memory !== 'string' || !memoryPattern.test(memory))) {
    throw new RunnerConfigError(`coding.memory in ${path} must be a size such as "4g" or "512m".`);
  }
  const processes = parsed.coding?.processes ?? defaultCodingLimits.processes;
  if (typeof processes !== 'number' || !Number.isInteger(processes) || processes < 1) {
    throw new RunnerConfigError(`coding.processes in ${path} must be a whole number above 0.`);
  }
  const cpus = parsed.coding?.cpus;
  if (cpus !== undefined && (typeof cpus !== 'number' || !(cpus > 0) || !Number.isFinite(cpus))) {
    throw new RunnerConfigError(
      `coding.cpus in ${path} must be a number above 0, such as 4 or 1.5.`,
    );
  }
  const localBackend = parsed.localBackend ?? true;
  if (typeof localBackend !== 'boolean') {
    throw new RunnerConfigError(`localBackend in ${path} must be true or false.`);
  }
  let access: AccessConfig;
  try {
    access = readAccessConfig(parsed.coding, path, runnerKnowsHostKey);
  } catch (error) {
    if (error instanceof AccessConfigError) throw new RunnerConfigError(error.message);
    throw error;
  }
  const gigabytes = (name: keyof DiskLimits) => {
    const value = parsed.coding?.[name] ?? defaultCodingLimits[name];
    if (typeof value !== 'number' || !(value > 0) || !Number.isFinite(value)) {
      throw new RunnerConfigError(
        `coding.${name} in ${path} must be a number of gigabytes above 0.`,
      );
    }
    return value;
  };
  return {
    path,
    coding: {
      enabled,
      ...(memory === undefined ? {} : { memory }),
      processes,
      ...(cpus === undefined ? {} : { cpus }),
      workspaceLimitGb: gigabytes('workspaceLimitGb'),
      minFreeGb: gigabytes('minFreeGb'),
      ...access,
    },
    localBackend,
  };
}
