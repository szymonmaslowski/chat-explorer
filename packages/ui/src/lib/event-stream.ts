const firstRetryMs = 1_000;
const maxRetryMs = 30_000;

// A server event stream that stays open. EventSource retries a dropped connection by itself, but
// gives up for good when an answer is not an event stream, such as the proxy's 502 while the
// daemon restarts. Then a new one is opened, later each time, and at once when the page shows
// again. Every (re)connect sends `ready`, after which the page reloads what it shows, so events
// missed while disconnected are never replayed.
export function openEventStream(input: {
  url: string;
  onReady: () => void | Promise<void>;
  onError: () => void;
  events: Record<string, (data: string) => void>;
}) {
  let source: EventSource;
  let retryMs = firstRetryMs;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const reconnect = () => {
    clearTimeout(retryTimer);
    if (closed || source.readyState !== EventSource.CLOSED) return;
    source = connect();
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') reconnect();
  };
  document.addEventListener('visibilitychange', onVisible);

  function connect() {
    const next = new EventSource(input.url);
    next.addEventListener('ready', () => {
      retryMs = firstRetryMs;
      void input.onReady();
    });
    next.addEventListener('error', () => {
      input.onError();
      if (next.readyState !== EventSource.CLOSED) return;
      retryTimer = setTimeout(reconnect, retryMs);
      retryMs = Math.min(retryMs * 2, maxRetryMs);
    });
    for (const [type, handle] of Object.entries(input.events)) {
      next.addEventListener(type, (message) => handle((message as MessageEvent<string>).data));
    }
    return next;
  }

  function close() {
    closed = true;
    clearTimeout(retryTimer);
    document.removeEventListener('visibilitychange', onVisible);
    source.close();
  }

  source = connect();
  return { close };
}
