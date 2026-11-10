import {
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { toolSummary } from '../runner/claude-stream.js';
import type { PendingFork } from '../store/store.js';

// The longest status line kept as a step.
const maxTextLength = 500;

// The session's own chat-explorer tools are how it answers; they are no steps of the answer.
export const isChatExplorerTool = (toolName: string) => /^mcp__.*chat-explorer__/.test(toolName);

export function postToolUseStep(toolName: string, toolInput: Record<string, unknown>) {
  return isChatExplorerTool(toolName) ? null : toolSummary(toolName, toolInput);
}

interface TranscriptLine {
  type?: string;
  isSidechain?: boolean;
  message?: { content?: string | { type: string; text?: string }[] };
}

// The text Claude wrote in the main conversation, in transcript lines added since the last call.
export function assistantTexts(lines: string[]) {
  const texts: string[] = [];
  for (const raw of lines) {
    let line: TranscriptLine;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (line.type !== 'assistant' || line.isSidechain) continue;
    const content = line.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const text = block.type === 'text' ? block.text?.trim() : undefined;
      if (text)
        texts.push(text.length > maxTextLength ? `${text.slice(0, maxTextLength - 1)}…` : text);
    }
  }
  return texts;
}

// Reads the transcript from where the previous call stopped. The first call of a session only
// marks the end, so older text never shows up as steps.
export function readNewTranscriptLines(
  transcriptPath: string,
  offsetsPath: string,
  sessionId: string,
) {
  const offsetPath = join(offsetsPath, `${sessionId}.offset`);
  const size = statSync(transcriptPath).size;
  let offset: number | null = null;
  try {
    offset = Number(readFileSync(offsetPath, 'utf8'));
  } catch {
    offset = null;
  }
  mkdirSync(offsetsPath, { recursive: true });
  if (offset === null || !Number.isFinite(offset) || offset > size) {
    writeFileSync(offsetPath, String(size));
    return [];
  }
  const buffer = Buffer.alloc(size - offset);
  const file = openSync(transcriptPath, 'r');
  try {
    readSync(file, buffer, 0, buffer.length, offset);
  } finally {
    closeSync(file);
  }
  const text = buffer.toString('utf8');
  // A line still being written waits for the next call.
  const complete = text.slice(0, text.lastIndexOf('\n') + 1);
  writeFileSync(offsetPath, String(offset + Buffer.byteLength(complete)));
  return complete.split('\n').filter(Boolean);
}

export function postToolUseOutput(explorationId: string | null, forks: PendingFork[]) {
  if (!explorationId || forks.length === 0) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: [
        `While you were working, the user wrote more in chat-explorer exploration ${explorationId}:`,
        JSON.stringify(forks, null, 2),
        "Take it into account now. Answer it together with what you are doing, with add_message and the fork's inReplyTo above; or answer it at once if it is quick or changes your work, then carry on.",
      ].join('\n'),
    },
  };
}
