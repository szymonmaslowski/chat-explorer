<script setup lang="ts">
import type { ExplorationListItem } from '@shared/types';
import { ref, watch } from 'vue';
import { api } from '../api';
import ConfirmButton from '../components/ConfirmButton.vue';
import NewExploration from '../components/NewExploration.vue';
import ThemeSwitch from '../components/ThemeSwitch.vue';
import { relativeTime } from '@shared/time';

const props = defineProps<{ archived?: boolean }>();

const explorations = ref<ExplorationListItem[] | null>(null);
const failed = ref(false);

watch(
  () => props.archived,
  async (archived) => {
    explorations.value = null;
    failed.value = false;
    try {
      explorations.value = await api.listExplorations(archived);
    } catch {
      failed.value = true;
    }
  },
  { immediate: true },
);

async function removeFromList(explorationId: string, change: (id: string) => Promise<object>) {
  await change(explorationId);
  explorations.value =
    explorations.value?.filter((exploration) => exploration.id !== explorationId) ?? null;
}
</script>

<template>
  <main class="page">
    <div class="heading">
      <h1>{{ archived ? 'Archived' : 'Chats' }}</h1>
      <RouterLink :to="archived ? '/' : '/archived'" class="view-link">
        {{ archived ? 'Chats' : 'Archived' }}
      </RouterLink>
      <ThemeSwitch />
    </div>
    <NewExploration v-if="!archived" />
    <p v-if="failed" class="muted">Could not load chats.</p>
    <p v-else-if="explorations?.length === 0" class="muted">
      <template v-if="archived">Nothing archived.</template>
      <template v-else>
        No chats yet. Start one above, or run <code>/explore-chat</code> in Claude Code.
      </template>
    </p>
    <ul v-else-if="explorations" class="explorations">
      <li v-for="exploration in explorations" :key="exploration.id" class="exploration">
        <RouterLink
          :to="exploration.forkCount > 1 ? `/e/${exploration.id}/map` : `/e/${exploration.id}`"
          class="open"
        >
          <span class="title">{{ exploration.title || 'Untitled chat' }}</span>
          <span v-if="exploration.summary" class="summary">{{ exploration.summary }}</span>
          <span class="meta muted">
            {{ exploration.forkCount }} fork{{ exploration.forkCount === 1 ? '' : 's' }} ·
            {{ relativeTime(exploration.updatedAt) }} · <code>{{ exploration.id }}</code>
          </span>
        </RouterLink>
        <div class="actions">
          <ConfirmButton
            v-if="!archived"
            label="Archive"
            @confirm="removeFromList(exploration.id, api.archive)"
          />
          <template v-else>
            <ConfirmButton
              label="Restore"
              @confirm="removeFromList(exploration.id, api.unarchive)"
            />
            <ConfirmButton
              label="Delete"
              danger
              @confirm="removeFromList(exploration.id, api.deleteExploration)"
            />
          </template>
        </div>
      </li>
    </ul>
  </main>
</template>

<style scoped>
.heading {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.heading h1 {
  flex: 1;
}

.view-link {
  font-size: 0.9rem;
}

@media (pointer: coarse) {
  .view-link {
    display: inline-flex;
    align-items: center;
    min-height: 2.5rem;
    padding: 0 0.4rem;
    font-size: 1rem;
  }
}

.explorations {
  list-style: none;
  padding: 0;
  display: grid;
  gap: 0.5rem;
}

.exploration {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1rem;
  padding: 0.8rem 1rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.exploration:hover {
  border-color: var(--accent);
}

.open {
  flex: 1 1 18rem;
  display: grid;
  gap: 0.15rem;
  color: inherit;
  text-decoration: none;
}

.title {
  font-weight: 600;
}

.meta {
  font-size: 0.8rem;
}

.actions {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-left: auto;
}
</style>
