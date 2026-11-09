import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseClaudeStreamLine, streamUserMessage } from './claude-stream.js';
import type { Engine, EngineEvent, EngineRun, EngineRunSpec } from './engine.js';

export interface ClaudeEnginePaths {
  // Per fork: its working folder and its Claude Code sessions, kept between containers.
  forksPath: string;
  // Uploads, readable by the engine at the same path as on the host.
  filesPath: string;
}

export interface ClaudeEngineOptions extends ClaudeEnginePaths {
  image: string;
  oauthToken: () => string;
}

const containerHome = '/home/agent';
const mcpServerName = 'chat';
// `claude -p` ignores SIGTERM at times, so a stop that is not answered escalates.
const killAfterMs = 5_000;

export const containerName = (forkId: string) => `chat-explorer-run-${forkId}`;

export const forkFolders = (forksPath: string, forkId: string) => ({
  work: join(forksPath, forkId, 'work'),
  sessions: join(forksPath, forkId, 'claude-projects'),
});

// The folder appears inside the container at the same absolute path, so Claude Code files the
// session under the same project name it would use on the host.
export function claudeDockerArguments(
  spec: EngineRunSpec,
  options: Omit<ClaudeEngineOptions, 'oauthToken'>,
) {
  const folders = forkFolders(options.forksPath, spec.forkId);
  const mcpConfig = {
    mcpServers: {
      [mcpServerName]: {
        type: 'http',
        url: spec.toolsUrl,
        headers: { Authorization: `Bearer ${spec.toolsToken}` },
      },
    },
  };
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
    '256',
    '--memory',
    '2g',
    '--cpus',
    '2',
    '--env',
    'CLAUDE_CODE_OAUTH_TOKEN',
    '--env',
    'DISABLE_AUTOUPDATER=1',
    '--volume',
    `${folders.work}:${folders.work}`,
    '--workdir',
    folders.work,
    '--volume',
    `${folders.sessions}:${containerHome}/.claude/projects`,
    '--volume',
    `${options.filesPath}:${options.filesPath}:ro`,
    options.image,
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
    'WebSearch,Read',
    '--allowedTools',
    'WebSearch',
    `Read(/${options.filesPath}/**)`,
    `mcp__${mcpServerName}`,
    '--mcp-config',
    JSON.stringify(mcpConfig),
    '--strict-mcp-config',
    '--permission-prompts',
    'none',
    '--append-system-prompt',
    spec.systemPrompt,
  ];
}

// The model for small jobs, cheap and quick.
const completionModel = 'haiku';

export const claudeCompletionArguments = (prompt: string, image: string) => [
  'run',
  '--rm',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
  '--env',
  'CLAUDE_CODE_OAUTH_TOKEN',
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
        const child = spawn('docker', claudeCompletionArguments(prompt, options.image), {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: options.oauthToken() },
        });
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
        child.on('error', reject);
        child.on('exit', () => {
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
      const folders = forkFolders(options.forksPath, spec.forkId);
      mkdirSync(folders.work, { recursive: true });
      mkdirSync(folders.sessions, { recursive: true });
      const child = spawn('docker', claudeDockerArguments(spec, options), {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: options.oauthToken() },
      });
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
        stop: (stopOptions) => {
          if (stopOptions?.immediately) {
            child.kill('SIGKILL');
            spawn('docker', ['kill', containerName(spec.forkId)], { stdio: 'ignore' });
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
