<script setup lang="ts">
import type { Fork, ForkRun } from '@shared/types';
import { computed, ref } from 'vue';
import { api } from '../api';
import CopyableId from './CopyableId.vue';

// The fork's model and how full its context is, from the runner's last turn, and whether the
// fork hears about the chat's other forks.
const props = defineProps<{ fork: Fork; run: ForkRun | undefined }>();

const saving = ref(false);

const share = computed(() => {
  const contextTokens = props.run?.contextTokens ?? null;
  const contextWindow = props.run?.contextWindow;
  return contextTokens !== null && contextWindow ? contextTokens / contextWindow : null;
});

async function setAware(aware: boolean) {
  saving.value = true;
  try {
    await api.setForkAwareness(props.fork.id, aware ? 'aware' : 'separate');
  } finally {
    saving.value = false;
  }
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
