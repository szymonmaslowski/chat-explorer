import { createRouter, createWebHistory } from 'vue-router';
import { whenActiveExplorationLoaded } from './stores/exploration';
import ExplorationsList from './views/ExplorationsList.vue';
import ForkMap from './views/ForkMap.vue';
import ForkView from './views/ForkView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: ExplorationsList },
    { path: '/e/:explorationId', component: ForkView, props: true },
    { path: '/e/:explorationId/f/:forkId', component: ForkView, props: true },
    {
      path: '/e/:explorationId/map',
      component: ForkMap,
      props: (route) => ({
        explorationId: route.params.explorationId,
        currentForkId: route.query.from,
      }),
    },
  ],
  async scrollBehavior(to, from, savedPosition) {
    if (savedPosition) {
      await whenActiveExplorationLoaded();
      return savedPosition;
    }
    // Views scroll to `#m-` and `#c-` targets themselves once the content has rendered.
    if (to.hash || to.path === from.path) return false;
    return { top: 0 };
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
