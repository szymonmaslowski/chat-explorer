import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.js';
import type { ClaudeModel } from '../shared/models.js';

export interface LaunchSpec {
  explorationId: string;
  model: ClaudeModel;
  sessionId: string;
  resume: boolean;
  logPath: string;
}

export interface SessionProcess {
  stop(options?: { immediately?: boolean }): void;
  onExit(listener: (result: { code: number | null; error?: string }) => void): void;
}

export type Launcher = (spec: LaunchSpec) => SessionProcess;

const pluginDirectory = fileURLToPath(new URL('../plugin', import.meta.url));
// `claude -p` ignored SIGTERM and SIGINT in tests, so a stop that is not answered escalates.
const killAfterMs = 5_000;
const allowedTools = ['WebSearch', 'mcp__plugin_chat-explorer_chat-explorer'];

// Reading is allowed only in the folder of uploaded files; the leading `//` makes the rule an
// absolute path.
export function claudeArguments(spec: LaunchSpec, filesPath: string, plugin = pluginDirectory) {
  return [
    '-p',
    `/explore-chat ${spec.explorationId}`,
    '--model',
    spec.model,
    spec.resume ? '--resume' : '--session-id',
    spec.sessionId,
    '--plugin-dir',
    plugin,
    '--tools',
    'WebSearch,Read',
    '--allowedTools',
    ...allowedTools,
    `Read(/${filesPath}/**)`,
    '--permission-prompts',
    'none',
  ];
}

export function claudeLauncher(config: Config): Launcher {
  return (spec) => {
    mkdirSync(config.sessionsPath, { recursive: true });
    const log = openSync(spec.logPath, 'a');
    writeSync(
      log,
      `\n--- ${new Date().toISOString()} ${spec.resume ? 'resume' : 'start'} ${spec.sessionId} (${spec.model})\n`,
    );
    const child = spawn('claude', claudeArguments(spec, config.filesPath), {
      cwd: config.sessionsPath,
      stdio: ['ignore', log, log],
      env: {
        ...process.env,
        CHAT_EXPLORER_NO_BROWSER: '1',
        CHAT_EXPLORER_PORT: String(config.port),
        CHAT_EXPLORER_HOME: config.home,
      },
    });
    closeSync(log);
    return {
      stop: (options) => {
        if (options?.immediately) {
          child.kill('SIGKILL');
          return;
        }
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), killAfterMs).unref();
      },
      onExit: (listener) => {
        let reported = false;
        const report = (result: { code: number | null; error?: string }) => {
          if (reported) return;
          reported = true;
          listener(result);
        };
        child.on('error', (error) => report({ code: null, error: error.message }));
        child.on('exit', (code) => report({ code }));
      },
    };
  };
}
