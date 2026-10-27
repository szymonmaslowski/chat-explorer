import { createDaemonClient } from '../client/http.js';
import type { Config } from '../config.js';
import { probe } from '../daemon/control.js';
import type { Exploration } from '../shared/types.js';
import { postCompactOutput } from './post-compact.js';

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

// Hooks run inside the user's Claude session, so they never start the daemon and never fail.
export async function runHook(name: string, config: Config) {
  if (name !== 'post-compact') return;
  try {
    const input: { session_id?: string } = JSON.parse(await readStdin());
    if (!input.session_id) return;
    if ((await probe(config.baseUrl)).state !== 'running') return;
    const request = createDaemonClient(config.baseUrl);
    const { exploration } = await request<{ exploration: Exploration | null }>(
      `/api/internal/sessions/${encodeURIComponent(input.session_id)}/exploration`,
    );
    const output = postCompactOutput(exploration);
    if (output) process.stdout.write(JSON.stringify(output));
  } catch {
    // A broken hook must not interrupt the session.
  }
}
