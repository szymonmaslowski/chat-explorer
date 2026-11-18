import { execFile, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Lease, RunContext } from '@chat-explorer/shared/protocol.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claudeDockerArguments,
  containerArguments,
  containerName,
  forkFolders,
} from '../src/claude-engine.js';
import { newestBuiltImage } from '../src/claude-image.js';
import {
  egressContainer,
  egressFolders,
  ensureEgress,
  openEgressPass,
  writeModelToken,
  type EgressPass,
} from '../src/egress.js';
import { readClaudeToken } from '../src/start.js';
import { defaultCodingLimits, runnerConfigPath, type RunnerConfig } from '../src/runner-config.js';
import { checkedRunSpec, RunRefusedError } from '../src/run-spec.js';
import type { Credential, HostRule } from '../src/access-config.js';
import { capabilitiesReport } from '../src/capabilities.js';
import { writeCredentialFiles } from '../src/credential-files.js';
import { workspaceSize } from '../src/workspace-size.js';

const lease: Lease = {
  forkId: 'fork_0000000001',
  explorationId: 'chat_0000000001',
  leaseId: 'lease-1',
  attempt: 1,
  sessionId: null,
  toolsToken: 'job-token',
};
const context: RunContext = {
  model: 'sonnet',
  coding: true,
  network: { hosts: [], registries: [], credentials: [] },
  systemPrompt: 'Be brief.',
  history: null,
};
const allowed: RunnerConfig = {
  path: '/runner/config.json',
  coding: { enabled: true, ...defaultCodingLimits, allowedHosts: null, credentials: [] },
  localBackend: true,
};
const notAllowed = { ...allowed, coding: { ...allowed.coding, enabled: false } };
const sessionId = '11111111-2222-3333-4444-555555555555';
const toolsUrl = 'http://host.docker.internal:4517/api/tools/mcp';
const engineOptions = {
  image: () => 'chat-explorer-claude:2.1.325',
  port: 4517,
  forksPath: '/runner/forks',
  workspacesPath: '/workspaces',
  filesPath: '/files',
  egressPath: '/runner/egress',
  codingLimits: { ...defaultCodingLimits, memory: '4g' },
};

const spec = (overrides: { lease?: object; context?: object; config?: RunnerConfig } = {}) =>
  checkedRunSpec({
    lease: { ...lease, ...overrides.lease },
    context: { ...context, ...overrides.context },
    sessionId,
    toolsUrl,
    config: overrides.config ?? allowed,
  });

// Checks that start real containers run only when asked, since they need Docker and the runner's
// image: CHAT_EXPLORER_DOCKER_TESTS=1 pnpm --filter @chat-explorer/runner test
const dockerTests = process.env.CHAT_EXPLORER_DOCKER_TESTS === '1';
const dockerPort = 4591;
const run = promisify(execFile);

// One coding container from the real template, running a probe instead of Claude, with a second
// fork's workspace and sessions folder on the host beside it.
async function probeCodingContainer() {
  const image = await newestBuiltImage();
  if (!image) throw new Error('Build the runner image first: start the runner once.');
  // Docker Desktop shares /private, not the /var symlink in front of the temporary folder.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'checklist-docker-')));
  const runnerPath = join(root, 'runner');
  const paths = {
    image: () => image,
    port: dockerPort,
    forksPath: join(runnerPath, 'forks'),
    workspacesPath: join(root, 'workspaces'),
    filesPath: join(root, 'files'),
    egressPath: join(runnerPath, 'egress'),
    codingLimits: { ...defaultCodingLimits, memory: '4g' },
  };
  const own = spec({
    lease: { forkId: 'fork_00000000a1' },
    context: { network: { hosts: [], registries: ['npm'], credentials: [] } },
  });
  const other = spec({ lease: { forkId: 'fork_00000000b2' } });
  const git = spec({
    lease: { forkId: 'fork_00000000c3' },
    context: {
      network: { hosts: ['github.com:443', 'github.com:22'], registries: [], credentials: [] },
    },
  });
  const ownFolders = forkFolders(paths, own);
  const otherFolders = forkFolders(paths, other);
  const gitFolders = forkFolders(paths, git);
  for (const folder of [
    ownFolders.work,
    ownFolders.sessions,
    otherFolders.work,
    otherFolders.sessions,
    gitFolders.work,
    gitFolders.sessions,
    paths.filesPath,
  ]) {
    mkdirSync(folder, { recursive: true });
  }
  for (const folders of [ownFolders, otherFolders, gitFolders]) {
    writeCredentialFiles(folders.credentials, []);
  }
  writeFileSync(runnerConfigPath(runnerPath), JSON.stringify({ coding: { enabled: true } }));
  writeFileSync(join(otherFolders.work, 'secret.env'), 'TOKEN=other-fork');
  await ensureEgress({ image, port: dockerPort, egressPath: paths.egressPath });
  writeModelToken(paths.egressPath, readClaudeToken(join(homedir(), '.chat-explorer', 'runner')));
  const probe = readFileSync(new URL('./fixtures/container-probe.cjs', import.meta.url), 'utf8');
  const probePaths = {
    runnerConfig: runnerConfigPath(runnerPath),
    otherWorkspace: otherFolders.work,
    ownWorkspace: ownFolders.work,
    otherSessions: otherFolders.sessions,
  };
  const openPass = (runSpec: typeof own) =>
    openEgressPass(paths.egressPath, dockerPort, runSpec.forkId, runSpec.network);
  const inContainer = async (
    runSpec: typeof own,
    command: string[],
    pass: EgressPass = openPass(runSpec),
    keepPass = false,
  ) => {
    try {
      const { stdout } = await run('docker', [...containerArguments(runSpec, paths), ...command], {
        timeout: 90_000,
        env: { ...process.env, ...pass.environment },
      });
      return stdout.trim();
    } catch {
      return 'failed';
    } finally {
      if (!keepPass) pass.close();
    }
  };
  const ownPass = openPass(own);
  const results = JSON.parse(
    await inContainer(own, ['node', '-e', probe, JSON.stringify(probePaths)], ownPass, true),
  );
  // The same pass used from another fork's container while its own still runs, as if its dummy
  // token leaked, and then after its container ended.
  const modelStatus = `fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { authorization: 'Bearer ' + process.env.CLAUDE_CODE_OAUTH_TOKEN, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: '{}' }).then((response) => console.log(response.status), (error) => console.log(error.message))`;
  const owner = spawn(
    'docker',
    [
      ...containerArguments(own, paths),
      'node',
      '-e',
      `${modelStatus}; setTimeout(() => {}, 60000)`,
    ],
    { env: { ...process.env, ...ownPass.environment } },
  );
  const ownerStatus = await new Promise<string>((resolve) =>
    owner.stdout.once('data', (chunk: Buffer) => resolve(chunk.toString().trim())),
  );
  const leakedDummy = await inContainer(other, ['node', '-e', modelStatus], ownPass, true);
  await run('docker', ['kill', containerName(own.forkId)]).catch(() => {});
  ownPass.close();
  const endedDummy = await inContainer(other, ['node', '-e', modelStatus], ownPass, true);
  const npmWithoutPreset = await inContainer(other, [
    'sh',
    '-c',
    'cd /tmp && npm view left-pad version --fetch-retries=0',
  ]);
  // A public repository over HTTPS, and SSH to GitHub through the proxy with its host key checked:
  // without a key GitHub then answers "Permission denied", where a wrong host key would fail first.
  const gitAccess = await inContainer(git, [
    'sh',
    '-c',
    'cd /tmp && git clone -q --depth 1 https://github.com/octocat/Hello-World.git 2>&1 && echo cloned; ssh -F /credentials/ssh_config -o BatchMode=yes -T git@github.com 2>&1; true',
  ]);
  const log = (forkId: string) =>
    readFileSync(join(egressFolders(paths.egressPath).logs, `${forkId}.log`), 'utf8');
  return {
    results,
    ownerStatus,
    leakedDummy,
    endedDummy,
    npmWithoutPreset,
    gitAccess,
    log,
    root,
    ownFolders,
    otherFolders,
    own,
    other,
  };
}

// The security acceptance checklist for coding forks, from the note "Coding forks: tools,
// workspace, brokered actions". Written before the coding profile, run after each build step, and
// kept as regression tests so later changes cannot quietly weaken the container.
describe('coding forks: security acceptance checklist', () => {
  describe.runIf(dockerTests)('in a running coding container', () => {
    let probed: Awaited<ReturnType<typeof probeCodingContainer>>;
    beforeAll(async () => {
      probed = await probeCodingContainer();
    }, 120_000);
    afterAll(async () => {
      await run('docker', ['rm', '--force', egressContainer(dockerPort)]).catch(() => {});
      if (probed) rmSync(probed.root, { recursive: true, force: true });
    });

    it('clones a public repository over HTTPS and reaches GitHub over SSH, host key checked', () => {
      expect(probed.gitAccess).toContain('cloned');
      expect(probed.gitAccess).toContain('Permission denied (publickey)');
      expect(probed.gitAccess).not.toContain('Host key verification failed');
    });

    it('reaches the model only through the proxy, holding a dummy token, never the real one', () => {
      expect(probed.results.model).toBe(400);
      expect(probed.results.dummyModelToken).toBe(true);
      expect(probed.results.modelHostThroughProxy).toBe(403);
    });

    it('1. a LAN address and the cloud metadata address are unreachable from a container', () => {
      expect(probed.results.lan).not.toBe('connected');
      expect(probed.results.metadata).not.toBe('connected');
      expect(probed.results.lanThroughProxy).toBe(403);
      expect(probed.results.metadataThroughProxy).toBe(403);
    });

    it('2. a host that is not allowed is unreachable, and DNS does not resolve names inside', () => {
      expect(probed.results.dns).not.toBe('resolved');
      expect(probed.results.outsideDirect).not.toBe('connected');
      expect(probed.results.outsideThroughProxy).toBe(403);
    });

    it('lets a container out only after it signs in as its own fork', () => {
      expect(probed.results.withoutSignIn).toBe(407);
    });

    it("reaches the fork's allowed hosts over HTTPS only, and npm install works with the preset", () => {
      expect(probed.results.allowedHostThroughProxy).toBe(200);
      expect(probed.results.allowedHostOverPlainHttp).toBe(403);
      expect(probed.results.npm).toMatch(/^\d+\.\d+\.\d+$/);
      expect(probed.results.localServer).toBe(200);
      expect(probed.npmWithoutPreset).toBe('failed');
    });

    it("logs each fork's allowed and denied connections in its own log", () => {
      const own = probed.log(probed.own.forkId);
      expect(own).toMatch(/allowed registry\.npmjs\.org:443 \(\d+\.\d+\.\d+\.\d+\)/);
      expect(own).toMatch(/denied example\.com:443: not on this fork's list/);
      expect(own).toMatch(/denied 192\.168\.1\.1:443: not on this fork's list/);
      expect(own).toMatch(/denied plain HTTP to registry\.npmjs\.org:80/);
      expect(probed.log(probed.other.forkId)).toMatch(
        /denied registry\.npmjs\.org:443: not on this fork's list/,
      );
    });

    it('7. the dummy model token works only from its own container, and dies with it', () => {
      expect(probed.ownerStatus).toBe('400');
      expect(probed.leakedDummy).toBe('401');
      expect(probed.endedDummy).toBe('401');
    });

    it("6. a container cannot read the runner config or other forks' workspaces", () => {
      expect(probed.results.runnerConfigVisible).toBe(false);
      expect(probed.results.otherWorkspaceVisible).toBe(false);
      expect(probed.results.ownWorkspace).toBe('written');
      expect(existsSync(join(probed.ownFolders.work, 'probe.txt'))).toBe(true);
    });

    it('9. a container cannot write the session folders of other forks', () => {
      expect(probed.results.ownSessions).toBe('written');
      expect(existsSync(join(probed.ownFolders.sessions, 'probe.jsonl'))).toBe(true);
      expect(existsSync(join(probed.otherFolders.sessions, 'probe.jsonl'))).toBe(false);
    });
  });

  it('3. a job naming a host, credential pairing or image outside the ceilings is refused', () => {
    const rule = (pattern: string, flags: Partial<HostRule> = {}) => ({
      pattern,
      private: false,
      hidden: false,
      ...flags,
    });
    const token: Credential = {
      name: 'GitHub token',
      type: 'token',
      file: '/runner/secrets/github-token',
      username: 'x-access-token',
      hosts: [rule('github.com:443'), rule('api.github.com:443')],
      knownHosts: [],
      hidden: false,
    };
    const ceilings: RunnerConfig = {
      ...allowed,
      coding: {
        ...allowed.coding,
        allowedHosts: [
          rule('registry.npmjs.org:443'),
          rule('*.githubusercontent.com:443'),
          rule('git.home.example.com:2222', { private: true }),
        ],
        credentials: [token],
      },
    };
    const network = (fields: object) => ({ hosts: [], registries: [], credentials: [], ...fields });
    const job = (fields: object) =>
      spec({ config: ceilings, context: { network: network(fields) } });

    expect(() => job({ hosts: ['attacker.example.com:443'] })).toThrow(
      "This runner doesn't allow attacker.example.com:443",
    );
    expect(() => job({ registries: ['pypi'] })).toThrow("This runner doesn't allow pypi.org:443");
    expect(() => job({ credentials: ['Personal SSH key'] })).toThrow(
      'The credential "Personal SSH key" is not in this runner\'s config.',
    );
    // A credential reaches only the hosts the config pairs it with.
    expect(job({ credentials: ['GitHub token'] }).network.hosts).toEqual([
      'github.com:443',
      'api.github.com:443',
    ]);
    const within = job({
      hosts: ['objects.githubusercontent.com:443', 'git.home.example.com:2222'],
      registries: ['npm'],
    });
    expect(within.network).toEqual({
      hosts: [
        'registry.npmjs.org:443',
        'objects.githubusercontent.com:443',
        'git.home.example.com:2222',
      ],
      privateHosts: ['git.home.example.com:2222'],
      hiddenHosts: [],
    });
    expect(within.credentials).toEqual([]);
    // Images: the runner runs only its own built image, and a job has no field to name another;
    // see check 4.
  });

  it('4. a job cannot pass extra docker run flags or unknown fields through', () => {
    const smuggled = {
      dockerArgs: ['--privileged'],
      extraArgs: ['--volume', '/:/host'],
      networkMode: 'host',
      image: 'attacker/image',
    };
    const built = spec({ lease: smuggled, context: smuggled });
    expect(() => spec({ context: { network: 'host' } })).toThrow(RunRefusedError);
    expect(Object.keys(built).sort()).toEqual([
      'coding',
      'credentials',
      'explorationId',
      'forkId',
      'model',
      'network',
      'resume',
      'sessionId',
      'systemPrompt',
      'toolsToken',
      'toolsUrl',
    ]);
    const args = claudeDockerArguments(built, engineOptions).join(' ');
    expect(args).not.toContain('--privileged');
    expect(args).not.toContain('/:/host');
    expect(args).not.toContain('attacker/image');
    expect(args).not.toContain('--network host');
  });

  it('5. a backend claiming coding is on, when the runner config says off, is refused', () => {
    expect(() => spec({ config: notAllowed })).toThrow(
      /Coding is turned on for this fork, but this runner does not allow it/,
    );
    expect(spec({ context: { coding: false }, config: notAllowed }).coding).toBe(false);
  });

  it("8. the runner's size check does not follow symlinks out", async () => {
    const root = mkdtempSync(join(tmpdir(), 'checklist-8-'));
    const outside = join(root, 'outside');
    const workspace = join(root, 'workspace');
    mkdirSync(outside);
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(join(outside, 'big.bin'), Buffer.alloc(1_000_000));
    writeFileSync(join(workspace, 'src', 'main.ts'), 'x'.repeat(1_000));
    symlinkSync(outside, join(workspace, 'to-outside'));
    symlinkSync(join(outside, 'big.bin'), join(workspace, 'src', 'big-link'));
    symlinkSync(workspace, join(workspace, 'src', 'loop'));
    const size = await workspaceSize(workspace);
    expect(size).toBeGreaterThanOrEqual(1_000);
    expect(size).toBeLessThan(100_000);
    rmSync(root, { recursive: true });
  });
  it('10. hidden config entries stay out of the capabilities report and the proxy logs', () => {
    const rule = (pattern: string, hidden = false) => ({ pattern, private: false, hidden });
    const config: RunnerConfig = {
      ...allowed,
      coding: {
        ...allowed.coding,
        allowedHosts: [rule('github.com:443'), rule('secret.example.com:443', true)],
        credentials: [
          {
            name: 'Secret key',
            type: 'ssh-key',
            file: '/runner/secrets/secret-key',
            username: 'x-access-token',
            hosts: [rule('git.secret.example.com:22', true)],
            knownHosts: [],
            hidden: true,
          },
          {
            name: 'GitHub token',
            type: 'token',
            file: '/runner/secrets/github-token',
            username: 'x-access-token',
            hosts: [rule('github.com:443'), rule('mirror.secret.example.com:443', true)],
            knownHosts: [],
            hidden: false,
          },
        ],
      },
    };
    const report = JSON.stringify(
      capabilitiesReport(config, { memory: '4g', slots: 1, refusal: null }, null),
    );
    expect(report).not.toMatch(/secret/i);
    expect(report).not.toContain('/runner/secrets');
    expect(report).toContain('GitHub token');
    // The proxy masks every hidden host of the config in its logs, picked by this fork or not;
    // the egress proxy's own tests check the masking.
    const job = spec({
      config,
      context: {
        network: { hosts: ['secret.example.com:443'], registries: [], credentials: ['Secret key'] },
      },
    });
    expect(job.network.hiddenHosts.sort()).toEqual([
      'git.secret.example.com:22',
      'mirror.secret.example.com:443',
      'secret.example.com:443',
    ]);
    expect(claudeDockerArguments(job, engineOptions).join(' ')).not.toMatch(/secret\.example/);
  });
});

describe('checking a job before it runs', () => {
  it('refuses ids that could name a path outside the runner folders', () => {
    for (const forkId of ['../../.ssh', 'fork_0000000001/../x', '', 'FORK_0000000001']) {
      expect(() => spec({ lease: { forkId } })).toThrow(RunRefusedError);
    }
    expect(() => spec({ lease: { explorationId: '../chat' } })).toThrow(
      'The chat id is not valid.',
    );
    expect(() =>
      checkedRunSpec({ lease, context, sessionId: '../x', toolsUrl, config: allowed }),
    ).toThrow('The session id is not valid.');
  });

  it('refuses allowed hosts that are not plain host:port entries', () => {
    const hosts = (network: object) => () => spec({ context: { network } });
    for (const network of [
      { hosts: ['github.com:443 --privileged'], registries: [], credentials: [] },
      { hosts: ['192.168.1.1:22'], registries: [], credentials: [] },
      { hosts: 'github.com:443', registries: [], credentials: [] },
      { hosts: [], registries: 'yes', credentials: [] },
      { hosts: [], registries: true, credentials: [] },
      { hosts: [], registries: ['npm', 'cargo'], credentials: [] },
      {
        hosts: Array.from({ length: 101 }, (_, index) => `h${index}.example.com:443`),
        registries: [],
        credentials: [],
      },
      { hosts: [], registries: [], credentials: 'GitHub' },
    ]) {
      expect(hosts(network)).toThrow(RunRefusedError);
    }
    expect(
      spec({
        context: {
          network: { hosts: ['github.com:443'], registries: ['npm', 'pypi'], credentials: [] },
        },
      }).network.hosts,
    ).toEqual(expect.arrayContaining(['github.com:443', 'registry.npmjs.org:443', 'pypi.org:443']));
    expect(
      spec({
        context: {
          coding: false,
          network: { hosts: ['github.com:443'], registries: ['npm'], credentials: [] },
        },
      }).network.hosts,
    ).toEqual([]);
  });

  it('refuses a model or a coding switch it does not know', () => {
    expect(() => spec({ context: { model: 'gpt' } })).toThrow('does not know the model gpt');
    expect(() => spec({ context: { coding: 'yes' } })).toThrow('The coding switch is not valid.');
  });

  it('accepts ids from before the prefixes', () => {
    expect(spec({ lease: { forkId: '0000000001' } }).forkId).toBe('0000000001');
  });
});
