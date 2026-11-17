// The daemon could not be started or stopped; the message says why, for the user.
export class DaemonStartError extends Error {}

// Whether the daemon answers at its address, and which version it is.
export interface Health {
  name: 'chat-explorer';
  version: string;
  apiVersion: number;
  pid: number;
}

export type Probe =
  { state: 'running'; health: Health } | { state: 'stopped' } | { state: 'foreign' };

export async function probe(baseUrl: string): Promise<Probe> {
  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
    const body: Partial<Health> = await response.json();
    return body.name === 'chat-explorer'
      ? { state: 'running', health: body as Health }
      : { state: 'foreign' };
  } catch (error) {
    return isConnectionRefused(error) ? { state: 'stopped' } : { state: 'foreign' };
  }
}

function isConnectionRefused(error: unknown) {
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof Error && 'code' in cause && cause.code === 'ECONNREFUSED';
}
