import type { Fork, Message } from '@shared/types';
import { onBeforeUnmount, reactive, watch, type Ref } from 'vue';
import { isUnread } from '../lib/read-state';
import { visibleArea } from '../lib/reading-line';
import type { ExplorationState } from '../stores/exploration';
import { markRead, markUnreadFrom } from '../stores/read-state';

const seenAfterMs = 3_000;
const checkEveryMs = 500;
// How much of an answer's start has to be on screen for it to count as being looked at.
const visibleStartPx = 40;

const elementOf = (message: Message) => document.getElementById(`m-${message.id}`);

function startIsVisible(element: HTMLElement) {
  const { top, bottom } = visibleArea();
  const box = element.getBoundingClientRect();
  return box.top >= top - 1 && box.top <= bottom - visibleStartPx;
}

// An answer counts as seen once its start has been on screen for a few seconds, so a fork opened
// by mistake and left at once stays unread. Answers that were new when the fork was opened, or
// arrived while it is open, keep their mark until the reader leaves the fork. Opening the fork
// at its first unread answer is the router's job.
export function useReadTracking(input: {
  state: Ref<ExplorationState>;
  fork: Ref<Fork | null>;
  path: Ref<Message[]>;
}) {
  const newIds = reactive(new Set<string>());
  // Marking an answer unread by hand while it is on screen would otherwise undo itself.
  let paused = false;
  const visibleSince = new Map<string, number>();

  watch(
    () => input.fork.value?.id,
    () => {
      newIds.clear();
      visibleSince.clear();
      paused = false;
    },
  );

  const keepNewMarks = () => {
    for (const message of input.path.value) if (isUnread(message)) newIds.add(message.id);
  };
  watch(input.path, keepNewMarks, { immediate: true });

  function check() {
    if (paused || document.visibilityState !== 'visible') return;
    const now = Date.now();
    const seen: string[] = [];
    for (const message of input.path.value.filter(isUnread)) {
      const element = elementOf(message);
      if (!element || !startIsVisible(element)) {
        visibleSince.delete(message.id);
        continue;
      }
      const since = visibleSince.get(message.id) ?? now;
      visibleSince.set(message.id, since);
      if (now - since >= seenAfterMs) seen.push(message.id);
    }
    if (seen.length > 0) markRead(input.state.value, seen);
  }

  const timer = setInterval(check, checkEveryMs);
  onBeforeUnmount(() => clearInterval(timer));

  async function markUnread(messageId: string) {
    const fork = input.fork.value;
    if (!fork) return;
    paused = true;
    await markUnreadFrom(input.state.value, messageId, fork.id);
    keepNewMarks();
  }

  return { newIds, markUnread };
}
