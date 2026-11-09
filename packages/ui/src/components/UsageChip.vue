<script setup lang="ts">
import type { Fork, ForkRun } from '@shared/types';
import { computed, ref } from 'vue';
import { api } from '../api';
import { usePopover } from '../composables/usePopover';

// The fork's model and how full its context is, from the runner's last turn. The detail also
// holds whether the fork hears about the chat's other forks.
const props = defineProps<{ fork: Fork; run: ForkRun }>();

const { open, closeOnEscape } = usePopover('chip');
const saving = ref(false);

const compact = (tokens: number) =>
  tokens >= 1_000_000
    ? `${Math.round(tokens / 100_000) / 10}M`
    : tokens >= 1_000
      ? `${Math.round(tokens / 1_000)}k`
      : String(tokens);

const model = computed(() => props.run.model?.replace(/^claude-/, '') ?? 'model');
const share = computed(() => {
  const { contextTokens, contextWindow } = props.run;
  return contextTokens !== null && contextWindow ? contextTokens / contextWindow : null;
});
const label = computed(() => {
  const { contextTokens, contextWindow } = props.run;
  if (contextTokens === null) return model.value;
  return `${model.value} · ${compact(contextTokens)}${contextWindow ? ` / ${compact(contextWindow)}` : ''}`;
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
  <div ref="chip" class="usage-chip" @keydown.escape="closeOnEscape">
    <button
      type="button"
      class="chip"
      :aria-expanded="open"
      title="Model and context of this fork"
      @click="open = !open"
    >
      {{ label }}
      <span v-if="share !== null" class="bar" aria-hidden="true">
        <span :style="{ width: `${Math.min(100, share * 100)}%` }" />
      </span>
    </button>
    <div v-if="open" class="detail" role="dialog" aria-label="Model and context">
      <p>Model: {{ run.model ?? 'not known yet' }}</p>
      <p v-if="run.contextTokens !== null">
        Context: {{ run.contextTokens.toLocaleString() }} tokens<template v-if="run.contextWindow">
          of {{ run.contextWindow.toLocaleString() }} ({{ Math.round((share ?? 0) * 100) }}%)
        </template>
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
    </div>
  </div>
</template>

<style scoped>
.usage-chip {
  position: relative;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.15rem 0.5rem;
  font-size: 0.75rem;
  color: var(--text-muted);
  white-space: nowrap;
}

.bar {
  display: inline-block;
  width: 2.5rem;
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

.detail {
  position: absolute;
  top: calc(100% + 0.3rem);
  right: 0;
  z-index: 8;
  width: 16rem;
  padding: 0.6rem 0.75rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  font-size: 0.8rem;
}

.detail p {
  margin: 0 0 0.4rem;
}

.detail label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
</style>
