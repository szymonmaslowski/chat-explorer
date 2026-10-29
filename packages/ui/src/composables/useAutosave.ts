import { onBeforeUnmount } from 'vue';

const idleMs = 1_000;
const maxMs = 5_000;

// Saves 1 s after the last change, at least every 5 s while changes keep coming, and when the
// page goes to the background or closes. Saves go into the outbox, which sends everything in
// the order it was made.
export function useAutosave(save: () => void) {
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;

  function stopTimers() {
    clearTimeout(idleTimer);
    clearTimeout(maxTimer);
    maxTimer = undefined;
  }

  function flush() {
    stopTimers();
    if (!dirty) return;
    dirty = false;
    save();
  }

  function changed() {
    dirty = true;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(flush, idleMs);
    maxTimer ??= setTimeout(flush, maxMs);
  }

  // A final action (Save, Cancel, Submit) carries the whole state itself, so a pending save is
  // dropped.
  function finish(action: () => void) {
    stopTimers();
    dirty = false;
    action();
  }

  const onHidden = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', flush);
  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', onHidden);
    window.removeEventListener('pagehide', flush);
    flush();
  });

  return { changed, flush, finish, isDirty: () => dirty };
}
