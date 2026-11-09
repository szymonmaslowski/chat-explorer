<script setup lang="ts">
import type { Fork } from '@shared/types';
import { computed } from 'vue';
import { api } from '../api';
import { useLayout, type LayoutPage } from '../composables/useLayout';
import { forkLineage, forkTitle } from '../lib/conversation';
import type { ExplorationState } from '../stores/exploration';
import ConfirmButton from './ConfirmButton.vue';
import OutboxFailures from './OutboxFailures.vue';
import SessionStatusBar from './SessionStatusBar.vue';
import ThemeSwitch from './ThemeSwitch.vue';

// With a fork, the title is the fork's, under the path to it: the chat, then the forks above it.
// Beside the main column, as `side`, the status and theme stay with the main column's header.
const props = defineProps<{
  state: ExplorationState;
  page: Exclude<LayoutPage, 'chats'>;
  fork?: Fork;
  side?: boolean;
}>();

const { chatsColumn, mapColumn } = useLayout();
// A page shown in a column of its own needs no link.
const links = computed(() => {
  const chat = `/e/${props.state.explorationId}`;
  const mapUrl = props.fork ? `${chat}/map?from=${props.fork.id}` : `${chat}/map`;
  return [
    chatsColumn.value ? null : { label: 'Chats', to: '/' },
    mapColumn.value ? null : { label: 'Map', to: props.page === 'map' ? null : mapUrl },
    { label: 'Notes', to: props.page === 'notes' ? null : `${chat}/notes` },
  ].filter((link) => link !== null);
});

const chatTitle = computed(() => props.state.exploration?.title || 'Untitled chat');
const forksBetween = computed(() =>
  props.fork ? forkLineage(props.fork, props.state.forks).slice(1, -1) : [],
);
</script>

<template>
  <header class="exploration-header">
    <div class="bar">
      <nav class="links">
        <template v-for="(link, index) in links" :key="link.label">
          <template v-if="index > 0">·</template>
          <RouterLink v-if="link.to" :to="link.to">{{ link.label }}</RouterLink>
          <span v-else>{{ link.label }}</span>
        </template>
      </nav>
      <div v-if="!side" class="controls">
        <SessionStatusBar
          v-if="!state.exploration?.archivedAt"
          :status="state.sessionStatus"
          :connected="state.connected"
          :exploration-id="state.explorationId"
          :has-queued="state.queuedSubmissions.size > 0"
        />
        <ThemeSwitch />
      </div>
    </div>
    <template v-if="state.exploration">
      <p v-if="fork" class="fork-path">
        <RouterLink v-if="fork.parentForkId" :to="`/e/${state.explorationId}`">
          {{ chatTitle }}
        </RouterLink>
        <span v-else>{{ chatTitle }}</span>
        /
        <template v-for="ancestor in forksBetween" :key="ancestor.id">
          <RouterLink :to="`/e/${state.explorationId}/f/${ancestor.id}`">
            {{ forkTitle(ancestor) }}
          </RouterLink>
          /
        </template>
      </p>
      <div class="title-row">
        <div class="title-group">
          <h1 class="title" :class="{ 'fork-title': fork }">
            {{ fork ? forkTitle(fork) : chatTitle }}
          </h1>
          <slot name="title-badge" />
        </div>
        <div v-if="$slots['title-actions']" class="title-actions">
          <slot name="title-actions" />
        </div>
      </div>
    </template>
    <p v-if="state.exploration?.archivedAt" class="archived">
      Archived, read only.
      <ConfirmButton label="Restore" @confirm="api.unarchive(state.explorationId)" />
    </p>
    <OutboxFailures :exploration-id="state.explorationId" />
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
  align-items: center;
  gap: 0.4rem;
}

@media (pointer: coarse) {
  .links {
    font-size: 1rem;
    gap: 0.2rem;
  }

  .links :deep(a) {
    display: inline-flex;
    align-items: center;
    min-height: 2.5rem;
    padding: 0 0.4rem;
  }

  .links :deep(a:first-child) {
    padding-left: 0;
  }
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

.fork-path {
  margin: 0.2rem 0 0;
  font-size: 0.75rem;
  color: var(--text-muted);
}

.fork-path a {
  color: inherit;
}

.title-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.4rem;
}

.title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.6rem;
  margin: 0.2rem 0 0;
}

/* A badge sits right after a short title and wraps under a long one. */
.title-group {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.15rem 0.5rem;
  min-width: 0;
}

.title {
  min-width: 0;
  margin: 0;
  font-size: inherit;
  font-weight: 600;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
