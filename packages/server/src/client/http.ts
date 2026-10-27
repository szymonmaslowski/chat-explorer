export class DaemonError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
  }
}

export function createDaemonClient(baseUrl: string) {
  return async function request<Result>(
    path: string,
    init: { method?: string; json?: object; signal?: AbortSignal } = {},
  ): Promise<Result> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: init.method ?? (init.json ? 'POST' : 'GET'),
      headers: init.json ? { 'content-type': 'application/json' } : {},
      body: init.json ? JSON.stringify(init.json) : null,
      signal: init.signal ?? null,
    });
    const body: { error?: string; message?: string } = await response.json();
    if (!response.ok) {
      throw new DaemonError(
        body.error ?? 'error',
        body.message ?? response.statusText,
        response.status,
      );
    }
    return body as Result;
  };
}

export type DaemonClient = ReturnType<typeof createDaemonClient>;
