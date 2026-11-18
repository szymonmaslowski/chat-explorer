import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRunnerConfig, RunnerConfigError } from '../src/runner-config.js';

const runnerPath = mkdtempSync(join(tmpdir(), 'runner-config-'));
const configPath = join(runnerPath, 'config.json');

afterEach(() => rmSync(configPath, { force: true }));

describe("the runner's own config", () => {
  it('turns coding off when there is no config file', () => {
    expect(readRunnerConfig(runnerPath)).toEqual({
      path: configPath,
      coding: {
        enabled: false,
        processes: 512,
        workspaceLimitGb: 10,
        minFreeGb: 10,
        allowedHosts: null,
        credentials: [],
      },
      localBackend: true,
    });
  });

  it('allows coding only when the file says so', () => {
    writeFileSync(configPath, JSON.stringify({ coding: { enabled: true } }));
    expect(readRunnerConfig(runnerPath).coding.enabled).toBe(true);
    writeFileSync(configPath, JSON.stringify({}));
    expect(readRunnerConfig(runnerPath).coding.enabled).toBe(false);
  });

  it("takes a coding container's memory and process limits from the file", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ coding: { enabled: true, memory: '8g', processes: 2048, cpus: 6 } }),
    );
    expect(readRunnerConfig(runnerPath).coding).toMatchObject({
      enabled: true,
      memory: '8g',
      processes: 2048,
      cpus: 6,
    });
  });

  it("leaves CPUs and memory to Docker's size unless the file caps them", () => {
    writeFileSync(configPath, JSON.stringify({ coding: { enabled: true } }));
    expect(readRunnerConfig(runnerPath).coding).not.toHaveProperty('cpus');
    expect(readRunnerConfig(runnerPath).coding).not.toHaveProperty('memory');
  });

  it('takes the disk limits from the file, as gigabytes above 0', () => {
    writeFileSync(configPath, JSON.stringify({ coding: { workspaceLimitGb: 25, minFreeGb: 5.5 } }));
    expect(readRunnerConfig(runnerPath).coding).toMatchObject({
      workspaceLimitGb: 25,
      minFreeGb: 5.5,
    });
    for (const workspaceLimitGb of [0, -1, '10', null]) {
      writeFileSync(configPath, JSON.stringify({ coding: { workspaceLimitGb } }));
      if (workspaceLimitGb === null) {
        expect(readRunnerConfig(runnerPath).coding.workspaceLimitGb).toBe(10);
        continue;
      }
      expect(() => readRunnerConfig(runnerPath)).toThrow(
        `coding.workspaceLimitGb in ${configPath}`,
      );
    }
  });

  it('refuses limits Docker would not read as meant', () => {
    for (const memory of ['4', '4gb', '0g', 4, '-1g', '4g --privileged']) {
      writeFileSync(configPath, JSON.stringify({ coding: { memory } }));
      expect(() => readRunnerConfig(runnerPath)).toThrow(`coding.memory in ${configPath}`);
    }
    for (const cpus of [0, -1, '4', null]) {
      writeFileSync(configPath, JSON.stringify({ coding: { cpus } }));
      expect(() => readRunnerConfig(runnerPath)).toThrow(`coding.cpus in ${configPath}`);
    }
    for (const processes of [0, -5, 1.5, '512']) {
      writeFileSync(configPath, JSON.stringify({ coding: { processes } }));
      expect(() => readRunnerConfig(runnerPath)).toThrow(`coding.processes in ${configPath}`);
    }
  });

  it('refuses a file it cannot read safely, naming it', () => {
    writeFileSync(configPath, '{ coding: true');
    expect(() => readRunnerConfig(runnerPath)).toThrow(RunnerConfigError);
    writeFileSync(configPath, JSON.stringify({ coding: { enabled: 'yes' } }));
    expect(() => readRunnerConfig(runnerPath)).toThrow(`coding.enabled in ${configPath}`);
  });

  it('refuses a config other users could change', () => {
    writeFileSync(configPath, JSON.stringify({ coding: { enabled: true } }));
    chmodSync(configPath, 0o666);
    expect(() => readRunnerConfig(runnerPath)).toThrow('can be changed by other users');
    chmodSync(configPath, 0o600);
    expect(readRunnerConfig(runnerPath).coding.enabled).toBe(true);
  });

  it('runs coding forks only for a local backend unless the file says otherwise', () => {
    writeFileSync(configPath, JSON.stringify({ coding: { enabled: true } }));
    expect(readRunnerConfig(runnerPath).localBackend).toBe(true);
    writeFileSync(configPath, JSON.stringify({ localBackend: false }));
    expect(readRunnerConfig(runnerPath).localBackend).toBe(false);
    writeFileSync(configPath, JSON.stringify({ localBackend: 'yes' }));
    expect(() => readRunnerConfig(runnerPath)).toThrow(`localBackend in ${configPath}`);
  });
});

describe("the runner's ceilings and credentials", () => {
  const secret = join(runnerPath, 'github-token');
  const key = join(runnerPath, 'home-key');
  writeFileSync(secret, 'github_pat_test', { mode: 0o600 });
  writeFileSync(key, 'not really a key', { mode: 0o600 });
  const write = (coding: object) => writeFileSync(configPath, JSON.stringify({ coding }));

  it('reads allowed hosts, with wildcards and private or hidden ones', () => {
    write({
      allowedHosts: [
        'github.com:443',
        '*.githubusercontent.com:443',
        { host: 'git.home.example.com:2222', private: true, hidden: true },
      ],
    });
    expect(readRunnerConfig(runnerPath).coding.allowedHosts).toEqual([
      { pattern: 'github.com:443', private: false, hidden: false },
      { pattern: '*.githubusercontent.com:443', private: false, hidden: false },
      { pattern: 'git.home.example.com:2222', private: true, hidden: true },
    ]);
    write({});
    expect(readRunnerConfig(runnerPath).coding.allowedHosts).toBeNull();
    for (const allowedHosts of [
      ['github.com'],
      ['10.0.0.1:22'],
      ['*:443'],
      [{ host: '*.example.com:443', hidden: true }],
      [{ host: 'github.com:443', private: 'yes' }],
      'github.com:443',
    ]) {
      write({ allowedHosts });
      expect(() => readRunnerConfig(runnerPath), JSON.stringify(allowedHosts)).toThrow(
        RunnerConfigError,
      );
    }
  });

  it('reads credentials paired with hosts, a secret only its owner can read', () => {
    write({
      credentials: [
        {
          name: 'GitHub token',
          type: 'token',
          file: secret,
          hosts: ['github.com:443', 'api.github.com:443'],
        },
        { name: 'GitHub deploy key', type: 'ssh-key', file: key, hosts: ['github.com:22'] },
      ],
    });
    expect(readRunnerConfig(runnerPath).coding.credentials).toEqual([
      {
        name: 'GitHub token',
        type: 'token',
        file: secret,
        username: 'x-access-token',
        hosts: [
          { pattern: 'github.com:443', private: false, hidden: false },
          { pattern: 'api.github.com:443', private: false, hidden: false },
        ],
        knownHosts: [],
        hidden: false,
      },
      expect.objectContaining({ name: 'GitHub deploy key', type: 'ssh-key', file: key }),
    ]);
    chmodSync(secret, 0o644);
    expect(() => readRunnerConfig(runnerPath)).toThrow('can be read by other users');
    chmodSync(secret, 0o600);
  });

  it('refuses an SSH key for a host whose host key nobody gave, saying how to get it', () => {
    const credential = {
      name: 'Home git',
      type: 'ssh-key',
      file: key,
      hosts: ['git.home.example.com:2222'],
    };
    write({ credentials: [credential] });
    expect(() => readRunnerConfig(runnerPath)).toThrow(
      'Run: ssh-keyscan -p 2222 git.home.example.com',
    );
    write({
      credentials: [
        {
          ...credential,
          knownHosts: ['[git.home.example.com]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest'],
        },
      ],
    });
    expect(readRunnerConfig(runnerPath).coding.credentials[0]?.knownHosts).toHaveLength(1);
  });

  it('refuses credentials it cannot use safely', () => {
    const valid = { name: 'Token', type: 'token', file: secret, hosts: ['github.com:443'] };
    for (const credential of [
      { ...valid, name: '../token' },
      { ...valid, type: 'password' },
      { ...valid, file: 'relative/token' },
      { ...valid, file: join(runnerPath, 'missing') },
      { ...valid, hosts: [] },
      { ...valid, hosts: ['*.github.com:443'] },
      { ...valid, username: 'a b' },
      { ...valid, knownHosts: ['not a host key'] },
    ]) {
      write({ credentials: [credential] });
      expect(() => readRunnerConfig(runnerPath), JSON.stringify(credential)).toThrow(
        RunnerConfigError,
      );
    }
    write({ credentials: [valid, valid] });
    expect(() => readRunnerConfig(runnerPath)).toThrow('appears twice');
  });
});
