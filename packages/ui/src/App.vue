<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import ImageViewer from './components/ImageViewer.vue';
import { useLayout } from './composables/useLayout';
import { openExploration } from './stores/exploration';
import ExplorationsList from './views/ExplorationsList.vue';
import ForkMap from './views/ForkMap.vue';

const route = useRoute();
const { explorationId, chatsColumn, mapColumn } = useLayout();

const currentForkId = computed(() => {
  if (typeof route.params.forkId === 'string') return route.params.forkId;
  if (!explorationId.value) return undefined;
  const forks = openExploration(explorationId.value).forks.values();
  return [...forks].find((fork) => fork.parentForkId === null)?.id;
});
</script>

<template>
  <div class="layout" :class="{ columns: chatsColumn || mapColumn }">
    <aside v-if="chatsColumn" class="side-column chats-column">
      <ExplorationsList sidebar :current-exploration-id="explorationId ?? undefined" />
    </aside>
    <section v-if="mapColumn && explorationId" class="side-column map-column">
      <ForkMap side :exploration-id="explorationId" :current-fork-id="currentForkId" />
    </section>
    <div class="main-column" :class="{ beside: mapColumn }">
      <RouterView />
    </div>
  </div>
  <ImageViewer />
</template>

<style scoped>
.columns {
  display: flex;
  align-items: flex-start;
}

/* The main column scrolls with the page; the columns beside it stay in view and scroll alone. */
.side-column {
  position: sticky;
  top: 0;
  height: 100dvh;
  overflow-y: auto;
  border-right: 1px solid var(--border);
}

/* A 12-column grid: chats 2, map 4, a fork 6; the chats keep room for their cards. */
.chats-column {
  flex: 0 0 calc(100% / 6);
  min-width: 18rem;
}

.map-column {
  flex: 1 1 0;
  min-width: 0;
}

.columns .main-column {
  flex: 1 1 0;
  min-width: 0;
}

.columns .main-column.beside {
  flex: 0 0 50%;
}

/* Beside the map the conversation fills its half of the screen. */
.main-column.beside :deep(.fork-view) {
  max-width: none;
}
</style>
