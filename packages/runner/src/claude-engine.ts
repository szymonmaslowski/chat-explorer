import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseClaudeStreamLine, streamUserMessage } from './claude-stream.js';
import { randomBytes } from 'node:crypto';
import { runtime } from './container-runtime.js';
import {
  credentialsMount,
  removeCredentialFiles,
  writeCredentialFiles,
} from './credential-files.js';
import { keepEgressRunning, openEgressPass, sandboxArguments, writeModelToken } from './egress.js';
import {
  noHosts,
  type Engine,
  type EngineEvent,
  type EngineRun,
  type EngineRunSpec,
  type HostPolicy,
} from './engine.js';
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
  // Written for each coding container and removed when it ends.
  credentials: join(paths.forksPath, spec.forkId, 'credentials'),
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
    // When Docker runs out of memory anyway, its kernel ends a coding process before the proxy or a
    // chat fork.
    ...(spec.coding ? ['--oom-score-adj', '500'] : []),
    '--env',
    'DISABLE_AUTOUPDATER=1',
    ...sandboxArguments(),
    // Node's own fetch ignores the proxy settings without this, so scripts Claude writes would fail.
    ...(spec.coding
      ? [
          '--env',
          'NODE_USE_ENV_PROXY=1',
          '--env',
          `GIT_CONFIG_SYSTEM=${credentialsMount}/gitconfig`,
          '--volume',
          `${folders.credentials}:${credentialsMount}:ro`,
        ]
      : []),
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

function shownHosts(network: HostPolicy) {
  const hidden = network.hosts.filter((host) => network.hiddenHosts.includes(host)).length;
  const shown = network.hosts.filter((host) => !network.hiddenHosts.includes(host));
  const list = [...shown, ...(hidden > 0 ? [`${hidden} more the user keeps unnamed`] : [])];
  return list.length > 0 ? list.join(', ') : 'none';
}

function credentialsPrompt(spec: EngineRunSpec) {
  if (spec.credentials.length === 0) {
    return `No credentials were given to this fork, so only public repositories can be cloned. SSH still goes through the proxy: git uses ${credentialsMount}/ssh_config by itself, and plain ssh needs -F ${credentialsMount}/ssh_config.`;
  }
  const listed = spec.credentials.map((credential) => {
    const hosts = credential.hosts
      .filter((rule) => !rule.hidden)
      .map((rule) => rule.pattern)
      .join(', ');
    return `- ${credential.type === 'token' ? 'a token' : 'an SSH key'} for ${hosts || 'a host the user keeps unnamed'}`;
  });
  return `The user gave this fork these credentials:
${listed.join('\n')}
git uses them by itself: tokens over HTTPS through a credential helper, SSH keys through ${credentialsMount}/ssh_config, with host keys checked against ${credentialsMount}/known_hosts. Plain ssh needs -F ${credentialsMount}/ssh_config. Never print, copy or send a credential anywhere, and never turn off host key checking.`;
}

const codingPrompt = (workspace: string, spec: EngineRunSpec) => `

This fork is a coding fork. You run in a Linux container with Bash and file tools. Your workspace is ${workspace}: a real folder on the user's computer, kept between sessions, and the only folder that is. Work there: clone repositories into it or start projects in it, several side by side if needed.

The network goes out only through a proxy, over HTTPS or SSH, to the hosts the user allowed for this fork. At the start of this session those were: ${shownHosts(spec.network)}. A connection the proxy refuses fails with a 403 or "Blocked by the sandbox". When you need a host that isn't allowed, tell the user which host:port to add under the fork's allowed hosts in Chat settings. Don't try to get around the proxy.

The image has git, pnpm, Node, Python, make, g++ and Chromium. Run the e2e tests with CHAT_EXPLORER_CHROME already set (the Playwright config reads it), after pnpm build; don't download browsers. When tests are skipped, name them in your report, so skipped isn't read as passed.

Commit your work on a branch as you go: after each change that builds, and always before you report. Never end a turn with uncommitted changes, since a turn can stop without warning, for example when the user restarts the runner, and uncommitted work is then left for someone else to find. If the work isn't finished when you report, commit it anyway with a message starting "WIP:" and say what is left.

To bring your work onto a newer main, use git rebase. If it conflicts, run git rebase --abort, say which files conflict, and leave the branch as it was. Never leave a rebase half done.

${credentialsPrompt(spec)}`;

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
      ? spec.systemPrompt + codingPrompt(forkFolders(options, spec).work, spec)
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
  // Shared by runs that start together, so they never both create the proxy.
  let egressCheck: Promise<void> | null = null;
  return {
    ready() {
      egressCheck ??= keepEgressRunning({
        image: options.image(),
        port: options.port,
        egressPath: options.egressPath,
      }).finally(() => (egressCheck = null));
      return egressCheck;
    },
    complete(prompt) {
      return new Promise((resolve, reject) => {
        writeModelToken(options.egressPath, options.oauthToken());
        const pass = openEgressPass(
          options.egressPath,
          options.port,
          `completion-${randomBytes(6).toString('hex')}`,
          noHosts,
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
      if (spec.coding) writeCredentialFiles(folders.credentials, spec.credentials);
      writeModelToken(options.egressPath, options.oauthToken());
      const pass = openEgressPass(options.egressPath, options.port, spec.forkId, spec.network);
      const child = runtime.start(claudeDockerArguments(spec, options), {
        ...process.env,
        ...pass.environment,
      });
      const ended = () => {
        pass.close();
        removeCredentialFiles(folders.credentials);
      };
      child.on('error', ended);
      child.on('exit', ended);
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
