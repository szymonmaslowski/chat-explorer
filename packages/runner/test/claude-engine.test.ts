import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeDockerArguments } from '../src/claude-engine.js';
import { claudeDockerfile, isolatedDockerConfig, newerVersion } from '../src/claude-image.js';
import { toolSummary } from '@chat-explorer/shared/tool-summary.js';
import { parseClaudeStreamLine, streamUserMessage } from '../src/claude-stream.js';
import { egressFolders, openEgressPass } from '../src/egress.js';

const recorded = readFileSync(new URL('./fixtures/claude-stream.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n');

describe('reading Claude Code stream-json', () => {
  it('turns a recorded two-turn run into session, activity, usage and answers', () => {
    const events = recorded.flatMap(parseClaudeStreamLine);
    expect(events[0]).toEqual({
      type: 'session',
      sessionId: '11111111-2222-3333-4444-555555555555',
      model: 'claude-haiku-5-5',
    });
    expect(events.filter((event) => event.type === 'tool')).toEqual([
      expect.objectContaining({ name: 'WebSearch', summary: expect.stringMatching(/^Searching/) }),
      expect.objectContaining({ name: 'WebSearch' }),
    ]);
    const finished = events.filter((event) => event.type === 'turn-finished');
    expect(finished).toHaveLength(2);
    expect(finished[0]).toMatchObject({ failed: false, contextWindow: 1_000_000 });
    expect(finished[1]).toMatchObject({ answer: 'SECOND OK' });
    const usage = events.filter((event) => event.type === 'usage');
    expect(usage.length).toBeGreaterThan(0);
    expect(usage[0]).toEqual({
      type: 'usage',
      model: 'claude-haiku-5-5',
      contextTokens: 2 + 2820 + 1397,
    });
    expect(events.some((event) => event.type === 'rate-limited')).toBe(false);
  });

  it('reports a usage limit that is reached', () => {
    const line = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 1_794_199_800 },
    });
    expect(parseClaudeStreamLine(line)).toEqual([
      { type: 'rate-limited', resetsAt: 1_794_199_800 },
    ]);
  });

  it('ignores lines that are not JSON', () => {
    expect(parseClaudeStreamLine('not json')).toEqual([]);
  });

  it('describes tool calls in plain words', () => {
    expect(toolSummary('Read', { file_path: '/files/abc/report.pdf' })).toBe('Reading report.pdf');
    expect(toolSummary('mcp__chat__add_notes', {})).toBe('Using add notes');
    expect(toolSummary('Bash', { command: 'npm test' })).toBe('Running npm test');
  });

  it('writes a user message as one line of JSON', () => {
    expect(JSON.parse(streamUserMessage('Hi'))).toEqual({
      type: 'user',
      message: { role: 'user', content: 'Hi' },
    });
  });

  it('reads the heartbeat of a running tool call, so a long build is not taken for stuck', () => {
    const line = JSON.stringify({
      type: 'tool_progress',
      tool_name: 'Bash',
      elapsed_time_seconds: 30,
      heartbeat: true,
    });
    expect(parseClaudeStreamLine(line)).toEqual([{ type: 'heartbeat' }]);
  });
});

describe('starting Claude Code in Docker', () => {
  const spec = {
    forkId: 'fork000001',
    explorationId: 'chat000001',
    model: 'sonnet' as const,
    sessionId: 'session-1',
    resume: true,
    coding: false,
    hosts: [],
    systemPrompt: 'Be brief.',
    toolsUrl: 'http://host.docker.internal:4517/api/runner/mcp',
    toolsToken: 'job-token',
  };
  const options = {
    image: () => 'chat-explorer-claude:2.1.319',
    port: 4517,
    forksPath: '/home/me/.chat-explorer/runner/forks',
    workspacesPath: '/home/me/.chat-explorer/workspaces',
    filesPath: '/home/me/.chat-explorer/files',
    egressPath: '/home/me/.chat-explorer/runner/egress',
    codingLimits: { memory: '6g', processes: 1024 },
  };
  const args = claudeDockerArguments(spec, options);

  it('reaches the outside only through the egress proxy, its sign-in kept out of the arguments', () => {
    expect(args).toEqual(expect.arrayContaining(['--network', 'chat-explorer-sandbox']));
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
      expect(args).toEqual(expect.arrayContaining(['--env', name]));
    }
    expect(args.join(' ')).not.toContain('chat-explorer-egress');
  });

  it('runs hardened, with the token from the environment and nothing else of the host', () => {
    expect(args).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', '--rm', '--interactive']));
    expect(args).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(args.join(' ')).not.toContain('sk-ant');
    expect(args).toContain('/home/me/.chat-explorer/files:/home/me/.chat-explorer/files:ro');
    expect(args).toContain(
      '/home/me/.chat-explorer/runner/forks/fork000001/work:/home/me/.chat-explorer/runner/forks/fork000001/work',
    );
  });

  it('resumes the session, takes stream input and reaches only the job tools', () => {
    expect(args).toEqual(expect.arrayContaining(['--resume', 'session-1', '--strict-mcp-config']));
    expect(args).toEqual(expect.arrayContaining(['--input-format', 'stream-json']));
    const mcpConfig = JSON.parse(args[args.indexOf('--mcp-config') + 1]!);
    expect(mcpConfig.mcpServers.chat).toEqual({
      type: 'http',
      url: spec.toolsUrl,
      headers: { Authorization: 'Bearer job-token' },
    });
  });

  it('gives a chat fork only web search and reading its uploads', () => {
    expect(args[args.indexOf('--tools') + 1]).toBe('WebSearch,Read');
    expect(args).not.toContain('Bash');
  });

  it('gives a coding fork its workspace, shell and file tools, and its own sessions folder', () => {
    const coding = claudeDockerArguments(
      { ...spec, forkId: 'fork_0000000002', explorationId: 'chat_0000000002', coding: true },
      options,
    );
    const workspace = '/home/me/.chat-explorer/workspaces/chat_0000000002/fork_0000000002';
    expect(coding).toEqual(
      expect.arrayContaining([
        '--volume',
        `${workspace}:${workspace}`,
        '--workdir',
        workspace,
        '--volume',
        '/home/me/.chat-explorer/runner/forks/fork_0000000002/claude-projects:/home/agent/.claude/projects',
        '--memory',
        '6g',
        '--pids-limit',
        '1024',
      ]),
    );
    expect(coding[coding.indexOf('--tools') + 1]).toBe(
      'Bash,Read,Edit,Write,Glob,Grep,WebSearch,TodoWrite',
    );
    expect(coding.at(-1)).toContain(`Your workspace is ${workspace}`);
    expect(coding).toEqual(expect.arrayContaining(['--env', 'NODE_USE_ENV_PROXY=1']));
    expect(args).not.toContain('NODE_USE_ENV_PROXY=1');
    expect(coding.join(' ')).not.toContain('/home/me/.chat-explorer/runner/config.json');
  });

  it('builds an image at the given Claude Code version with the updater off', () => {
    const dockerfile = claudeDockerfile('2.1.319');
    expect(dockerfile).toMatch(/^FROM node:22-slim@sha256:/);
    expect(dockerfile).toContain('@anthropic-ai/claude-code@2.1.319');
    expect(dockerfile).toContain('DISABLE_AUTOUPDATER=1');
    expect(dockerfile).toMatch(/apt-get install .*\bgit\b.*\bopenssh-client\b/);
    expect(dockerfile.indexOf('apt-get install')).toBeLessThan(dockerfile.indexOf('claude-code@'));
    expect(dockerfile).toContain('chat-explorer.image-recipe="2"');
  });
});

describe('picking the newest Claude Code image', () => {
  it('compares versions by number, not as text', () => {
    expect(newerVersion('2.1.9', '2.1.10')).toBe('2.1.10');
    expect(newerVersion('2.1.321', '2.1.319')).toBe('2.1.321');
    expect(['2.1.317', '2.1.321', '2.1.319'].reduce(newerVersion)).toBe('2.1.321');
  });
});

describe('building the Claude Code image', () => {
  it('uses a Docker config with no credential helper, keeping the CLI plugins', async () => {
    const directory = await isolatedDockerConfig();
    const config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'));
    expect(config).not.toHaveProperty('credsStore');
    expect(config).not.toHaveProperty('credHelpers');
    expect(config.cliPluginsExtraDirs).toEqual([join(homedir(), '.docker', 'cli-plugins')]);
    rmSync(directory, { recursive: true });
  });
});

describe("a container's pass through the egress proxy", () => {
  it('signs in as its fork, follows a changed list, and ends with the container', () => {
    const egressPath = mkdtempSync(join(tmpdir(), 'egress-pass-'));
    const pass = openEgressPass(egressPath, 4517, 'fork_0000000001', ['github.com:443']);
    const file = join(egressFolders(egressPath).policies, 'fork_0000000001.json');
    const policy = () =>
      JSON.parse(readFileSync(file, 'utf8')) as { token: string; hosts: string[] };
    const { token } = policy();
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(policy().hosts).toEqual(['github.com:443']);
    expect(pass.environment.HTTPS_PROXY).toBe(
      `http://fork_0000000001:${token}@chat-explorer-egress-4517:3128`,
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
    pass.allow(['github.com:443', 'registry.npmjs.org:443']);
    expect(policy()).toEqual({ token, hosts: ['github.com:443', 'registry.npmjs.org:443'] });
    expect(readdirSync(egressFolders(egressPath).policies)).toEqual(['fork_0000000001.json']);
    pass.close();
    expect(existsSync(file)).toBe(false);
    rmSync(egressPath, { recursive: true });
  });
});
