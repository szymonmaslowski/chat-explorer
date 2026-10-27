<script setup lang="ts">
import type { SessionStatus } from '@shared/types';
import { computed } from 'vue';

const props = defineProps<{ status: SessionStatus; connected: boolean; explorationId: string }>();

const labels: Record<SessionStatus, string> = {
  listening: 'Claude is listening',
  answering: 'Claude is answering',
  attached: 'Session attached, not listening',
  detached: 'No session attached',
};

const label = computed(() => (props.connected ? labels[props.status] : 'Reconnecting…'));
</script>

<template>
  <div class="status" :class="connected ? status : 'offline'">
    <span class="dot" />
    <span>{{ label }}</span>
    <span v-if="connected && status === 'detached'" class="hint">
      run <code>/explore-chat {{ explorationId }}</code>
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
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--text-muted);
}

.listening .dot {
  background: var(--success);
}

.answering .dot {
  background: var(--warning);
  animation: pulse 1.2s ease-in-out infinite;
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
