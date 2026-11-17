import { toolSummary } from '@chat-explorer/shared/tool-summary.js';
import type { EngineEvent } from './engine.js';

// The parts of Claude Code's stream-json output the runner reads.
interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface StreamUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

type StreamLine =
  | { type: 'system'; subtype: 'init'; session_id: string; model: string }
  | {
      type: 'assistant';
      parent_tool_use_id: string | null;
      message: { model: string; content: ContentBlock[]; usage?: StreamUsage };
    }
  | {
      type: 'result';
      result?: string;
      is_error: boolean;
      modelUsage?: Record<string, { contextWindow?: number }>;
    }
  | { type: 'rate_limit_event'; rate_limit_info: { status: string; resetsAt?: number } }
  // Printed every 30 seconds while a foreground tool call runs.
  | { type: 'tool_progress' }
  | { type: 'other' };

const contextTokensOf = (usage: StreamUsage) =>
  (usage.input_tokens ?? 0) +
  (usage.cache_creation_input_tokens ?? 0) +
  (usage.cache_read_input_tokens ?? 0);

// Turns one line of `claude -p --output-format stream-json --verbose` into runner events. Lines
// from subagents only add activity: their usage is not the fork's context.
export function parseClaudeStreamLine(raw: string): EngineEvent[] {
  let line: StreamLine;
  try {
    line = JSON.parse(raw) as StreamLine;
  } catch {
    return [];
  }
  switch (line.type) {
    case 'system':
      return line.subtype === 'init'
        ? [{ type: 'session', sessionId: line.session_id, model: line.model }]
        : [];
    case 'assistant': {
      const events: EngineEvent[] = [];
      for (const block of line.message.content) {
        if (block.type === 'tool_use' && block.name) {
          events.push({
            type: 'tool',
            name: block.name,
            summary: toolSummary(block.name, block.input),
          });
        }
        if (block.type === 'text' && block.text?.trim() && line.parent_tool_use_id === null) {
          events.push({ type: 'text', text: block.text });
        }
      }
      if (line.message.usage && line.parent_tool_use_id === null) {
        events.push({
          type: 'usage',
          model: line.message.model,
          contextTokens: contextTokensOf(line.message.usage),
        });
      }
      return events;
    }
    case 'result': {
      const windows = Object.values(line.modelUsage ?? {}).map((usage) => usage.contextWindow ?? 0);
      return [
        {
          type: 'turn-finished',
          answer: line.result ?? '',
          failed: line.is_error,
          contextWindow: windows.length > 0 ? Math.max(...windows) : null,
        },
      ];
    }
    case 'tool_progress':
      return [{ type: 'heartbeat' }];
    case 'rate_limit_event':
      return line.rate_limit_info.status === 'allowed'
        ? []
        : [{ type: 'rate-limited', resetsAt: line.rate_limit_info.resetsAt ?? null }];
    default:
      return [];
  }
}

// A user message as `--input-format stream-json` expects it.
export const streamUserMessage = (text: string) =>
  `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;
