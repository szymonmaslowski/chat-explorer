import type { EventBus } from './event-bus.js';

// Resolves with the first truthy result of `check`, tried now and after every event, or with null
// once `waitMs` has passed or the request was aborted.
export function waitUntil<Result>(
  bus: EventBus,
  check: () => Result | null,
  waitMs: number,
  signal?: AbortSignal,
): Promise<Result | null> {
  const immediate = check();
  if (immediate !== null) return Promise.resolve(immediate);
  return new Promise((resolve) => {
    const finish = (result: Result | null) => {
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => finish(null);
    const timer = setTimeout(() => finish(null), waitMs);
    // Deferred, so the check sees the change after every subscriber has handled the event.
    const unsubscribe = bus.subscribe(() =>
      queueMicrotask(() => {
        const result = check();
        if (result !== null) finish(result);
      }),
    );
    signal?.addEventListener('abort', onAbort);
  });
}
