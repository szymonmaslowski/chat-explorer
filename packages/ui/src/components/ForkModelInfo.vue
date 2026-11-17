<script setup lang="ts">
import type { Fork, ForkRun } from '@shared/types';
import { computed, ref } from 'vue';
import { api } from '../api';
import CopyableId from './CopyableId.vue';

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
    <p v-if="fork.coding" class="hint">
      Takes effect when the fork's container next starts. The runner must allow coding in its own
      config.
    </p>
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
