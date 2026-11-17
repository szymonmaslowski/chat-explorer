import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseClaudeStreamLine, streamUserMessage } from './claude-stream.js';
import { randomBytes } from 'node:crypto';
import { runtime } from './container-runtime.js';
import { openEgressPass, sandboxArguments, writeModelToken } from './egress.js';
import type { Engine, EngineEvent, EngineRun, EngineRunSpec } from './engine.js';
import type { ContainerLimits } from './runner-config.js';

export interface ClaudeEnginePaths {
  // Per fork: its working folder and its Claude Code sessions, kept between containers.
  forksPath: string;
  // A coding fork works in its own folder here instead, per chat and fork.
  workspacesPath: string;
  // Uploads, readable by the engine at the same path as on the host.
  filesPath: string;
  // The egress proxy's policies and logs.
  egressPath: string;
}

export interface ClaudeEngineOptions extends ClaudeEnginePaths {
  // Read for each container, so runs move to a newer image once it is built.
  image: () => string;
  // The daemon's port, which names the egress proxy the engine goes out through.
  port: number;
  // From the runner's config: a coding fork's container gets these instead of the chat limits.
  codingLimits: ContainerLimits;
  oauthToken: () => string;
}

const containerHome = '/home/agent';
const mcpServerName = 'chat';
// `claude -p` ignores SIGTERM at times, so a stop that is not answered escalates.
const killAfterMs = 5_000;

export const containerName = (forkId: string) => `chat-explorer-run-${forkId}`;

// The session folder stays under the runner's folder for every fork, outside any workspace, so the
// agent cannot reach it through a workspace mount or an editor.
export const forkFolders = (
  paths: ClaudeEnginePaths,
  spec: Pick<EngineRunSpec, 'forkId' | 'explorationId' | 'coding'>,
) => ({
  work: spec.coding
    ? join(paths.workspacesPath, spec.explorationId, spec.forkId)
    : join(paths.forksPath, spec.forkId, 'work'),
  sessions: join(paths.forksPath, spec.forkId, 'claude-projects'),
});

const chatLimits: ContainerLimits = { memory: '2g', processes: 256, cpus: 2 };

type ContainerOptions = Omit<ClaudeEngineOptions, 'oauthToken'>;

// The one `docker run` template: only these flags, filled from checked values. Nothing from a job
// is passed through as a flag. The work folder appears at the same absolute path inside, so Claude
// Code files the session under the project name it would use on the host.
export function containerArguments(spec: EngineRunSpec, options: ContainerOptions) {
  const folders = forkFolders(options, spec);
  const limits = spec.coding ? options.codingLimits : chatLimits;
  return [
    'run',
    '--interactive',
    '--rm',
    '--name',
    containerName(spec.forkId),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    String(limits.processes),
    '--memory',
    limits.memory,
    ...(limits.cpus === undefined ? [] : ['--cpus', String(limits.cpus)]),
    '--env',
    'DISABLE_AUTOUPDATER=1',
    ...sandboxArguments(),
    // Node's own fetch ignores the proxy settings without this, so scripts Claude writes would fail.
    ...(spec.coding ? ['--env', 'NODE_USE_ENV_PROXY=1'] : []),
    '--volume',
    `${folders.work}:${folders.work}`,
    '--workdir',
    folders.work,
    '--volume',
    `${folders.sessions}:${containerHome}/.claude/projects`,
    '--volume',
    `${options.filesPath}:${options.filesPath}:ro`,
    options.image(),
  ];
}

const chatTools = ['WebSearch', 'Read'];
const codingTools = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'TodoWrite'];

const codingPrompt = (workspace: string, hosts: string[]) => `

This fork is a coding fork. You run in a Linux container with Bash and file tools. Your workspace is ${workspace}: a real folder on the user's computer, kept between sessions, and the only folder that is. Work there: clone repositories into it or start projects in it, several side by side if needed.

The network goes out only through a proxy, over HTTPS, to the hosts the user allowed for this fork. At the start of this session those were: ${hosts.length > 0 ? hosts.join(', ') : 'none'}. A connection the proxy refuses fails with a 403 or "Blocked by the sandbox". When you need a host that isn't allowed, tell the user which host:port to add under the fork's allowed hosts in Chat settings. Don't try to get around the proxy.`;

function claudeArguments(spec: EngineRunSpec, options: ContainerOptions) {
  const mcpConfig = {
    mcpServers: {
      [mcpServerName]: {
        type: 'http',
        url: spec.toolsUrl,
        headers: { Authorization: `Bearer ${spec.toolsToken}` },
      },
    },
  };
  const tools = spec.coding ? codingTools : chatTools;
  const allowedTools = spec.coding
    ? [...codingTools, `mcp__${mcpServerName}`]
    : ['WebSearch', `Read(/${options.filesPath}/**)`, `mcp__${mcpServerName}`];
  return [
    'claude',
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    spec.model,
    spec.resume ? '--resume' : '--session-id',
    spec.sessionId,
    '--tools',
    tools.join(','),
    '--allowedTools',
    ...allowedTools,
    '--mcp-config',
    JSON.stringify(mcpConfig),
    '--strict-mcp-config',
    '--permission-prompts',
    'none',
    '--append-system-prompt',
    spec.coding
      ? spec.systemPrompt + codingPrompt(forkFolders(options, spec).work, spec.hosts)
      : spec.systemPrompt,
  ];
}

export const claudeDockerArguments = (spec: EngineRunSpec, options: ContainerOptions) => [
  ...containerArguments(spec, options),
  ...claudeArguments(spec, options),
];

// The model for small jobs, cheap and quick.
const completionModel = 'haiku';

export const claudeCompletionArguments = (prompt: string, image: string) => [
  'run',
  '--rm',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
  ...sandboxArguments(),
  image,
  'claude',
  '-p',
  prompt,
  '--model',
  completionModel,
  '--tools',
  '',
  '--output-format',
  'json',
];

export function claudeCodeEngine(options: ClaudeEngineOptions): Engine {
  return {
    complete(prompt) {
      return new Promise((resolve, reject) => {
        writeModelToken(options.egressPath, options.oauthToken());
        const pass = openEgressPass(
          options.egressPath,
          options.port,
          `completion-${randomBytes(6).toString('hex')}`,
          [],
        );
        const child = runtime.start(claudeCompletionArguments(prompt, options.image()), {
          ...process.env,
          ...pass.environment,
        });
        child.stdin.end();
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
        child.on('error', (error) => {
          pass.close();
          reject(error);
        });
        child.on('exit', () => {
          pass.close();
          try {
            const result = JSON.parse(output) as { result?: string; is_error?: boolean };
            if (result.is_error || !result.result) throw new Error(result.result ?? 'No answer.');
            resolve(result.result.trim());
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });
    },
    start(spec) {
      const folders = forkFolders(options, spec);
      mkdirSync(folders.work, { recursive: true });
      mkdirSync(folders.sessions, { recursive: true });
      writeModelToken(options.egressPath, options.oauthToken());
      const pass = openEgressPass(options.egressPath, options.port, spec.forkId, spec.hosts);
      const child = runtime.start(claudeDockerArguments(spec, options), {
        ...process.env,
        ...pass.environment,
      });
      child.on('error', () => pass.close());
      child.on('exit', () => pass.close());
      const eventListeners: ((event: EngineEvent) => void)[] = [];
      let errorOutput = '';
      createInterface({ input: child.stdout }).on('line', (line) => {
        for (const event of parseClaudeStreamLine(line)) {
          for (const listener of eventListeners) listener(event);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        errorOutput = (errorOutput + chunk.toString()).slice(-4_000);
      });
      const run: EngineRun = {
        send: (text) => child.stdin.write(streamUserMessage(text)),
        onEvent: (listener) => eventListeners.push(listener),
        onExit: (listener) => {
          let reported = false;
          const report = (result: { code: number | null; error?: string }) => {
            if (reported) return;
            reported = true;
            listener(result);
          };
          child.on('error', (error) => report({ code: null, error: error.message }));
          child.on('exit', (code) =>
            report(code === 0 ? { code } : { code, error: errorOutput.trim() || undefined }),
          );
        },
        allowHosts: (hosts) => pass.allow(hosts),
        stop: (stopOptions) => {
          if (stopOptions?.immediately) {
            child.kill('SIGKILL');
            runtime.kill(containerName(spec.forkId));
            return;
          }
          child.stdin.end();
          setTimeout(() => {
            if (child.exitCode === null) run.stop({ immediately: true });
          }, killAfterMs).unref();
        },
      };
      return run;
    },
  };
}
