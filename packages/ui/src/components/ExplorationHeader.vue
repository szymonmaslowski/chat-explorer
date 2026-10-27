<script setup lang="ts">
import { api } from '../api';
import type { ExplorationState } from '../stores/exploration';
import SessionStatusBar from './SessionStatusBar.vue';
import ThemeSwitch from './ThemeSwitch.vue';

defineProps<{ state: ExplorationState }>();
</script>

<template>
  <header class="exploration-header">
    <div class="bar">
      <nav class="links">
        <RouterLink to="/">Explorations</RouterLink>
        <slot name="links" />
      </nav>
      <div class="controls">
        <SessionStatusBar
          v-if="!state.exploration?.archivedAt"
          :status="state.sessionStatus"
          :connected="state.connected"
          :exploration-id="state.explorationId"
          :model="state.exploration?.model"
        />
        <ThemeSwitch />
      </div>
    </div>
    <p v-if="state.exploration" class="title">
      {{ state.exploration.title || 'Untitled exploration' }}
    </p>
    <p v-if="state.exploration?.archivedAt" class="archived">
      Archived, read only.
      <button type="button" @click="api.unarchive(state.explorationId)">Restore</button>
    </p>
    <slot />
  </header>
</template>

<style scoped>
.exploration-header {
  border-bottom: 1px solid var(--border);
  font-size: 0.875rem;
  padding: 0.6rem 0;
}

.bar {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 0.25rem 1rem;
}

.links {
  display: flex;
  gap: 0.4rem;
}

.controls {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-left: auto;
}

.archived {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0.4rem 0 0;
  color: var(--warning);
}

.title {
  margin: 0.2rem 0 0;
  font-weight: 600;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
