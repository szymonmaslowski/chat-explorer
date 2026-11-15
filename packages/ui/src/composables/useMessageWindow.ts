import type { Fork, Message, MessageHead } from '@shared/types';
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef, watch, type Ref } from 'vue';
import { withBody } from '../lib/conversation';
import { isUnread } from '../lib/read-state';
import { keepSameList } from '../lib/stable';
import { loadBodies, type ExplorationState } from '../stores/exploration';

const firstCount = 40;
const batchCount = 40;
// Older messages load while the reader is this many screens away from them.
const screensAhead = 5;
// A batch goes in only once scrolling has stopped: moving the page during a momentum glide stops
// the glide in Safari.
const scrollIdleMs = 150;

// Where each fork's window started, so coming back to a fork shows the same messages and the
// browser's saved scroll position still fits.
const firstShownByFork = new Map<string, string>();

// True once the fork shown has the texts of its window, for the router to scroll in it.
const windowReady = ref(false);
// A fork that does not exist never gets ready.
const readyWaitMs = 10_000;
export function whenWindowReady() {
  return new Promise<void>((resolve) => {
    if (windowReady.value) return resolve();
    const done = () => {
      stop();
      clearTimeout(timer);
      void nextTick(resolve);
    };
    const stop = watch(windowReady, (ready) => ready && done());
    const timer = setTimeout(done, readyWaitMs);
  });
}

let lastScrollAt = 0;
const noteScroll = () => (lastScrollAt = Date.now());
window.addEventListener('scroll', noteScroll, { passive: true });

// Waits until the page has not scrolled for a moment, counted from now: a smooth scroll that is
// about to start, such as to a linked message, would be cut short by the correction.
function scrollIdle() {
  const since = Date.now();
  return new Promise<void>((resolve) => {
    const check = () => {
      const quietFor = Date.now() - Math.max(lastScrollAt, since);
      if (quietFor >= scrollIdleMs) resolve();
      else setTimeout(check, scrollIdleMs - quietFor);
    };
    setTimeout(check, scrollIdleMs);
  });
}

// The messages of a fork the page shows: the newest ones first, then older batches as the reader
// scrolls up, or everything up to a message a link points at. The texts load with each batch.
export function useMessageWindow(input: {
  state: Ref<ExplorationState>;
  fork: Ref<Fork | null>;
  path: Ref<MessageHead[]>;
  // The template ref of an element just above the first message shown.
  sentinelRef: string;
}) {
  const start = ref(0);
  const ready = ref(false);
  const loadingOlder = ref(false);
  const ids = (messages: MessageHead[]) => messages.map((message) => message.id);

  async function open(forkId: string) {
    ready.value = windowReady.value = false;
    const path = input.path.value;
    const remembered = path.findIndex((message) => message.id === firstShownByFork.get(forkId));
    const firstUnread = path.findIndex(isUnread);
    let first = remembered !== -1 ? remembered : Math.max(0, path.length - firstCount);
    if (firstUnread !== -1) first = Math.min(first, firstUnread);
    start.value = first;
    await loadBodies(input.state.value, ids(path.slice(first))).catch(() => {});
    if (input.fork.value?.id !== forkId) return;
    ready.value = windowReady.value = true;
  }

  watch(
    () => [input.fork.value?.id, input.state.value.status === 'ready'] as const,
    ([forkId, loaded]) => {
      if (forkId && loaded) void open(forkId);
    },
    { immediate: true },
  );
  onBeforeUnmount(() => (windowReady.value = false));

  watch(start, (first) => {
    const forkId = input.fork.value?.id;
    const message = input.path.value[first];
    if (forkId && message) firstShownByFork.set(forkId, message.id);
  });

  const shown = computed(() => (ready.value ? input.path.value.slice(start.value) : []));
  // A message whose text is still on its way, after a reload, waits for it.
  watch(shown, (messages) => {
    const missing = messages.filter((message) => !input.state.value.bodies.has(message.id));
    if (missing.length > 0) void loadBodies(input.state.value, ids(missing)).catch(() => {});
  });
  const messages = computed<Message[]>((previous) =>
    keepSameList(
      previous,
      shown.value.flatMap((head) => {
        const content = input.state.value.bodies.get(head.id);
        return content === undefined ? [] : [withBody(head, content)];
      }),
    ),
  );

  // Moves the start, keeping the first message shown where it is on screen.
  async function showFrom(first: number) {
    const anchor = shown.value[0] && document.getElementById(`m-${shown.value[0].id}`);
    const before = anchor?.getBoundingClientRect().top ?? 0;
    start.value = first;
    await nextTick();
    if (anchor?.isConnected) window.scrollBy(0, anchor.getBoundingClientRect().top - before);
  }

  async function loadOlder() {
    if (!ready.value || loadingOlder.value || start.value === 0) return;
    loadingOlder.value = true;
    try {
      const first = Math.max(0, start.value - batchCount);
      await loadBodies(input.state.value, ids(input.path.value.slice(first, start.value)));
      await scrollIdle();
      await showFrom(first);
    } finally {
      loadingOlder.value = false;
    }
  }

  // Shows everything from this message on, for a link to it. The link then scrolls to it, so the
  // place is not kept: a correction would cut that scroll short.
  async function reveal(messageId: string) {
    const index = input.path.value.findIndex((message) => message.id === messageId);
    if (!ready.value || index === -1 || index >= start.value) return;
    await loadBodies(input.state.value, ids(input.path.value.slice(index, start.value)));
    start.value = index;
  }

  // Watches the space above the first message shown, from several screens away.
  const sentinel = useTemplateRef<HTMLElement>(input.sentinelRef);
  let observer: IntersectionObserver | null = null;
  watch(sentinel, (element, previous) => {
    if (previous) observer?.unobserve(previous);
    if (!element) return;
    observer ??= new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        void loadOlder().then(() => {
          // Seen again, the space reports whether it is still near, after the batch went in.
          if (!sentinel.value) return;
          observer?.unobserve(sentinel.value);
          observer?.observe(sentinel.value);
        });
      },
      { rootMargin: `${screensAhead * window.innerHeight}px 0px 0px 0px` },
    );
    observer.observe(element);
  });
  onBeforeUnmount(() => observer?.disconnect());

  return { start, ready, messages, reveal, hasOlder: computed(() => start.value > 0) };
}
