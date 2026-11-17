import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The runner's own limits, set on this machine. The backend can ask for less, never for more.
export interface RunnerConfig {
  // Where it was read from, to name in messages.
  path: string;
  coding: { enabled: boolean };
}

export const runnerConfigPath = (runnerPath: string) => join(runnerPath, 'config.json');

export class RunnerConfigError extends Error {}

export function readRunnerConfig(runnerPath: string): RunnerConfig {
  const path = runnerConfigPath(runnerPath);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { path, coding: { enabled: false } };
  }
  let parsed: { coding?: { enabled?: unknown } };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new RunnerConfigError(`${path} is not valid JSON.`);
  }
  const enabled = parsed.coding?.enabled ?? false;
  if (typeof enabled !== 'boolean') {
    throw new RunnerConfigError(`coding.enabled in ${path} must be true or false.`);
  }
  return { path, coding: { enabled } };
}
