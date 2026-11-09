import type { Activity, ActivityKind } from '../shared/types.js';
import type { Lease, PendingMessage, RunUsage } from '../store/runs.js';
import type { RunContext } from '../store/run-context.js';

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export class StaleLeaseError extends Error {}

export class RunnerApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// The runner's side of the runner API: everything it tells the backend goes through here.
export class RunnerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly machineToken: string,
    private readonly fetch: Fetch = globalThis.fetch,
  ) {}

  async claim(runnerId: string, waitMs: number, signal?: AbortSignal) {
    const { lease } = await this.post<{ lease: Lease | null }>(
      '/api/runner/claim',
      { runnerId, waitMs },
      signal,
    );
    return lease;
  }

  async noteTopics(waitMs: number, signal?: AbortSignal) {
    const { notes } = await this.post<{ notes: { noteId: string; description: string }[] }>(
      '/api/runner/note-topics',
      { waitMs },
      signal,
    );
    return notes;
  }

  setNoteTopic(noteId: string, topic: string) {
    return this.post(`/api/runner/notes/${noteId}/topic`, { topic });
  }

  heartbeat(lease: Lease) {
    return this.fork(lease, 'heartbeat', {});
  }

  context(lease: Lease, resume: boolean) {
    return this.fork<RunContext>(lease, 'context', { resume });
  }

  // New messages of the fork, after `after`, the newest one the engine already has.
  // `others` is what changed in the chat's other forks since the engine last heard.
  input(lease: Lease, options: { waitMs: number; after: string | null }, signal?: AbortSignal) {
    return this.fork<{ messages: PendingMessage[]; others: string | null }>(
      lease,
      'input',
      { waitMs: options.waitMs, after: options.after ?? undefined },
      signal,
    );
  }

  startTurn(lease: Lease) {
    return this.fork(lease, 'turn/start', {});
  }

  finishTurn(lease: Lease, upToMessageId: string) {
    return this.fork(lease, 'turn/finish', { upToMessageId });
  }

  answer(lease: Lease, content: string) {
    return this.fork(lease, 'answer', { content });
  }

  activity(lease: Lease, activity: { afterMessageId: string; kind: ActivityKind; text: string }) {
    return this.fork<Activity>(lease, 'activity', activity);
  }

  session(lease: Lease, sessionId: string) {
    return this.fork(lease, 'session', { sessionId });
  }

  usage(lease: Lease, usage: RunUsage) {
    return this.fork(lease, 'usage', usage);
  }

  waiting(lease: Lease, until: string) {
    return this.fork(lease, 'waiting', { until });
  }

  release(lease: Lease) {
    return this.fork(lease, 'release', {});
  }

  fail(lease: Lease, reason: string) {
    return this.fork(lease, 'fail', { reason });
  }

  private fork<Result = unknown>(
    lease: Lease,
    path: string,
    body: object,
    signal?: AbortSignal,
  ): Promise<Result> {
    return this.post<Result>(
      `/api/runner/forks/${lease.forkId}/${path}`,
      { leaseId: lease.leaseId, ...body },
      signal,
    );
  }

  private async post<Result>(path: string, body: object, signal?: AbortSignal): Promise<Result> {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.machineToken}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    const payload = (await response.json()) as { error?: string; message?: string };
    if (response.ok) return payload as Result;
    if (payload.error === 'stale_lease') throw new StaleLeaseError(payload.message);
    throw new RunnerApiError(
      response.status,
      payload.message ?? `Request failed: ${response.status}`,
    );
  }
}
