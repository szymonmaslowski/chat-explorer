import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeCodeEngine } from './claude-engine.js';
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
import { readRunnerConfig } from './runner-config.js';

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
  await ensureEgress(image, options.port);
  const config = readRunnerConfig(options.runnerPath);
  const runner = new Runner({
    client: new RunnerClient(options.baseUrl, options.machineToken),
    config,
    engine: claudeCodeEngine({
      image: () => currentImage,
      port: options.port,
      forksPath: join(options.runnerPath, 'forks'),
      filesPath: options.filesPath,
      workspacesPath: options.workspacesPath,
      codingLimits: config.coding,
      oauthToken: () => readClaudeToken(options.runnerPath),
    }),
    runnerId: `${hostname()}-${process.pid}`,
    toolsUrl: `http://host.docker.internal:${options.port}/api/tools/mcp`,
    maxParallel: options.maxParallel,
    timings: { idleCloseMs: options.idleMinutes * 60_000 },
    onError: (error) => options.log(`Runner: ${error instanceof Error ? error.message : error}`),
  });
  runner.start();
  options.log(
    `Runner started with ${image}, coding ${config.coding.enabled ? `allowed (${config.coding.memory} memory, ${config.coding.processes} processes)` : 'off'}.`,
  );
  return runner;
}
