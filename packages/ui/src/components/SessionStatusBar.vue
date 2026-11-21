<script setup lang="ts">
import type { RunStatus, SessionStatus } from '@shared/types';
import { computed } from 'vue';
import { outbox } from '../stores/outbox';

// The terminal session's state, or, on a fork the runner answers, that fork's own.
const props = defineProps<{
  status: SessionStatus;
  connected: boolean;
  explorationId: string;
  hasQueued: boolean;
  run?: { status: RunStatus; awaitingAnswer: boolean };
}>();

type RunState = RunStatus | 'waiting';
const runLabels: Record<RunState, string> = {
  idle: 'done',
  waiting: 'waiting',
  answering: 'working',
  waiting_limit: 'waiting for the limit',
  waiting_memory: 'waiting for memory',
  failed: 'failed',
};
const runExplanations: Record<RunState, string> = {
  idle: 'Claude has answered in this fork',
  waiting: 'This fork waits for Claude to start',
  answering: 'Claude is answering in this fork',
  waiting_limit: 'Claude waits for the usage limit in this fork',
  waiting_memory: 'This coding fork waits for Docker memory another one is using',
  failed: 'Claude could not answer in this fork',
};
const runState = computed<RunState | null>(() => {
  if (!props.run) return null;
  return props.run.status === 'idle' && props.run.awaitingAnswer ? 'waiting' : props.run.status;
});

const labels: Record<SessionStatus, string> = {
  listening: 'listening',
  answering: 'working',
  attached: 'paused',
  detached: 'detached',
};

const explanations: Record<SessionStatus, string> = {
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
  const shown = runState.value ? runLabels[runState.value] : labels[props.status];
  const state = props.connected ? shown : 'reconnecting…';
  if (!waiting.value || (props.connected && !outbox.stalled.value)) return state;
  return `${state} · ${waiting.value} waiting`;
});
const title = computed(() => {
  if (props.connected && runState.value) return runExplanations[runState.value];
  const explanation = props.connected ? explanations[props.status] : 'Reconnecting to the daemon';
  const command = `run /explore-chat ${props.explorationId} in Claude Code`;
  return props.status === 'listening' || props.status === 'answering'
    ? explanation
    : `${explanation}. Or ${command}.`;
});
</script>

<template>
  <div class="status" :class="connected ? (runState ?? status) : 'offline'" :title="title">
    <span class="dot" />
    <span class="label">
      {{ label }}
      <span v-if="connected && !runState && status === 'attached' && hasQueued" class="stopped">
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

.listening .dot,
.idle .dot {
  background: var(--success);
}

.waiting_limit .dot,
.waiting_memory .dot {
  background: var(--warning);
}

.answering .dot,
.waiting .dot {
  background: var(--warning);
  animation: pulse 1.2s ease-in-out infinite;
}

.stopped {
  color: var(--warning);
}

.offline .dot,
.failed .dot {
  background: var(--danger);
}

@keyframes pulse {
  50% {
    opacity: 0.3;
  }
}
</style>
