import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeCodeEngine } from './claude-engine.js';
import { ensureImage, installedClaudeVersion } from './claude-image.js';
import { RunnerClient } from './client.js';
import { ensureEgress } from './egress.js';
import { Runner } from './runner.js';

export interface StartRunnerOptions {
  baseUrl: string;
  port: number;
  machineToken: string;
  runnerPath: string;
  filesPath: string;
  maxParallel: number;
  idleMinutes: number;
  log: (message: string) => void;
}

// The token `claude setup-token` printed, as the user saved it; a terminal that wrapped the line
// leaves a line break inside it.
export const readClaudeToken = (runnerPath: string) =>
  readFileSync(join(runnerPath, 'claude-token'), 'utf8').replace(/\s+/g, '');

// A runner on this machine, next to the daemon: its engine runs Claude Code in Docker at the
// version installed here, building that image first when it is missing.
export async function startRunner(options: StartRunnerOptions) {
  const version = await installedClaudeVersion();
  if (!version) throw new Error('Claude Code is not installed, so the runner has no version.');
  options.log(`Preparing the Claude Code ${version} image…`);
  const image = await ensureImage(version);
  await ensureEgress(image, options.port);
  const runner = new Runner({
    client: new RunnerClient(options.baseUrl, options.machineToken),
    engine: claudeCodeEngine({
      image,
      forksPath: join(options.runnerPath, 'forks'),
      filesPath: options.filesPath,
      oauthToken: () => readClaudeToken(options.runnerPath),
    }),
    runnerId: `${hostname()}-${process.pid}`,
    toolsUrl: `http://host.docker.internal:${options.port}/api/tools/mcp`,
    maxParallel: options.maxParallel,
    timings: { idleCloseMs: options.idleMinutes * 60_000 },
    onError: (error) => options.log(`Runner: ${error instanceof Error ? error.message : error}`),
  });
  runner.start();
  options.log(`Runner started with ${image}.`);
  return runner;
}
