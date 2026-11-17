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
import { defaultCodingLimits, runnerConfigPath } from '../src/runner-config.js';
import { checkedRunSpec, RunRefusedError } from '../src/run-spec.js';
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
  network: { hosts: [], registries: [] },
  systemPrompt: 'Be brief.',
  history: null,
};
const allowed = { path: '/runner/config.json', coding: { enabled: true, ...defaultCodingLimits } };
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

const spec = (overrides: { lease?: object; context?: object; config?: typeof allowed } = {}) =>
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
    context: { network: { hosts: [], registries: ['npm'] } },
  });
  const other = spec({ lease: { forkId: 'fork_00000000b2' } });
  const ownFolders = forkFolders(paths, own);
  const otherFolders = forkFolders(paths, other);
  for (const folder of [
    ownFolders.work,
    ownFolders.sessions,
    otherFolders.work,
    otherFolders.sessions,
    paths.filesPath,
  ]) {
    mkdirSync(folder, { recursive: true });
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
    openEgressPass(paths.egressPath, dockerPort, runSpec.forkId, runSpec.hosts);
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
  const log = (forkId: string) =>
    readFileSync(join(egressFolders(paths.egressPath).logs, `${forkId}.log`), 'utf8');
  return {
    results,
    ownerStatus,
    leakedDummy,
    endedDummy,
    npmWithoutPreset,
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

  it.todo('3. a job naming a host, credential pairing or image outside the ceilings is refused');

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
      'explorationId',
      'forkId',
      'hosts',
      'model',
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
  it.todo('10. hidden config entries stay out of the capabilities report and the proxy logs');
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
      { hosts: ['github.com:443 --privileged'], registries: [] },
      { hosts: ['192.168.1.1:22'], registries: [] },
      { hosts: 'github.com:443', registries: [] },
      { hosts: [], registries: 'yes' },
      { hosts: [], registries: true },
      { hosts: [], registries: ['npm', 'cargo'] },
      {
        hosts: Array.from({ length: 101 }, (_, index) => `h${index}.example.com:443`),
        registries: [],
      },
    ]) {
      expect(hosts(network)).toThrow(RunRefusedError);
    }
    expect(
      spec({ context: { network: { hosts: ['github.com:443'], registries: ['npm', 'pypi'] } } })
        .hosts,
    ).toEqual(expect.arrayContaining(['github.com:443', 'registry.npmjs.org:443', 'pypi.org:443']));
    expect(
      spec({
        context: { coding: false, network: { hosts: ['github.com:443'], registries: ['npm'] } },
      }).hosts,
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
