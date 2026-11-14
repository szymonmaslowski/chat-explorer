<script setup lang="ts">
import type { ChatDefaultPage, Exploration, Fork, ForkRun } from '@shared/types';
import { ref } from 'vue';
import { api } from '../api';
import CopyableId from './CopyableId.vue';
import ForkModelInfo from './ForkModelInfo.vue';

defineProps<{ exploration: Exploration; fork?: Fork; run?: ForkRun }>();

const failed = ref(false);

async function setDefaultPage(explorationId: string, defaultPage: ChatDefaultPage) {
  failed.value = false;
  try {
    await api.setDefaultPage(explorationId, defaultPage);
  } catch {
    failed.value = true;
  }
}
</script>

<template>
  <section class="chat-settings" aria-label="Chat settings">
    <CopyableId label="Chat ID" :id="exploration.id" />
    <label class="setting">
      Default page
      <select
        :value="exploration.defaultPage"
        @change="
          setDefaultPage(
            exploration.id,
            ($event.target as HTMLSelectElement).value as ChatDefaultPage,
          )
        "
      >
        <option value="map">Chat</option>
        <option value="notes">Notes</option>
      </select>
    </label>
    <p v-if="failed" class="error" role="alert">Could not save the setting.</p>
    <ForkModelInfo v-if="fork" :fork="fork" :run="run" />
  </section>
</template>

<style scoped>
.chat-settings {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.5rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.setting {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.error {
  margin: 0;
  color: var(--danger);
}
</style>
