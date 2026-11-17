<script setup lang="ts">
import { computed, useTemplateRef } from 'vue';
import { useRoute } from 'vue-router';
import ColumnDivider from './components/ColumnDivider.vue';
import ImageViewer from './components/ImageViewer.vue';
import OfflineBanner from './components/OfflineBanner.vue';
import UpdatePrompt from './components/UpdatePrompt.vue';
import { useColumnWidths } from './composables/useColumnWidths';
import { useLayout } from './composables/useLayout';
import { openExploration } from './stores/exploration';
import ExplorationsList from './views/ExplorationsList.vue';
import ForkMap from './views/ForkMap.vue';

const route = useRoute();
const { explorationId, chatsColumn, mapColumn } = useLayout();
const columns = useColumnWidths({
  explorationId,
  mapColumn,
  layout: useTemplateRef<HTMLElement>('layout'),
  columns: {
    chats: useTemplateRef<HTMLElement>('chats'),
    map: useTemplateRef<HTMLElement>('map'),
  },
});

const currentForkId = computed(() => {
  if (typeof route.params.forkId === 'string') return route.params.forkId;
  if (!explorationId.value) return undefined;
  const forks = openExploration(explorationId.value).forks.values();
  return [...forks].find((fork) => fork.parentForkId === null)?.id;
});
</script>

<template>
  <OfflineBanner />
  <div ref="layout" class="layout" :class="{ columns: chatsColumn || mapColumn }">
    <template v-if="chatsColumn">
      <aside ref="chats" class="side-column chats-column" :style="columns.styles.value.chats">
        <ExplorationsList sidebar :current-exploration-id="explorationId ?? undefined" />
      </aside>
      <ColumnDivider
        label="Resize the chats list"
        :percent="columns.percent('chats')"
        @drag="(clientX) => columns.moveEdge('chats', clientX)"
        @step="(pixels) => columns.step('chats', pixels)"
        @done="columns.save"
        @reset="columns.reset('chats')"
      />
    </template>
    <template v-if="mapColumn && explorationId">
      <section ref="map" class="side-column map-column" :style="columns.styles.value.map">
        <ForkMap side :exploration-id="explorationId" :current-fork-id="currentForkId" />
      </section>
      <ColumnDivider
        label="Resize the map"
        :percent="columns.percent('map')"
        @drag="(clientX) => columns.moveEdge('map', clientX)"
        @step="(pixels) => columns.step('map', pixels)"
        @done="columns.save"
        @reset="columns.reset('map')"
      />
    </template>
    <div class="main-column" :class="{ beside: mapColumn }" :style="columns.styles.value.main">
      <RouterView />
    </div>
  </div>
  <ImageViewer />
  <UpdatePrompt />
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
  min-width: 16rem;
}

.columns .main-column {
  flex: 1 1 0;
  min-width: 28rem;
}

/* It gives way to a chats list or a map dragged wider. */
.columns .main-column.beside {
  flex: 0 1 50%;
}

/* Beside the map the conversation fills its half of the screen. */
.main-column.beside :deep(.fork-view) {
  max-width: none;
}

.columns .main-column :deep(.notes-view) {
  max-width: none;
}
</style>
