import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  credentialNamePattern,
  isHostPort,
  matchesHostPattern,
  splitHostPort,
} from '@chat-explorer/shared/network.js';

// One entry of the runner's host ceiling, or a host a credential is paired with. `pattern` is a
// host:port, or in the ceiling *.domain:port for every name under a domain.
export interface HostRule {
  pattern: string;
  // The proxy lets it resolve to an address on your own network, such as a git server at home.
  private: boolean;
  // Left out of the capabilities report and masked in the proxy logs.
  hidden: boolean;
}

export type CredentialType = 'token' | 'ssh-key';

export interface Credential {
  name: string;
  type: CredentialType;
  // The secret, readable by its owner only.
  file: string;
  // What git sends as the user name with a token.
  username: string;
  hosts: HostRule[];
  // Host keys for SSH, as known_hosts lines, besides the ones the runner knows itself.
  knownHosts: string[];
  hidden: boolean;
}

export interface AccessConfig {
  // The hosts a fork may be allowed besides its credentials' own; null allows any public host.
  allowedHosts: HostRule[] | null;
  credentials: Credential[];
}

const knownHostPattern =
  /^[^\s#]+ (ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/]+={0,2}$/;

// How known_hosts and ssh name a host: plain on port 22, [host]:port otherwise.
export const knownHostsName = (hostPort: string) => {
  const { host, port } = splitHostPort(hostPort);
  return port === 22 ? host : `[${host}]:${port}`;
};

export const matchesRule = (rule: HostRule, hostPort: string) =>
  matchesHostPattern(rule.pattern, hostPort);

const expandHome = (path: string) =>
  path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;

// A file only its owner may change, as the ceilings and secrets must be.
export function checkOwnedFile(path: string, what: string, options: { secret: boolean }) {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new AccessConfigError(`${what}: ${path} does not exist.`);
  }
  if (!stats.isFile()) throw new AccessConfigError(`${what}: ${path} is not a file.`);
  if (process.getuid && stats.uid !== process.getuid()) {
    throw new AccessConfigError(`${what}: ${path} belongs to another user.`);
  }
  const forbidden = options.secret ? 0o077 : 0o022;
  if ((stats.mode & forbidden) !== 0) {
    const fix = options.secret ? 'chmod 600' : 'chmod go-w';
    throw new AccessConfigError(
      `${what}: ${path} can be ${options.secret ? 'read' : 'changed'} by other users. Run: ${fix} "${path}"`,
    );
  }
}

export class AccessConfigError extends Error {}

function hostRules(value: unknown, where: string, wildcards: boolean): HostRule[] {
  if (!Array.isArray(value)) throw new AccessConfigError(`${where} must be a list of hosts.`);
  return value.map((entry: unknown) => {
    const rule =
      typeof entry === 'string'
        ? { host: entry, private: false, hidden: false }
        : (entry as { host?: unknown; private?: unknown; hidden?: unknown } | null);
    const host = rule?.host;
    const exact = typeof host === 'string' && isHostPort(host);
    const wildcard =
      wildcards && typeof host === 'string' && host.startsWith('*.') && isHostPort(host.slice(2));
    if (!exact && !wildcard) {
      throw new AccessConfigError(
        `${where}: ${JSON.stringify(entry)} is not a host:port${wildcards ? ' or *.domain:port' : ''}, or { "host": ..., "private": true, "hidden": true }.`,
      );
    }
    const flag = (name: 'private' | 'hidden') => {
      const flagValue = rule?.[name] ?? false;
      if (typeof flagValue !== 'boolean') {
        throw new AccessConfigError(`${where}: "${name}" of ${host} must be true or false.`);
      }
      return flagValue;
    };
    const hidden = flag('hidden');
    if (wildcard && hidden) {
      throw new AccessConfigError(`${where}: ${host} can't be hidden, only a single host can.`);
    }
    return { pattern: host as string, private: flag('private'), hidden };
  });
}

// The parts of `coding` that say what a fork may reach and with which credentials. The backend can
// pick among them, never add to them.
export function readAccessConfig(
  coding: { allowedHosts?: unknown; credentials?: unknown } | undefined,
  path: string,
  knowsHostKey: (hostPort: string) => boolean,
): AccessConfig {
  const allowedHosts =
    coding?.allowedHosts === undefined
      ? null
      : hostRules(coding.allowedHosts, `coding.allowedHosts in ${path}`, true);
  const entries = coding?.credentials ?? [];
  if (!Array.isArray(entries)) {
    throw new AccessConfigError(`coding.credentials in ${path} must be a list.`);
  }
  const names = new Set<string>();
  const credentials = entries.map((entry: unknown): Credential => {
    const raw = (entry ?? {}) as Record<string, unknown>;
    const name = raw.name;
    if (typeof name !== 'string' || !credentialNamePattern.test(name)) {
      throw new AccessConfigError(
        `Each entry of coding.credentials in ${path} needs a "name" of letters, digits, spaces, dots, dashes or underscores.`,
      );
    }
    const where = `Credential "${name}" in ${path}`;
    if (names.has(name)) throw new AccessConfigError(`${where} appears twice.`);
    names.add(name);
    if (raw.type !== 'token' && raw.type !== 'ssh-key') {
      throw new AccessConfigError(`${where}: "type" must be "token" or "ssh-key".`);
    }
    if (typeof raw.file !== 'string' || !isAbsolute(expandHome(raw.file))) {
      throw new AccessConfigError(`${where}: "file" must be a full path, or start with ~/.`);
    }
    const file = expandHome(raw.file);
    checkOwnedFile(file, where, { secret: true });
    const username = raw.username ?? 'x-access-token';
    if (typeof username !== 'string' || !/^[\w.@-]{1,64}$/.test(username)) {
      throw new AccessConfigError(`${where}: "username" is not a valid user name.`);
    }
    const hosts = hostRules(raw.hosts, `${where}, "hosts"`, false);
    if (hosts.length === 0) throw new AccessConfigError(`${where}: "hosts" is empty.`);
    const knownHosts = raw.knownHosts ?? [];
    if (
      !Array.isArray(knownHosts) ||
      knownHosts.some((line) => typeof line !== 'string' || !knownHostPattern.test(line))
    ) {
      throw new AccessConfigError(
        `${where}: "knownHosts" must be a list of known_hosts lines, such as the output of ssh-keyscan.`,
      );
    }
    if (raw.type === 'ssh-key') {
      const listed = (hostPort: string) =>
        knownHosts.some((line: string) =>
          line.split(' ')[0]!.split(',').includes(knownHostsName(hostPort)),
        );
      const unknown = hosts.find((rule) => !knowsHostKey(rule.pattern) && !listed(rule.pattern));
      if (unknown) {
        const { host, port } = splitHostPort(unknown.pattern);
        throw new AccessConfigError(
          `${where}: no host key for ${unknown.pattern}, so SSH would refuse it. Run: ssh-keyscan -p ${port} ${host}, check the key's fingerprint with whoever runs the server, and add the line to "knownHosts".`,
        );
      }
    }
    const hidden = raw.hidden ?? false;
    if (typeof hidden !== 'boolean')
      throw new AccessConfigError(`${where}: "hidden" must be true or false.`);
    return { name, type: raw.type, file, username, hosts, knownHosts, hidden };
  });
  return { allowedHosts, credentials };
}
