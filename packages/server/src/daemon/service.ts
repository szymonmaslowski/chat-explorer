import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Config } from '../config.js';

export const serviceLabel = 'local.chat-explorer.daemon';
export const launchAgentPath = join(homedir(), 'Library', 'LaunchAgents', `${serviceLabel}.plist`);
export const runCommand = promisify(execFile);
export const userDomain = () => `gui/${userInfo().uid}`;

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const xmlString = (text: string) => `<string>${escapeXml(text)}</string>`;

// The login service runs the daemon for one home and port; another CHAT_EXPLORER_HOME or port,
// as in the tests, starts a daemon of its own.
export function serviceRunsFor(config: Config, plistPath = launchAgentPath) {
  if (process.platform !== 'darwin' || !existsSync(plistPath)) return false;
  const plist = readFileSync(plistPath, 'utf8');
  return plist.includes(xmlString(config.home)) && plist.includes(xmlString(String(config.port)));
}

// Loads the service again if `launchctl bootout` unloaded it; loading starts it.
export async function startService(plistPath = launchAgentPath) {
  try {
    await runCommand('launchctl', ['kickstart', `${userDomain()}/${serviceLabel}`]);
  } catch {
    await runCommand('launchctl', ['bootstrap', userDomain(), plistPath]);
  }
}

// The daemon launchd runs now, or null when it runs none.
export async function servicePid() {
  const { stdout } = await runCommand('launchctl', [
    'print',
    `${userDomain()}/${serviceLabel}`,
  ]).catch(() => ({ stdout: '' }));
  const pid = /^\s*pid = (\d+)$/m.exec(stdout)?.[1];
  return pid ? Number(pid) : null;
}
