import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findTranscript, parseTranscript } from '../src/import/transcript.js';

interface TranscriptLine {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  [key: string]: unknown;
}

function transcript() {
  const records: TranscriptLine[] = [];
  let last: string | null = null;
  let counter = 0;
  const add = (
    record: { type: string; [key: string]: unknown },
    parentUuid: string | null = last,
  ) => {
    const uuid = `u${(counter += 1)}`;
    records.push({ ...record, uuid, parentUuid });
    last = uuid;
    return uuid;
  };
  const builder = {
    user: (content: unknown, extra: object = {}, parent?: string | null) =>
      add({ type: 'user', message: { role: 'user', content }, ...extra }, parent),
    assistant: (content: unknown[], parent?: string | null) =>
      add({ type: 'assistant', message: { role: 'assistant', content } }, parent),
    attachment: (attachment: object) => add({ type: 'attachment', attachment }),
    raw: (record: TranscriptLine) => records.push(record),
    compactBoundary: () =>
      add({ type: 'system', subtype: 'compact_boundary', logicalParentUuid: last }, null),
    text: () => records.map((record) => JSON.stringify(record)).join('\n') + '\n',
  };
  return builder;
}

const text = (value: string) => ({ type: 'text', text: value });

describe('parseTranscript', () => {
  it('keeps typed prompts and assistant text, and drops tool and system noise', () => {
    const t = transcript();
    t.raw({ type: 'permission-mode', permissionMode: 'default' });
    t.user('How do I cache responses?', { promptSource: 'typed' });
    t.assistant([{ type: 'thinking', thinking: '' }]);
    t.assistant([text('Let me check the code.'), { type: 'tool_use', id: 't1', name: 'Read' }]);
    t.user([{ type: 'tool_result', tool_use_id: 't1', content: 'file' }]);
    t.assistant([text('Use a shared cache.')]);
    t.user('<system-reminder>\nnote\n</system-reminder>', { isMeta: true });
    t.user('<local-command-caveat>Caveat</local-command-caveat>', { isMeta: true });
    t.user('<command-name>/model</command-name>\n<command-message>model</command-message>');
    t.user('<local-command-stdout>Set model</local-command-stdout>');
    t.attachment({ type: 'queued_command', prompt: 'And for the CDN?', commandMode: 'prompt' });
    t.attachment({ type: 'skill_listing', content: 'skills' });
    t.user([text('[Request interrupted by user]')]);
    t.user([text('See this'), { type: 'image', source: {} }]);
    t.user('<task-notification>done</task-notification>', {
      origin: { kind: 'task-notification' },
    });
    t.user('Wake up', { promptSource: 'system' });
    t.assistant([text('Purge by tag.')]);
    t.raw({ type: 'ai-title', aiTitle: 'Caching' });

    expect(parseTranscript(t.text())).toEqual({
      title: 'Caching',
      messages: [
        { role: 'user', content: 'How do I cache responses?' },
        { role: 'assistant', content: 'Let me check the code.\n\nUse a shared cache.' },
        { role: 'user', content: 'And for the CDN?' },
        { role: 'user', content: 'See this\n\n[image]' },
        { role: 'assistant', content: 'Purge by tag.' },
      ],
    });
  });

  it('follows the current branch after a rewind', () => {
    const t = transcript();
    const first = t.user('Question');
    t.assistant([text('Old answer')]);
    t.user('Abandoned follow-up');
    t.assistant([text('Abandoned answer')]);
    const rewoundAnswer = t.assistant([text('New answer')], first);
    t.user('Kept follow-up', {}, rewoundAnswer);
    t.assistant([text('Kept answer')]);

    expect(parseTranscript(t.text()).messages.map((message) => message.content)).toEqual([
      'Question',
      'New answer',
      'Kept follow-up',
      'Kept answer',
    ]);
  });

  it('keeps history from before a compaction', () => {
    const t = transcript();
    t.user('Before compact');
    t.assistant([text('Old answer')]);
    t.user('<command-name>/compact</command-name>');
    t.compactBoundary();
    t.user('This session is being continued from a previous conversation...', {
      isCompactSummary: true,
    });
    t.user('After compact');
    t.assistant([text('New answer')]);

    expect(parseTranscript(t.text()).messages.map((message) => message.content)).toEqual([
      'Before compact',
      'Old answer',
      'After compact',
      'New answer',
    ]);
  });

  it('stops at the /explore-chat invocation and skips subagent records', () => {
    const t = transcript();
    t.user('Question');
    t.assistant([text('Answer')]);
    t.user('Subagent prompt', { isSidechain: true });
    t.user(
      '<command-message>chat-explorer:explore-chat</command-message>\n<command-name>/chat-explorer:explore-chat</command-name>',
    );
    t.user([text('Base directory for this skill: ...')], { isMeta: true });
    t.assistant([text('Starting the exploration.'), { type: 'tool_use', id: 't2', name: 'mcp' }]);

    expect(parseTranscript(t.text()).messages).toEqual([
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Answer' },
    ]);
  });

  it('ignores malformed lines', () => {
    const t = transcript();
    t.user('Question');
    expect(parseTranscript(`not json\n${t.text()}`).messages).toEqual([
      { role: 'user', content: 'Question' },
    ]);
  });
});

describe('findTranscript', () => {
  let claudeHome: string;

  afterEach(() => {
    rmSync(claudeHome, { recursive: true, force: true });
  });

  it('finds the transcript of a session in any project', () => {
    claudeHome = mkdtempSync(join(tmpdir(), 'claude-home-'));
    const project = join(claudeHome, 'projects', '-Users-me-project');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'abc-123.jsonl'), '');
    expect(findTranscript('abc-123', claudeHome)).toBe(join(project, 'abc-123.jsonl'));
    expect(findTranscript('missing', claudeHome)).toBeNull();
    expect(findTranscript('../etc', claudeHome)).toBeNull();
  });
});
