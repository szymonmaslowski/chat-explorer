import { join } from 'node:path';
import { createDaemonClient } from '../client/http.js';
import type { Config } from '../config.js';
import { probe } from '../daemon/control.js';
import type { Exploration } from '../shared/types.js';
import type { PendingFork } from '../store/store.js';
import { postCompactOutput } from './post-compact.js';
import {
  assistantTexts,
  postToolUseOutput,
  postToolUseStep,
  readNewTranscriptLines,
} from './post-tool-use.js';

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

// Hooks run inside the user's Claude session, so they never start the daemon and never fail.
export async function runHook(name: string, config: Config) {
  if (name !== 'post-compact' && name !== 'post-tool-use') return;
  try {
    const input: HookInput = JSON.parse(await readStdin());
    if (!input.session_id) return;
    if ((await probe(config.baseUrl)).state !== 'running') return;
    const request = createDaemonClient(config.baseUrl);
    const output =
      name === 'post-compact'
        ? await postCompact(request, input.session_id)
        : await postToolUse(request, input, config);
    if (output) process.stdout.write(JSON.stringify(output));
  } catch {
    // A broken hook must not interrupt the session.
  }
}

type DaemonRequest = ReturnType<typeof createDaemonClient>;

async function postCompact(request: DaemonRequest, sessionId: string) {
  const { exploration } = await request<{ exploration: Exploration | null }>(
    `/api/internal/sessions/${encodeURIComponent(sessionId)}/exploration`,
  );
  return postCompactOutput(exploration);
}

async function postToolUse(request: DaemonRequest, input: HookInput, config: Config) {
  const sessionId = input.session_id!;
  const lines = input.transcript_path
    ? readNewTranscriptLines(input.transcript_path, join(config.home, 'hooks'), sessionId)
    : [];
  const { explorationId, forks } = await request<{
    explorationId: string | null;
    forks: PendingFork[];
  }>(`/api/internal/sessions/${encodeURIComponent(sessionId)}/steps`, {
    json: {
      texts: assistantTexts(lines),
      tool: postToolUseStep(input.tool_name ?? '', input.tool_input ?? {}),
    },
  });
  return postToolUseOutput(explorationId, forks);
}
