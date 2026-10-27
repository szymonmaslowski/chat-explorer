import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Config } from '../config.js';
import { DaemonStartError, defaultDaemonEntry, stopDaemon, waitForHealth } from './control.js';

const label = 'local.chat-explorer.daemon';
const launchAgentPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const runCommand = promisify(execFile);
const userDomain = () => `gui/${userInfo().uid}`;

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlString = (text: string) => `<string>${escapeXml(text)}</string>`;

export function launchAgentPlist(input: {
  nodePath: string;
  daemonEntry: string;
  config: Config;
  path: string;
}) {
  const environment = {
    PATH: input.path,
    CHAT_EXPLORER_HOME: input.config.home,
    CHAT_EXPLORER_PORT: String(input.config.port),
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${xmlString(label)}
  <key>ProgramArguments</key>
  <array>
    ${xmlString(input.nodePath)}
    ${xmlString(input.daemonEntry)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(environment)
  .map(([name, value]) => `    <key>${name}</key>\n    ${xmlString(value)}`)
  .join('\n')}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  ${xmlString(input.config.logPath)}
  <key>StandardErrorPath</key>
  ${xmlString(input.config.logPath)}
</dict>
</plist>
`;
}

function requireMacos() {
  if (process.platform !== 'darwin') {
    throw new DaemonStartError('chat-explorer service is only available on macOS.');
  }
}

const unload = () =>
  runCommand('launchctl', ['bootout', `${userDomain()}/${label}`]).catch(() => {});

export async function installService(config: Config) {
  requireMacos();
  await unload();
  await stopDaemon(config);
  mkdirSync(dirname(launchAgentPath), { recursive: true });
  mkdirSync(config.home, { recursive: true });
  writeFileSync(
    launchAgentPath,
    launchAgentPlist({
      nodePath: process.execPath,
      daemonEntry: defaultDaemonEntry,
      config,
      path: process.env.PATH ?? '',
    }),
  );
  await runCommand('launchctl', ['bootstrap', userDomain(), launchAgentPath]);
  return { launchAgentPath, health: await waitForHealth(config) };
}

export async function uninstallService() {
  requireMacos();
  if (!existsSync(launchAgentPath)) return null;
  await unload();
  rmSync(launchAgentPath);
  return launchAgentPath;
}
