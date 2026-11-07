import { createRouter, createWebHistory } from 'vue-router';
import { scrollTopAtStartOf } from './lib/reading-line';
import { whenActiveExplorationLoaded } from './stores/exploration';
import ExplorationsList from './views/ExplorationsList.vue';
import ForkMap from './views/ForkMap.vue';
import ForkView from './views/ForkView.vue';
import NotesView from './views/NotesView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: ExplorationsList },
    { path: '/archived', component: ExplorationsList, props: { archived: true } },
    { path: '/e/:explorationId', component: ForkView, props: true, meta: { opensAtEnd: true } },
    {
      path: '/e/:explorationId/f/:forkId',
      component: ForkView,
      props: true,
      meta: { opensAtEnd: true },
    },
    {
      path: '/e/:explorationId/map',
      component: ForkMap,
      props: (route) => ({
        explorationId: route.params.explorationId,
        currentForkId: route.query.from,
      }),
    },
    { path: '/e/:explorationId/notes', component: NotesView, props: true },
  ],
  async scrollBehavior(to, from, savedPosition) {
    if (savedPosition) {
      await whenActiveExplorationLoaded();
      return savedPosition;
    }
    // Views scroll to `#m-`, `#c-` and `#n-` targets themselves once the content has rendered.
    if (to.hash || to.path === from.path) return false;
    if (!to.meta.opensAtEnd) return { top: 0 };
    await whenActiveExplorationLoaded();
    const firstUnread = document.querySelector<HTMLElement>('.message[data-unread]');
    const target = firstUnread
      ? () => scrollTopAtStartOf(firstUnread)
      : () => document.documentElement.scrollHeight;
    holdScroll(target);
    return { top: target() };
  },
});

const settleMs = 1_500;
const readerScrollEvents = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const;

// Comment cards, images and fonts still change the page's height after the first render, so the
// page keeps scrolling to its target until it settles or the reader scrolls.
function holdScroll(target: () => number) {
  const observer = new ResizeObserver(() => window.scrollTo({ top: target() }));
  const release = () => {
    observer.disconnect();
    clearTimeout(timer);
    for (const type of readerScrollEvents) window.removeEventListener(type, release);
  };
  const timer = setTimeout(release, settleMs);
  for (const type of readerScrollEvents) window.addEventListener(type, release, { passive: true });
  observer.observe(document.body);
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

window.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
  if (event.key === '[') router.back();
  if (event.key === ']') router.forward();
});
