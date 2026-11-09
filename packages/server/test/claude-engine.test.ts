import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { claudeDockerArguments } from '../src/runner/claude-engine.js';
import { claudeDockerfile } from '../src/runner/claude-image.js';
import {
  parseClaudeStreamLine,
  streamUserMessage,
  toolSummary,
} from '../src/runner/claude-stream.js';

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
});

describe('starting Claude Code in Docker', () => {
  const spec = {
    forkId: 'fork000001',
    model: 'sonnet' as const,
    sessionId: 'session-1',
    resume: true,
    systemPrompt: 'Be brief.',
    toolsUrl: 'http://host.docker.internal:4517/api/runner/mcp',
    toolsToken: 'job-token',
  };
  const args = claudeDockerArguments(spec, {
    image: 'chat-explorer-claude:2.1.319',
    forksPath: '/home/me/.chat-explorer/runner/forks',
    filesPath: '/home/me/.chat-explorer/files',
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

  it('builds an image at the given Claude Code version with the updater off', () => {
    const dockerfile = claudeDockerfile('2.1.319');
    expect(dockerfile).toMatch(/^FROM node:22-slim@sha256:/);
    expect(dockerfile).toContain('@anthropic-ai/claude-code@2.1.319');
    expect(dockerfile).toContain('DISABLE_AUTOUPDATER=1');
  });
});
