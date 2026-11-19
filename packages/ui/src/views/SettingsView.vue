<script setup lang="ts">
import { computed } from 'vue';
import ChatSettings from '../components/ChatSettings.vue';
import ExplorationHeader from '../components/ExplorationHeader.vue';
import { openExploration } from '../stores/exploration';

// The chat's settings, and a fork's when opened from one, in place of the conversation.
const props = defineProps<{ explorationId: string; forkId?: string }>();

const state = computed(() => openExploration(props.explorationId));
const fork = computed(() => (props.forkId ? state.value.forks.get(props.forkId) : undefined));
const run = computed(() => (fork.value ? state.value.forkRuns.get(fork.value.id) : undefined));
</script>

<template>
  <div class="page settings-view">
    <ExplorationHeader :state="state" page="settings" :fork="fork" class="top" />
    <p v-if="state.status === 'loading'" class="muted">Loading…</p>
    <ChatSettings
      v-else-if="state.exploration"
      :exploration="state.exploration"
      :fork="fork"
      :run="run"
    />
    <p v-else class="muted">This chat is not available.</p>
  </div>
</template>

<style scoped>
.top {
  position: sticky;
  top: 0;
  z-index: 6;
  margin-bottom: 1rem;
  background: var(--background);
}
</style>
