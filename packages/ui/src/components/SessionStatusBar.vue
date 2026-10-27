<script setup lang="ts">
import { claudeModels, type ClaudeModel } from '@shared/models';
import type { SessionStatus } from '@shared/types';
import { computed } from 'vue';
import { api } from '../api';
import { modelLabels } from '../lib/models';

const props = defineProps<{
  status: SessionStatus;
  connected: boolean;
  explorationId: string;
  model: ClaudeModel | undefined;
}>();

const labels: Record<SessionStatus, string> = {
  starting: 'Starting Claude…',
  listening: 'Claude is listening',
  answering: 'Claude is answering',
  attached: 'Session attached, not listening',
  detached: 'No session attached',
};

const label = computed(() => (props.connected ? labels[props.status] : 'Reconnecting…'));
const selectedModel = computed({
  get: () => props.model,
  set: (model) => {
    if (model) void api.setModel(props.explorationId, model);
  },
});
</script>

<template>
  <div class="status" :class="connected ? status : 'offline'">
    <span class="dot" />
    <span class="label">
      {{ label }}
      <span
        v-if="connected && status === 'detached'"
        :title="`Or run /explore-chat ${explorationId} in Claude Code`"
      >
        · starts when you submit
      </span>
    </span>
    <select
      v-if="model"
      v-model="selectedModel"
      class="model"
      title="Model for sessions that chat-explorer starts"
    >
      <option v-for="option in claudeModels" :key="option" :value="option">
        {{ modelLabels[option] }}
      </option>
    </select>
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

.offline .dot {
  background: var(--danger);
}

.model {
  margin-left: 0.25rem;
  font-size: 0.8rem;
}

@keyframes pulse {
  50% {
    opacity: 0.3;
  }
}
</style>
