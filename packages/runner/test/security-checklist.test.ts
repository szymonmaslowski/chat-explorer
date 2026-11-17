import type { Lease, RunContext } from '@chat-explorer/shared/protocol.js';
import { describe, expect, it } from 'vitest';
import { claudeDockerArguments } from '../src/claude-engine.js';
import { checkedRunSpec, RunRefusedError } from '../src/run-spec.js';

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
  systemPrompt: 'Be brief.',
  history: null,
};
const allowed = { path: '/runner/config.json', coding: { enabled: true } };
const notAllowed = { ...allowed, coding: { enabled: false } };
const sessionId = '11111111-2222-3333-4444-555555555555';
const toolsUrl = 'http://host.docker.internal:4517/api/tools/mcp';
const engineOptions = {
  image: () => 'chat-explorer-claude:2.1.325',
  port: 4517,
  forksPath: '/runner/forks',
  workspacesPath: '/workspaces',
  filesPath: '/files',
};

const spec = (overrides: { lease?: object; context?: object; config?: typeof allowed } = {}) =>
  checkedRunSpec({
    lease: { ...lease, ...overrides.lease },
    context: { ...context, ...overrides.context },
    sessionId,
    toolsUrl,
    config: overrides.config ?? allowed,
  });

// The security acceptance checklist for coding forks, from the note "Coding forks: tools,
// workspace, brokered actions". Written before the coding profile, run after each build step, and
// kept as regression tests so later changes cannot quietly weaken the container.
describe('coding forks: security acceptance checklist', () => {
  it.todo('1. a LAN address and the cloud metadata address are unreachable from a container');
  it.todo('2. a host that is not allowed is unreachable, and DNS does not resolve names inside');
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

  it.todo("6. a container cannot read the runner config or other forks' workspaces");
  it.todo('7. the dummy model token works only from its own container, and dies with it');
  it.todo("8. the runner's size check and host-side reads do not follow symlinks out");
  it.todo('9. a container cannot write the session folders of other forks');
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
