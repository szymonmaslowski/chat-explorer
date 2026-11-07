<script setup lang="ts">
import type { SessionStatus } from '@shared/types';
import { computed } from 'vue';
import { outbox } from '../stores/outbox';

const props = defineProps<{
  status: SessionStatus;
  connected: boolean;
  explorationId: string;
  hasQueued: boolean;
}>();

const labels: Record<SessionStatus, string> = {
  starting: 'starting',
  listening: 'listening',
  answering: 'working',
  attached: 'paused',
  detached: 'detached',
};

const explanations: Record<SessionStatus, string> = {
  starting: 'Claude is starting',
  listening: 'Claude is listening',
  answering: 'Claude is answering',
  attached: 'A session is attached, but Claude is not listening',
  detached: 'No session attached; one starts when you submit',
};

const waiting = computed(
  () =>
    outbox.changes.value.filter((change) => change.explorationId === props.explorationId).length,
);
const label = computed(() => {
  const state = props.connected ? labels[props.status] : 'reconnecting…';
  if (!waiting.value || (props.connected && !outbox.stalled.value)) return state;
  return `${state} · ${waiting.value} waiting`;
});
const title = computed(() => {
  const explanation = props.connected ? explanations[props.status] : 'Reconnecting to the daemon';
  const command = `run /explore-chat ${props.explorationId} in Claude Code`;
  return props.status === 'listening' || props.status === 'answering'
    ? explanation
    : `${explanation}. Or ${command}.`;
});
</script>

<template>
  <div class="status" :class="connected ? status : 'offline'" :title="title">
    <span class="dot" />
    <span class="label">
      {{ label }}
      <span v-if="connected && status === 'attached' && hasQueued" class="stopped">
        · messages wait: tell Claude in its terminal to continue
      </span>
    </span>
  </div>
</template>

<style scoped>
.status {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8rem;
  color: var(--text-muted);
}

.dot {
  flex: none;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--text-muted);
}

.listening .dot {
  background: var(--success);
}

.answering .dot,
.starting .dot {
  background: var(--warning);
  animation: pulse 1.2s ease-in-out infinite;
}

.stopped {
  color: var(--warning);
}

.offline .dot {
  background: var(--danger);
}

@keyframes pulse {
  50% {
    opacity: 0.3;
  }
}
</style>
