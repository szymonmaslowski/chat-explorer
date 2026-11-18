import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Credential } from '../src/access-config.js';
import {
  githubHostKeys,
  removeCredentialFiles,
  removeLeftoverCredentials,
  writeCredentialFiles,
} from '../src/credential-files.js';

const fingerprint = (key: string) =>
  `SHA256:${createHash('sha256')
    .update(Buffer.from(key.split(' ')[1]!, 'base64'))
    .digest('base64')
    .replace(/=+$/, '')}`;

describe("GitHub's host keys", () => {
  it('match the fingerprints GitHub publishes', () => {
    // From docs.github.com, "GitHub's SSH key fingerprints".
    expect(githubHostKeys.map(fingerprint)).toEqual([
      'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU',
      'SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM',
      'SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s',
    ]);
  });
});

describe("a coding container's credential folder", () => {
  const root = mkdtempSync(join(tmpdir(), 'credential-files-'));
  const token = join(root, 'token');
  const key = join(root, 'key');
  writeFileSync(token, 'github_pat_test', { mode: 0o600 });
  writeFileSync(key, 'ssh key', { mode: 0o600 });
  const rule = (pattern: string) => ({ pattern, private: false, hidden: false });
  const credentials: Credential[] = [
    {
      name: 'GitHub token',
      type: 'token',
      file: token,
      username: 'x-access-token',
      hosts: [rule('github.com:443'), rule('git.example.com:8443')],
      knownHosts: [],
      hidden: false,
    },
    {
      name: 'Home git',
      type: 'ssh-key',
      file: key,
      username: 'x-access-token',
      hosts: [rule('git.home.example.com:2222')],
      knownHosts: ['[git.home.example.com]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest'],
      hidden: false,
    },
  ];
  const folder = join(root, 'credentials');
  writeCredentialFiles(folder, credentials);
  const read = (name: string) => readFileSync(join(folder, name), 'utf8');

  it('holds copies of the secrets only the owner can read, and the config using them', () => {
    expect(readdirSync(folder).sort()).toEqual([
      'connect.mjs',
      'credential-0.token',
      'credential-1.key',
      'gitconfig',
      'known_hosts',
      'ssh_config',
    ]);
    expect(read('credential-0.token')).toBe('github_pat_test');
    for (const name of readdirSync(folder)) {
      expect(statSync(join(folder, name)).mode & 0o777, name).toBe(0o600);
    }
    expect(statSync(folder).mode & 0o777).toBe(0o700);
  });

  it('gives git each token for its own hosts only, through a helper', () => {
    const gitconfig = read('gitconfig');
    expect(gitconfig).toContain('sshCommand = ssh -F /credentials/ssh_config');
    expect(gitconfig).toContain('[credential "https://github.com"]');
    expect(gitconfig).toContain('[credential "https://git.example.com:8443"]');
    expect(gitconfig).toContain('password=$(cat /credentials/credential-0.token)');
    expect(gitconfig).not.toContain('github_pat_test');
    expect(gitconfig).not.toContain('git.home.example.com');
  });

  it('sends SSH through the proxy, checking host keys against the ones given', () => {
    const sshConfig = read('ssh_config');
    expect(sshConfig).toContain(
      'Host git.home.example.com\n  Port 2222\n  User git\n  IdentityFile /credentials/credential-1.key\n  IdentitiesOnly yes',
    );
    expect(sshConfig).toContain('StrictHostKeyChecking yes');
    expect(sshConfig).toContain('ProxyCommand node --no-warnings /credentials/connect.mjs %h %p');
    const knownHosts = read('known_hosts');
    expect(knownHosts).toContain(`github.com ${githubHostKeys[0]}`);
    expect(knownHosts).toContain(`[ssh.github.com]:443 ${githubHostKeys[0]}`);
    expect(knownHosts).toContain('[git.home.example.com]:2222 ssh-ed25519');
  });

  it('is removed with the container, the copies with it', () => {
    removeCredentialFiles(folder);
    expect(existsSync(folder)).toBe(false);
    expect(existsSync(token)).toBe(true);
  });

  it('is removed at the start for every fork, when a runner stopped without cleaning up', () => {
    const forksPath = join(root, 'forks');
    const left = join(forksPath, 'fork_000000000a', 'credentials');
    writeCredentialFiles(left, credentials);
    removeLeftoverCredentials(forksPath, (forkId) => join(forksPath, forkId, 'credentials'));
    expect(existsSync(left)).toBe(false);
    expect(existsSync(join(forksPath, 'fork_000000000a'))).toBe(true);
  });
});
