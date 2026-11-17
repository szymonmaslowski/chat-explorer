import type { ClaudeModel } from '@chat-explorer/shared/models.js';

// What any engine reports while it works, in the runner's own terms, whatever its wire format.
export type EngineEvent =
  | { type: 'session'; sessionId: string; model: string }
  | { type: 'tool'; name: string; summary: string }
  | { type: 'text'; text: string }
  | { type: 'usage'; model: string; contextTokens: number }
  | { type: 'turn-finished'; answer: string; failed: boolean; contextWindow: number | null }
  | { type: 'rate-limited'; resetsAt: number | null }
  // A tool call is still running; nothing to show, but the turn is not stuck.
  | { type: 'heartbeat' };

export interface EngineRunSpec {
  forkId: string;
  explorationId: string;
  model: ClaudeModel;
  // A new session gets this id; an existing one is resumed.
  sessionId: string;
  resume: boolean;
  // Commands and file writes in the fork's workspace; the runner's config allowed it.
  coding: boolean;
  // Hosts the container may reach besides the model and the tools, as host:port. Checked.
  hosts: string[];
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
  // The fork's allowed hosts changed: new connections follow the new list.
  allowHosts(hosts: string[]): void;
}

export interface Engine {
  start(spec: EngineRunSpec): EngineRun;
  // A single answer without tools or a session, for small jobs like naming a note.
  complete(prompt: string): Promise<string>;
}
