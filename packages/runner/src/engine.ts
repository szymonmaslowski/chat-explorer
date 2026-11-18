import type { ClaudeModel } from '@chat-explorer/shared/models.js';
import type { Credential } from './access-config.js';

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

// What a container may reach through the proxy besides the model and the tools, as host:port,
// checked against the runner's config.
export interface HostPolicy {
  hosts: string[];
  // Allowed to resolve to an address on the user's own network.
  privateHosts: string[];
  // Masked in the proxy's logs: every hidden host of the runner's config, picked or not.
  hiddenHosts: string[];
}

export const noHosts: HostPolicy = { hosts: [], privateHosts: [], hiddenHosts: [] };

export interface EngineRunSpec {
  forkId: string;
  explorationId: string;
  model: ClaudeModel;
  // A new session gets this id; an existing one is resumed.
  sessionId: string;
  resume: boolean;
  // Commands and file writes in the fork's workspace; the runner's config allowed it.
  coding: boolean;
  network: HostPolicy;
  // Credentials of the runner's config the fork picked, for a coding container only.
  credentials: Credential[];
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
  allowHosts(network: HostPolicy): void;
}

export interface Engine {
  start(spec: EngineRunSpec): EngineRun;
  // A single answer without tools or a session, for small jobs like naming a note.
  complete(prompt: string): Promise<string>;
}
