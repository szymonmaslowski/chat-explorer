import { onBeforeUnmount } from 'vue';

const idleMs = 1_000;
const maxMs = 5_000;

// Saves 1 s after the last change, at least every 5 s while changes keep coming, and when the
// page goes to the background or closes. Saves and final actions (Save, Cancel, Submit) run one
// at a time in order, so a late save never undoes a final action.
export function useAutosave(save: (keepalive: boolean) => Promise<unknown>) {
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<Result>(operation: () => Promise<Result>) {
    const turn = queue.then(operation);
    queue = turn.catch(() => {});
    return turn;
  }

  function stopTimers() {
    clearTimeout(idleTimer);
    clearTimeout(maxTimer);
    maxTimer = undefined;
  }

  function flush(keepalive = false) {
    stopTimers();
    if (!dirty) return queue;
    dirty = false;
    return enqueue(() => save(keepalive));
  }

  function changed() {
    dirty = true;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void flush(), idleMs);
    maxTimer ??= setTimeout(() => void flush(), maxMs);
  }

  // A final action carries the whole state itself, so a pending save is dropped.
  function finish<Result>(operation: () => Promise<Result>) {
    stopTimers();
    dirty = false;
    return enqueue(operation);
  }

  const onHidden = () => {
    if (document.visibilityState === 'hidden') void flush(true);
  };
  const onPageHide = () => void flush(true);
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', onPageHide);
  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', onHidden);
    window.removeEventListener('pagehide', onPageHide);
    void flush();
  });

  return { changed, flush, finish, isDirty: () => dirty };
}
