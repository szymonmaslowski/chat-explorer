import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeCodeEngine, containerName, forkFolders } from './claude-engine.js';
import { diskGuard } from './disk-guard.js';
import {
  buildImage,
  hasImage,
  imageTag,
  installedClaudeVersion,
  newestBuiltImage,
} from './claude-image.js';
import { RunnerClient } from './client.js';
import { ensureEgress } from './egress.js';
import { Runner } from './runner.js';
import { runtime } from './container-runtime.js';
import { readRunnerConfig, type RunnerConfig } from './runner-config.js';

export interface StartRunnerOptions {
  baseUrl: string;
  port: number;
  machineToken: string;
  runnerPath: string;
  filesPath: string;
  workspacesPath: string;
  maxParallel: number;
  idleMinutes: number;
  log: (message: string) => void;
}

// The token `claude setup-token` printed, as the user saved it; a terminal that wrapped the line
// leaves a line break inside it.
export const readClaudeToken = (runnerPath: string) =>
  readFileSync(join(runnerPath, 'claude-token'), 'utf8').replace(/\s+/g, '');

// The image to start with: the installed version's, or else the newest one built earlier while
// the new one builds, so a new Claude Code version never holds up the chats.
async function startingImage(version: string, log: (message: string) => void) {
  if (await hasImage(version)) return { image: imageTag(version), newImage: null };
  const builtEarlier = await newestBuiltImage();
  if (!builtEarlier) {
    log(`Building the Claude Code ${version} image…`);
    return { image: await buildImage(version), newImage: null };
  }
  log(`Building the Claude Code ${version} image; runs use ${builtEarlier} until it is ready.`);
  return { image: builtEarlier, newImage: buildImage(version) };
}

// Coding forks rely on how the runtime handles mounts, networks and limits, tested only on Docker
// Desktop so far. On another runtime chat forks still run, and coding stays off until tested.
async function onTestedRuntime(config: RunnerConfig, log: (message: string) => void) {
  if (!config.coding.enabled) return config;
  const { name, supported } = await runtime.identify();
  if (supported) return config;
  log(`Coding stays off: it has been tested on Docker Desktop only, and this is ${name}.`);
  return { ...config, coding: { ...config.coding, enabled: false } };
}

// A runner on this machine, next to the daemon: its engine runs Claude Code in Docker at the
// version installed here.
export async function startRunner(options: StartRunnerOptions) {
  const version = await installedClaudeVersion();
  if (!version) throw new Error('Claude Code is not installed, so the runner has no version.');
  const { image, newImage } = await startingImage(version, options.log);
  let currentImage = image;
  newImage?.then(
    (built) => {
      currentImage = built;
      options.log(`Runs now use ${built}.`);
    },
    (error: Error) => options.log(error.message),
  );
  const egressPath = join(options.runnerPath, 'egress');
  await ensureEgress({ image, port: options.port, egressPath });
  const config = await onTestedRuntime(readRunnerConfig(options.runnerPath), options.log);
  const enginePaths = {
    forksPath: join(options.runnerPath, 'forks'),
    filesPath: options.filesPath,
    workspacesPath: options.workspacesPath,
    egressPath,
  };
  const runner = new Runner({
    client: new RunnerClient(options.baseUrl, options.machineToken),
    config,
    engine: claudeCodeEngine({
      ...enginePaths,
      image: () => currentImage,
      port: options.port,
      codingLimits: config.coding,
      oauthToken: () => readClaudeToken(options.runnerPath),
    }),
    runnerId: `${hostname()}-${process.pid}`,
    toolsUrl: `http://host.docker.internal:${options.port}/api/tools/mcp`,
    maxParallel: options.maxParallel,
    diskGuard: diskGuard({
      limits: config.coding,
      workspacesPath: options.workspacesPath,
      workspaceOf: (spec) => forkFolders(enginePaths, spec).work,
      containerFreeBytes: (spec) => runtime.freeBytes(containerName(spec.forkId)),
    }),
    timings: { idleCloseMs: options.idleMinutes * 60_000 },
    onError: (error) => options.log(`Runner: ${error instanceof Error ? error.message : error}`),
  });
  runner.start();
  options.log(
    `Runner started with ${image}, coding ${config.coding.enabled ? `allowed (${config.coding.memory} memory, ${config.coding.processes} processes, ${config.coding.cpus ?? 'all'} CPUs)` : 'off'}.`,
  );
  return runner;
}
