import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { capabilitiesReport } from './capabilities.js';
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
import { egressContainer, ensureEgress, toolsHost } from './egress.js';
import { removeLeftoverCredentials } from './credential-files.js';
import { codingMemory, codingNeedsBytes, MemoryGate } from './memory-gate.js';
import { Runner } from './runner.js';
import { runtime } from './container-runtime.js';
import { readRunnerConfig, type RunnerConfig } from './runner-config.js';

export interface StartRunnerOptions {
  baseUrl: string;
  port: number;
  toolsPort: number;
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

const loopbackNames = ['127.0.0.1', 'localhost', '[::1]'];

// Why coding forks must stay off on this runner even though its config allows them, or null.
// They rely on how the runtime handles mounts, networks and limits, tested only on Docker Desktop
// so far. And they run only for a backend on this machine: one elsewhere could be someone else's,
// so it needs enrolled devices first. The runner judges that itself, never the backend.
async function codingStaysOff(config: RunnerConfig, baseUrl: string) {
  if (!config.coding.enabled) return null;
  if (!config.localBackend) {
    return `Coding stays off: localBackend is false in ${config.path}, and coding forks need a backend on this machine until devices can enroll.`;
  }
  if (!loopbackNames.includes(new URL(baseUrl).hostname)) {
    return `Coding stays off: the backend at ${baseUrl} is not on this machine, and coding forks need one that is until devices can enroll.`;
  }
  const { name, supported } = await runtime.identify();
  if (!supported) {
    return `Coding stays off: it has been tested on Docker Desktop only, and this is ${name}.`;
  }
  return null;
}

// A runner on this machine, next to the daemon: its engine runs Claude Code in Docker at the
// version installed here.
// Where a container's engine calls the job tools: the daemon's tools listener, never its main port.
export const toolsUrl = (toolsPort: number) => `http://${toolsHost(toolsPort)}/api/tools/mcp`;

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
  await ensureEgress({ image, port: options.port, toolsPort: options.toolsPort, egressPath });
  const configured = readRunnerConfig(options.runnerPath);
  const codingOff = await codingStaysOff(configured, options.baseUrl);
  if (codingOff) options.log(codingOff);
  const config = codingOff
    ? { ...configured, coding: { ...configured.coding, enabled: false } }
    : configured;
  // Sized once: Docker Desktop's memory changes only with a restart of its VM.
  const sizing = codingMemory(config.coding.memory, await runtime.memoryBytes());
  const codingLimits = { ...config.coding, memory: sizing.memory };
  const client = new RunnerClient(options.baseUrl, options.machineToken);
  const capabilities = capabilitiesReport(configured, sizing, codingOff ?? sizing.refusal);
  const reportCapabilities = () =>
    client
      .capabilities(capabilities)
      .catch((error: Error) => options.log(`Runner: ${error.message}`));
  const memoryGate = new MemoryGate(
    sizing,
    () => runtime.availableMemoryBytes(egressContainer(options.port)),
    () => void reportCapacity(),
  );
  const reportCapacity = async () => {
    const capacity = config.coding.enabled
      ? {
          memory: sizing.memory,
          availableBytes: await memoryGate.availableBytes(),
          neededBytes: codingNeedsBytes,
          forkIds: memoryGate.forkIds,
        }
      : null;
    await client
      .capacity(capacity)
      .catch((error: Error) => options.log(`Runner: ${error.message}`));
  };
  // Repeated, so the page sees memory as it frees, and the backend stops counting a runner that
  // went away.
  setInterval(() => void reportCapacity(), 15_000).unref();
  setInterval(() => void reportCapabilities(), 30_000).unref();
  void reportCapacity();
  void reportCapabilities();
  const enginePaths = {
    forksPath: join(options.runnerPath, 'forks'),
    filesPath: options.filesPath,
    workspacesPath: options.workspacesPath,
    egressPath,
  };
  removeLeftoverCredentials(
    enginePaths.forksPath,
    (forkId) => forkFolders(enginePaths, { forkId, explorationId: '', coding: false }).credentials,
  );
  const runner = new Runner({
    client,
    config,
    engine: claudeCodeEngine({
      ...enginePaths,
      image: () => currentImage,
      port: options.port,
      toolsPort: options.toolsPort,
      codingLimits,
      oauthToken: () => readClaudeToken(options.runnerPath),
    }),
    runnerId: `${hostname()}-${process.pid}`,
    toolsUrl: toolsUrl(options.toolsPort),
    maxParallel: options.maxParallel,
    memoryGate,
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
  const coding = sizing.refusal
    ? `allowed, but ${sizing.refusal}`
    : `allowed (up to ${sizing.memory} memory each, started while Docker has memory free; ${config.coding.processes} processes, ${config.coding.cpus ?? 'all'} CPUs)`;
  options.log(`Runner started with ${image}, coding ${config.coding.enabled ? coding : 'off'}.`);
  return runner;
}
