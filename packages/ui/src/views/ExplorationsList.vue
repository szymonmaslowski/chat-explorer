<script setup lang="ts">
import type { ExplorationListItem } from '@shared/types';
import { onMounted, ref } from 'vue';
import { api } from '../api';
import NewExploration from '../components/NewExploration.vue';
import ThemeSwitch from '../components/ThemeSwitch.vue';
import { relativeTime } from '@shared/time';

const explorations = ref<ExplorationListItem[] | null>(null);
const failed = ref(false);

onMounted(async () => {
  try {
    explorations.value = await api.listExplorations();
  } catch {
    failed.value = true;
  }
});
</script>

<template>
  <main class="page">
    <div class="heading">
      <h1>Explorations</h1>
      <ThemeSwitch />
    </div>
    <NewExploration />
    <p v-if="failed" class="muted">Could not load explorations.</p>
    <p v-else-if="explorations?.length === 0" class="muted">
      No explorations yet. Start one above, or run <code>/explore-chat</code> in Claude Code.
    </p>
    <ul v-else-if="explorations" class="explorations">
      <li v-for="exploration in explorations" :key="exploration.id">
        <RouterLink :to="`/e/${exploration.id}/map`" class="exploration">
          <span class="title">{{ exploration.title || 'Untitled exploration' }}</span>
          <span v-if="exploration.summary" class="summary">{{ exploration.summary }}</span>
          <span class="meta muted">
            {{ exploration.forkCount }} fork{{ exploration.forkCount === 1 ? '' : 's' }} ·
            {{ relativeTime(exploration.updatedAt) }} · <code>{{ exploration.id }}</code>
          </span>
        </RouterLink>
      </li>
    </ul>
  </main>
</template>

<style scoped>
.heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.explorations {
  list-style: none;
  padding: 0;
  display: grid;
  gap: 0.5rem;
}

.exploration {
  display: grid;
  gap: 0.15rem;
  padding: 0.8rem 1rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: inherit;
  text-decoration: none;
}

.exploration:hover {
  border-color: var(--accent);
}

.title {
  font-weight: 600;
}

.meta {
  font-size: 0.8rem;
}
</style>
