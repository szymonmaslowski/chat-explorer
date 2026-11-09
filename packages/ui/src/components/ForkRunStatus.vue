<script setup lang="ts">
import type { ForkRun } from '@shared/types';
import { computed, ref } from 'vue';
import { api } from '../api';

// What Claude is doing in this fork, from the runner: working, waiting for the usage limit, or
// failed with a way to try again.
const props = defineProps<{ forkId: string; run: ForkRun | null; awaitingAnswer: boolean }>();

const busy = ref(false);
const until = computed(() => {
  const detail = props.run?.statusDetail;
  if (!detail) return '';
  const time = new Date(detail);
  return Number.isNaN(time.getTime())
    ? ''
    : ` until ${time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
});

async function act(action: (forkId: string) => Promise<unknown>) {
  busy.value = true;
  try {
    await action(props.forkId);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="run?.status === 'failed'" class="run-failed" role="alert">
    <span>Claude could not answer: {{ run.statusDetail }}</span>
    <button type="button" :disabled="busy" @click="act(api.retryFork)">Retry</button>
  </div>
  <p v-else-if="run?.status === 'waiting_limit'" class="run-status muted">
    Waiting for the usage limit{{ until }}.
  </p>
  <p v-else-if="run?.status === 'answering' && run.heldByTerminal" class="run-status muted">
    Claude is answering in the terminal…
  </p>
  <p v-else-if="run?.status === 'answering'" class="run-status muted">
    Claude is working…
    <button type="button" :disabled="busy" @click="act(api.stopFork)">Stop</button>
  </p>
  <p v-else-if="awaitingAnswer" class="run-status muted">Claude is answering…</p>
</template>

<style scoped>
.run-status {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.run-failed {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem;
  margin: 0.75rem 0;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--danger);
  border-radius: var(--radius);
  color: var(--danger);
  white-space: pre-wrap;
}
</style>
