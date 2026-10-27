#!/usr/bin/env node
import '../suppress-warnings.js';
import { parseArgs } from 'node:util';
import { createDaemonClient, DaemonError } from '../client/http.js';
import { apiVersion, loadConfig } from '../config.js';
import { DaemonStartError, ensureDaemon, probe, stopDaemon } from '../daemon/control.js';
import { dictationAvailability } from '../dictation/availability.js';
import { whisperModelPath, whisperModels } from '../dictation/models.js';
import { openBrowser } from '../open-browser.js';
import {
  InstallError,
  installDictation,
  megabytes,
  uninstallDictation,
} from '../dictation/install.js';
import { loadSettings, SettingsError } from '../settings.js';
import { relativeTime } from '../shared/time.js';
import type { ExplorationListItem } from '../shared/types.js';
import { packageVersion } from '../version.js';

const usage = `Usage: chat-explorer <command>

Commands:
  start                       Start the daemon if it is not running and print its URL
  stop                        Stop the daemon
  status                      Show whether the daemon runs, its version and attached sessions
  list [--archived|--deleted] [--json]
                              List explorations
  open [id] [--fork <forkId>] Open the UI in the browser
  archive <id>                Archive an exploration
  unarchive <id>              Bring an archived exploration back
  delete <id>                 Delete an exploration (restore brings it back)
  restore <id>                Bring a deleted exploration back, archived
  purge <id>                  Delete an exploration permanently
  service install             Run the daemon at login (macOS)
  service uninstall           Stop running the daemon at login
  dictation install [--model <name>]
                              Download the Whisper model for dictation
  dictation uninstall         Delete the Whisper models
  mcp                         Run the stdio MCP server (used by the Claude Code plugin)
  hook <name>                 Run a Claude Code hook handler (used by the plugin)
  --version                   Print the version`;

const config = loadConfig();
const request = createDaemonClient(config.baseUrl);
const ensureRunning = () => ensureDaemon(config, { version: packageVersion, apiVersion });

const truncate = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

const commands: Record<string, (args: string[]) => Promise<void>> = {
  async start() {
    const { health, started } = await ensureRunning();
    console.log(
      `chat-explorer ${health.version} ${started ? 'started' : 'is running'} at ${config.baseUrl}`,
    );
  },

  async stop() {
    const stopped = await stopDaemon(config);
    console.log(stopped ? 'chat-explorer stopped.' : 'chat-explorer is not running.');
  },

  async status() {
    const current = await probe(config.baseUrl);
    if (current.state === 'stopped')
      return console.log(`chat-explorer is not running (port ${config.port}).`);
    if (current.state === 'foreign') {
      return console.log(`Port ${config.port} is used by another program.`);
    }
    const { version, pid } = current.health;
    console.log(`chat-explorer ${version} is running at ${config.baseUrl} (pid ${pid}).`);
    const { model } = loadSettings(config).dictation;
    const dictation = dictationAvailability(whisperModelPath(config.modelsPath, model));
    console.log(`Dictation: ${dictation.available ? 'ready' : dictation.reason}`);
    const explorations = await request<ExplorationListItem[]>('/api/explorations');
    const attached = explorations.filter((exploration) => exploration.sessionStatus !== 'detached');
    if (attached.length === 0) return console.log('No Claude session is attached.');
    for (const exploration of attached) {
      console.log(
        `  ${exploration.id}  ${exploration.sessionStatus.padEnd(9)}  ${exploration.title}`,
      );
    }
  },

  async list(args) {
    const { values } = parseArgs({
      args,
      options: {
        json: { type: 'boolean' },
        archived: { type: 'boolean' },
        deleted: { type: 'boolean' },
      },
    });
    await ensureRunning();
    const query = values.deleted ? '?deleted=true' : values.archived ? '?archived=true' : '';
    const explorations = await request<ExplorationListItem[]>(`/api/explorations${query}`);
    if (values.json) return console.log(JSON.stringify(explorations, null, 2));
    if (explorations.length === 0) {
      return console.log(
        query ? 'No explorations here.' : 'No explorations yet. Run /explore-chat in Claude Code.',
      );
    }
    for (const exploration of explorations) {
      const forks = `${exploration.forkCount} fork${exploration.forkCount === 1 ? '' : 's'}`;
      console.log(
        `${exploration.id}  ${relativeTime(exploration.updatedAt).padEnd(11)}  ${forks.padEnd(8)}  ${truncate(exploration.title || '(untitled)', 60)}`,
      );
      if (exploration.summary)
        console.log(`${' '.repeat(12)}${truncate(exploration.summary, 100)}`);
    }
  },

  async open(args) {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { fork: { type: 'string' } },
    });
    await ensureRunning();
    const [explorationId] = positionals;
    const path = !explorationId
      ? '/'
      : values.fork
        ? `/e/${explorationId}/f/${values.fork}`
        : `/e/${explorationId}`;
    openBrowser(`${config.baseUrl}${path}`);
    console.log(`Opened ${config.baseUrl}${path}`);
  },

  async service([action]) {
    const { installService, uninstallService } = await import('../daemon/launchd.js');
    if (action === 'install') {
      const { launchAgentPath, health } = await installService(config);
      console.log(`chat-explorer ${health.version} runs at login (${launchAgentPath}).`);
      return;
    }
    if (action === 'uninstall') {
      const removed = await uninstallService();
      console.log(removed ? `Removed ${removed}.` : 'The chat-explorer service is not installed.');
      return;
    }
    throw new UsageError('chat-explorer service install|uninstall');
  },

  async dictation([action, ...args]) {
    if (action === 'install') {
      const { values } = parseArgs({ args, options: { model: { type: 'string' } } });
      const model = whisperModels.find((name) => name === values.model);
      if (values.model && !model) {
        throw new UsageError(`chat-explorer dictation install --model ${whisperModels.join('|')}`);
      }
      let printedMegabytes = -1;
      await installDictation({
        config,
        model: model ?? loadSettings(config).dictation.model,
        log: (line) => console.log(line),
        onProgress: (receivedBytes, totalBytes) => {
          const done = receivedBytes === totalBytes;
          const receivedMegabytes = megabytes(receivedBytes);
          if (receivedMegabytes === printedMegabytes && !done) return;
          printedMegabytes = receivedMegabytes;
          process.stdout.write(
            `\rDownloading ${receivedMegabytes} / ${megabytes(totalBytes)} MB${done ? '\n' : ''}`,
          );
        },
      });
      const current = await probe(config.baseUrl);
      if (current.state !== 'running') {
        return console.log('Dictation is ready. Start chat-explorer to use it.');
      }
      const settings = await request<{ dictation: boolean }>('/api/settings');
      console.log(
        settings.dictation
          ? 'Dictation is ready.'
          : 'The running daemon cannot find whisper-cli or the model. If it runs as a service, run chat-explorer service install again so it picks up your PATH.',
      );
      return;
    }
    if (action === 'uninstall') {
      const removed = await uninstallDictation(config);
      for (const path of removed) console.log(`Removed ${path}.`);
      if (removed.length === 0) console.log('No Whisper model is installed.');
      console.log('To remove whisper-cli too: brew uninstall whisper-cpp');
      return;
    }
    throw new UsageError('chat-explorer dictation install|uninstall');
  },

  async mcp() {
    const { runShim } = await import('../mcp/shim.js');
    await runShim();
  },

  async hook([name]) {
    const { runHook } = await import('../hooks/run-hook.js');
    await runHook(name ?? '', config);
  },

  async archive([explorationId]) {
    await changeExploration('archive', explorationId, '/archive', 'POST', 'Archived');
  },

  async unarchive([explorationId]) {
    await changeExploration('unarchive', explorationId, '/unarchive', 'POST', 'Unarchived');
  },

  async delete([explorationId]) {
    await changeExploration('delete', explorationId, '', 'DELETE', 'Deleted');
  },

  async restore([explorationId]) {
    await changeExploration('restore', explorationId, '/restore', 'POST', 'Restored (archived)');
  },

  async purge([explorationId]) {
    await changeExploration('purge', explorationId, '?purge=true', 'DELETE', 'Permanently deleted');
  },
};

class UsageError extends Error {}

async function changeExploration(
  command: string,
  explorationId: string | undefined,
  pathSuffix: string,
  method: 'POST' | 'DELETE',
  done: string,
) {
  if (!explorationId) throw new UsageError(`chat-explorer ${command} <id>`);
  await ensureRunning();
  await request(`/api/explorations/${explorationId}${pathSuffix}`, { method });
  console.log(`${done} exploration ${explorationId}.`);
}

async function main([command, ...args]: string[]) {
  if (command === '--version' || command === '-v') return console.log(packageVersion);
  const run = command ? commands[command] : undefined;
  if (!run) {
    console.log(usage);
    process.exitCode = command && command !== '--help' && command !== 'help' ? 1 : 0;
    return;
  }
  await run(args);
}

main(process.argv.slice(2)).catch((error: Error) => {
  if (error instanceof UsageError) console.error(`Usage: ${error.message}`);
  else if (
    error instanceof DaemonStartError ||
    error instanceof DaemonError ||
    error instanceof SettingsError ||
    error instanceof InstallError
  )
    console.error(error.message);
  else console.error(error);
  process.exitCode = 1;
});
