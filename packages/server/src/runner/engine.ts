import type { ClaudeModel } from '../shared/models.js';

// What any engine reports while it works, in the runner's own terms, whatever its wire format.
export type EngineEvent =
  | { type: 'session'; sessionId: string; model: string }
  | { type: 'tool'; name: string; summary: string }
  | { type: 'text'; text: string }
  | { type: 'usage'; model: string; contextTokens: number }
  | { type: 'turn-finished'; answer: string; failed: boolean; contextWindow: number | null }
  | { type: 'rate-limited'; resetsAt: number | null };

export interface EngineRunSpec {
  forkId: string;
  model: ClaudeModel;
  // A new session gets this id; an existing one is resumed.
  sessionId: string;
  resume: boolean;
  systemPrompt: string;
  // Job-scoped tools the engine reaches over MCP.
  toolsUrl: string;
  toolsToken: string;
}

// One live engine process for one fork. Messages can be sent while it works; it reads them at its
// next step.
export interface EngineRun {
  send(text: string): void;
  onEvent(listener: (event: EngineEvent) => void): void;
  onExit(listener: (result: { code: number | null; error?: string }) => void): void;
  stop(options?: { immediately?: boolean }): void;
}

export interface Engine {
  start(spec: EngineRunSpec): EngineRun;
  // A single answer without tools or a session, for small jobs like naming a note.
  complete(prompt: string): Promise<string>;
}
