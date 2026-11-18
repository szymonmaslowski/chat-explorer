<script setup lang="ts">
import type { CapabilitiesReport, Fork, ForkRun } from '@shared/types';
import { computed, ref, watch } from 'vue';
import { api } from '../api';
import CopyableId from './CopyableId.vue';
import ForkCredentialSettings from './ForkCredentialSettings.vue';
import ForkNetworkSettings from './ForkNetworkSettings.vue';

// The fork's model and how full its context is, from the runner's last turn, whether the fork
// hears about the chat's other forks, and whether Claude may code in it.
const props = defineProps<{ fork: Fork; run: ForkRun | undefined }>();

const saving = ref(false);

const share = computed(() => {
  const contextTokens = props.run?.contextTokens ?? null;
  const contextWindow = props.run?.contextWindow;
  return contextTokens !== null && contextWindow ? contextTokens / contextWindow : null;
});

async function save(change: () => Promise<unknown>) {
  saving.value = true;
  try {
    await change();
  } finally {
    saving.value = false;
  }
}

const setAware = (aware: boolean) =>
  save(() => api.setForkAwareness(props.fork.id, aware ? 'aware' : 'separate'));
const setCoding = (coding: boolean) => save(() => api.setForkCoding(props.fork.id, coding));

const report = ref<CapabilitiesReport | null>(null);
watch(
  () => props.fork.coding,
  async (coding) => {
    if (!coding) return;
    report.value = await api
      .runnerCapabilities()
      .then((result) => result.report)
      .catch(() => null);
  },
  { immediate: true },
);
const reportedAt = computed(() =>
  report.value
    ? new Date(report.value.reportedAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })
    : '',
);

const restartNote = ref('');
async function restartContainer() {
  restartNote.value = '';
  const { restarting } = await api.restartContainer(props.fork.id);
  restartNote.value = restarting
    ? 'The container closes once no answer is running. Your next message starts a fresh one and the conversation continues; anything running in the old one, such as a dev server, stops.'
    : 'No container is running. Your next message starts a fresh one.';
}
</script>

<template>
  <section class="fork-model" aria-label="This fork">
    <h2>This fork</h2>
    <CopyableId class="fork-id" label="Fork ID" :id="fork.id" />
    <p>Model: {{ run?.model ?? 'not known yet' }}</p>
    <p v-if="run && run.contextTokens !== null">
      Context: {{ run.contextTokens.toLocaleString() }} tokens<template v-if="run.contextWindow">
        of {{ run.contextWindow.toLocaleString() }} ({{ Math.round((share ?? 0) * 100) }}%)
      </template>
      <span v-if="share !== null" class="bar" aria-hidden="true">
        <span :style="{ width: `${Math.min(100, share * 100)}%` }" />
      </span>
    </p>
    <label>
      <input
        type="checkbox"
        :checked="fork.awareness === 'aware'"
        :disabled="saving"
        @change="setAware(($event.target as HTMLInputElement).checked)"
      />
      Hears about the chat's other forks
    </label>
    <label>
      <input
        type="checkbox"
        :checked="fork.coding"
        :disabled="saving"
        @change="setCoding(($event.target as HTMLInputElement).checked)"
      />
      Coding: Claude runs commands and writes files in this fork's workspace
    </label>
    <template v-if="fork.coding">
      <p class="hint">
        Takes effect from your next message, in a new container. The runner must allow coding in its
        own config.
      </p>
      <p v-if="report && !report.capabilities.coding" class="warning" role="alert">
        {{ report.capabilities.codingOff ?? 'The runner has coding off.' }}
      </p>
      <p v-if="report && !report.current" class="hint">
        The runner is offline: its choices below are as of {{ reportedAt }}.
      </p>
      <ForkNetworkSettings :fork="fork" :report="report" />
      <ForkCredentialSettings :fork="fork" :report="report" />
      <p>
        <button type="button" :disabled="saving" @click="restartContainer">
          Restart container
        </button>
      </p>
      <p v-if="restartNote" class="hint" role="status">{{ restartNote }}</p>
    </template>
  </section>
</template>

<style scoped>
h2 {
  margin: 0 0 0.3rem;
  font-size: inherit;
  font-weight: 600;
}

.fork-id {
  margin: 0 0 0.4rem;
}

p {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  margin: 0 0 0.4rem;
}

label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.hint {
  color: var(--text-muted);
  font-size: 0.85em;
}

.warning {
  color: var(--warning);
  font-size: 0.85em;
}

.bar {
  display: inline-block;
  width: 4rem;
  height: 0.3rem;
  border-radius: 999px;
  background: var(--surface-muted);
  overflow: hidden;
}

.bar span {
  display: block;
  height: 100%;
  background: var(--accent);
}
</style>
