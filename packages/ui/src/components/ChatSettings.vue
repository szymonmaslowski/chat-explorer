<script setup lang="ts">
import type { ChatDefaultPage, Exploration, Fork, ForkRun } from '@shared/types';
import { computed, ref } from 'vue';
import { api } from '../api';
import { removeOfflineData } from '../lib/offline-data';
import { offline } from '../lib/online';
import { outbox } from '../stores/outbox';
import ConfirmButton from './ConfirmButton.vue';
import CopyableId from './CopyableId.vue';
import ForkModelInfo from './ForkModelInfo.vue';
import ForkRequestSettings from './ForkRequestSettings.vue';

const unsent = computed(() => outbox.changes.value.length);

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
    <section class="card" aria-label="This chat">
      <h2>This chat</h2>
      <CopyableId label="Chat ID" :id="exploration.id" />
      <label class="setting">
        Default page
        <select
          :disabled="offline"
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
    </section>
    <ForkModelInfo
      v-if="fork"
      class="card"
      :fork="fork"
      :run="run"
      :chat-model="exploration.model"
    />
    <ForkRequestSettings v-if="fork" class="card" :fork="fork" />
    <section class="card device" aria-label="This device">
      <h2>This device</h2>
      <p class="muted">
        Every chat, its images and the app are kept here for offline use. Removing them leaves
        nothing on this device; used online again, the app keeps them anew.
      </p>
      <p v-if="unsent > 0" class="error" role="alert">
        {{ unsent }} change{{ unsent === 1 ? '' : 's' }} not sent yet would be lost.
      </p>
      <ConfirmButton label="Remove offline data" danger @confirm="removeOfflineData" />
    </section>
  </section>
</template>

<style scoped>
.chat-settings {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding-bottom: 2rem;
}

.card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.9rem 1rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.card h2 {
  margin: 0;
  font-size: 1rem;
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

.device p {
  margin: 0;
  font-size: 0.9rem;
}
</style>
