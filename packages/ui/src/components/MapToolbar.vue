<script setup lang="ts">
import type { MapView } from '../lib/board';
import MediaIcon from './MediaIcon.vue';

defineProps<{ view: MapView; archivedOnly: boolean; archivedCount: number }>();
const emit = defineEmits<{ view: [view: MapView]; archived: [shown: boolean] }>();
</script>

<template>
  <div class="map-toolbar">
    <button
      v-if="archivedCount > 0 || archivedOnly"
      type="button"
      class="icon-button"
      :aria-label="`Show only archived forks (${archivedCount})`"
      :title="`Show only archived forks (${archivedCount})`"
      :aria-pressed="archivedOnly"
      @click="emit('archived', !archivedOnly)"
    >
      <MediaIcon name="archive" />
    </button>
    <div class="segmented">
      <button
        type="button"
        class="icon-button"
        aria-label="Graph view"
        title="Graph view"
        :aria-pressed="view === 'graph'"
        @click="emit('view', 'graph')"
      >
        <MediaIcon name="graph" />
      </button>
      <button
        type="button"
        class="icon-button"
        aria-label="Board view"
        title="Board view"
        :aria-pressed="view === 'board'"
        @click="emit('view', 'board')"
      >
        <MediaIcon name="board" />
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Lighter lines, like the icons of the header. */
.map-toolbar :deep(.media-icon) {
  stroke-width: 1.6;
}

.map-toolbar {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.map-toolbar button[aria-pressed='true'] {
  background: var(--accent-soft);
  border-color: var(--accent);
}

.segmented {
  display: inline-flex;
}

.segmented button:first-child {
  border-radius: 6px 0 0 6px;
}

.segmented button:last-child {
  border-left: none;
  border-radius: 0 6px 6px 0;
}
</style>
