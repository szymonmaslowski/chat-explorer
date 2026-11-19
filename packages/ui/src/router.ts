import { withPrefix } from '@shared/ids';
import { createRouter, createWebHistory } from 'vue-router';
import { scrollTopAtStartOf } from './lib/reading-line';
import { whenWindowReady } from './composables/useMessageWindow';
import { whenActiveExplorationLoaded } from './stores/exploration';
import ExplorationsList from './views/ExplorationsList.vue';
import ForkMap from './views/ForkMap.vue';
import ForkView from './views/ForkView.vue';
import NotesView from './views/NotesView.vue';
import SettingsView from './views/SettingsView.vue';

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
    { path: '/e/:explorationId/settings', component: SettingsView, props: true },
    { path: '/e/:explorationId/f/:forkId/settings', component: SettingsView, props: true },
  ],
  async scrollBehavior(to, from, savedPosition) {
    if (savedPosition) {
      await whenActiveExplorationLoaded();
      if (to.meta.opensAtEnd) await whenWindowReady();
      return savedPosition;
    }
    // Views scroll to `#m-`, `#c-` and `#n-` targets themselves once the content has rendered.
    if (to.hash || to.path === from.path) return false;
    if (!to.meta.opensAtEnd) return { top: 0 };
    await whenActiveExplorationLoaded();
    await whenWindowReady();
    const firstUnread = document.querySelector<HTMLElement>('.message[data-unread]');
    const target = firstUnread
      ? () => scrollTopAtStartOf(firstUnread)
      : () => document.documentElement.scrollHeight;
    holdScroll(target);
    return { top: target() };
  },
});

// Links from before chat, fork and note ids had prefixes, in notes, messages and bookmarks, open
// the same page under the new ids.
router.beforeEach((to) => {
  const prefixed = {
    path: to.path
      .replace(/^\/e\/([^/]+)/, (_, id: string) => `/e/${withPrefix('chat', id)}`)
      .replace(/\/f\/([^/]+)$/, (_, id: string) => `/f/${withPrefix('fork', id)}`),
    hash: to.hash.replace(/^#n-(.+)$/, (_, id: string) => `#n-${withPrefix('note', id)}`),
    query:
      typeof to.query.from === 'string'
        ? { ...to.query, from: withPrefix('fork', to.query.from) }
        : to.query,
  };
  const unchanged =
    prefixed.path === to.path && prefixed.hash === to.hash && prefixed.query.from === to.query.from;
  if (unchanged) return;
  return { ...prefixed, replace: true };
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

// Links in answers and notes are plain anchors. One into the app opens in place: loading the page
// again would build the whole chat a second time, while Safari keeps the first for going back.
document.addEventListener('click', (event) => {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = event.target instanceof Element ? event.target.closest('a') : null;
  if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
  const url = new URL(anchor.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  event.preventDefault();
  void router.push(`${url.pathname}${url.search}${url.hash}`);
});

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

window.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
  if (event.key === '[') router.back();
  if (event.key === ']') router.forward();
});
