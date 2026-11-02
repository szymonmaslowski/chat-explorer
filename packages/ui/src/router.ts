import { createRouter, createWebHistory } from 'vue-router';
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
    return { top: document.documentElement.scrollHeight };
  },
});

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

window.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
  if (event.key === '[') router.back();
  if (event.key === ']') router.forward();
});
