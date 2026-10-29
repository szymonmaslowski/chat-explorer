import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from '../config.js';
import { DaemonStartError, defaultDaemonEntry, stopDaemon, waitForHealth } from './control.js';
import { launchAgentPath, runCommand, serviceLabel, userDomain, xmlString } from './service.js';

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
  ${xmlString(serviceLabel)}
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
  runCommand('launchctl', ['bootout', `${userDomain()}/${serviceLabel}`]).catch(() => {});

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
