import { execFile } from 'node:child_process';
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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Lease, RunContext } from '@chat-explorer/shared/protocol.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claudeDockerArguments, containerArguments, forkFolders } from '../src/claude-engine.js';
import { newestBuiltImage } from '../src/claude-image.js';
import { egressContainer, ensureEgress } from '../src/egress.js';
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
  network: { hosts: [], registries: false },
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
  codingLimits: defaultCodingLimits,
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
    codingLimits: defaultCodingLimits,
  };
  const own = spec({ lease: { forkId: 'fork_00000000a1' } });
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
  await ensureEgress(image, dockerPort);
  const probe = readFileSync(new URL('./fixtures/container-probe.cjs', import.meta.url), 'utf8');
  const probePaths = {
    runnerConfig: runnerConfigPath(runnerPath),
    otherWorkspace: otherFolders.work,
    ownWorkspace: ownFolders.work,
    otherSessions: otherFolders.sessions,
  };
  const { stdout } = await run(
    'docker',
    [...containerArguments(own, paths), 'node', '-e', probe, JSON.stringify(probePaths)],
    { timeout: 60_000 },
  );
  return { results: JSON.parse(stdout), root, ownFolders, otherFolders };
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

    it('reaches the model through the proxy, so the refusals below are the rules at work', () => {
      expect(probed.results.modelThroughProxy).toBe(200);
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
      network: 'host',
      image: 'attacker/image',
    };
    const built = spec({ lease: smuggled, context: smuggled });
    expect(Object.keys(built).sort()).toEqual([
      'coding',
      'explorationId',
      'forkId',
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

  it.todo('7. the dummy model token works only from its own container, and dies with it');
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

  it('refuses a model or a coding switch it does not know', () => {
    expect(() => spec({ context: { model: 'gpt' } })).toThrow('does not know the model gpt');
    expect(() => spec({ context: { coding: 'yes' } })).toThrow('The coding switch is not valid.');
  });

  it('accepts ids from before the prefixes', () => {
    expect(spec({ lease: { forkId: '0000000001' } }).forkId).toBe('0000000001');
  });
});
