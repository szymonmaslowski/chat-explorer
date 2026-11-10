import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assistantTexts,
  postToolUseOutput,
  postToolUseStep,
  readNewTranscriptLines,
} from '../src/hooks/post-tool-use.js';
import { createTestApp, seedConversation } from './helpers.js';

const assistantLine = (text: string, isSidechain = false) =>
  JSON.stringify({
    type: 'assistant',
    isSidechain,
    message: { content: [{ type: 'text', text }] },
  });

describe('the post-tool-use hook', () => {
  it("describes a tool call, but not the session's own chat-explorer tools", () => {
    expect(postToolUseStep('Bash', { command: 'pnpm test' })).toBe('Running pnpm test');
    expect(postToolUseStep('mcp__plugin_chat-explorer_chat-explorer__add_message', {})).toBeNull();
  });

  it('keeps the text Claude wrote in the main conversation', () => {
    const lines = [
      assistantLine('Found the cause.'),
      assistantLine('A subagent talking', true),
      JSON.stringify({ type: 'user', message: { content: 'tool result' } }),
      'not json',
    ];
    expect(assistantTexts(lines)).toEqual(['Found the cause.']);
  });

  it('reads only the transcript lines added since the last call', () => {
    const folder = mkdtempSync(join(tmpdir(), 'chat-explorer-hook-'));
    const transcript = join(folder, 'session.jsonl');
    writeFileSync(transcript, `${assistantLine('Old')}\n`);
    expect(readNewTranscriptLines(transcript, folder, 's1')).toEqual([]);

    appendFileSync(transcript, `${assistantLine('New')}\n${assistantLine('Half')}`);
    expect(assistantTexts(readNewTranscriptLines(transcript, folder, 's1'))).toEqual(['New']);
    appendFileSync(transcript, '\n');
    expect(assistantTexts(readNewTranscriptLines(transcript, folder, 's1'))).toEqual(['Half']);
  });

  it('hands Claude the messages that arrived, and nothing when none did', () => {
    const fork = {
      forkId: 'f1',
      parentForkId: null,
      isNewFork: false,
      baseMessageId: null,
      inReplyTo: 'm2',
      userMessages: [{ id: 'm2', text: 'Also the tests' }],
      repliesTo: null,
    };
    const context = postToolUseOutput('abc', [fork])?.hookSpecificOutput.additionalContext;
    expect(context).toContain('exploration abc');
    expect(context).toContain('Also the tests');
    expect(postToolUseOutput('abc', [])).toBeNull();
    expect(postToolUseOutput(null, [])).toBeNull();
  });
});

describe('steps of an attached terminal session', () => {
  function setup() {
    const context = createTestApp({ sessionLeases: true });
    const conversation = seedConversation(context.store);
    context.store.attach({
      explorationId: conversation.explorationId,
      shimId: 'shim-a',
      sessionId: 'session-a',
      takeover: false,
    });
    const step = async (json: object) =>
      (
        await context.request('/api/internal/sessions/session-a/steps', { method: 'POST', json })
      ).json();
    return { ...context, ...conversation, step };
  }

  it('become activity of the fork it answers', async () => {
    const { store, hub, step, explorationId, mainForkId } = setup();
    store.submit(explorationId, mainForkId, 'Fix the build');
    await hub.waitForFeedback({ explorationId, shimId: 'shim-a', waitMs: 10 });

    expect(await step({ texts: ['Found the cause.'], tool: 'Running pnpm test' })).toEqual({
      explorationId,
      forks: [],
    });
    expect(store.snapshot(explorationId).activities.map((activity) => activity.text)).toEqual([
      'Found the cause.',
      'Running pnpm test',
    ]);
  });

  it('bring back a message the user sent meanwhile, once', async () => {
    const { store, hub, step, explorationId, mainForkId } = setup();
    store.submit(explorationId, mainForkId, 'Fix the build');
    await hub.waitForFeedback({ explorationId, shimId: 'shim-a', waitMs: 10 });

    store.submit(explorationId, mainForkId, 'Also the tests');
    const { forks } = await step({ tool: 'Editing App.vue' });
    expect(forks).toMatchObject([
      { forkId: mainForkId, userMessages: [{ text: 'Fix the build' }, { text: 'Also the tests' }] },
    ]);
    expect((await step({ tool: 'Running pnpm test' })).forks).toEqual([]);
  });

  it('are ignored for a session that is not attached', async () => {
    const { request } = setup();
    const response = await request('/api/internal/sessions/other/steps', {
      method: 'POST',
      json: { tool: 'Running ls' },
    });
    expect(await response.json()).toEqual({ explorationId: null, forks: [] });
  });
});
