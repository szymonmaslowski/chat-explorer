import { createRouter, createWebHistory } from 'vue-router';
import ExplorationsList from './views/ExplorationsList.vue';
import ForkView from './views/ForkView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: ExplorationsList },
    { path: '/e/:explorationId', component: ForkView, props: true },
    { path: '/e/:explorationId/f/:forkId', component: ForkView, props: true },
  ],
});
