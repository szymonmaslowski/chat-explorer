<script setup lang="ts">
import type { Activity } from '@shared/types';
import { computed, ref, watch } from 'vue';

// What Claude did during one attempt at a turn: open while it works, one line once it answered,
// greyed when the attempt died and was retried.
const props = defineProps<{ activities: Activity[]; working: boolean }>();

const interrupted = computed(() => props.activities.some((activity) => activity.interrupted));
const open = ref(props.working);
watch(
  () => props.working,
  (working) => (open.value = working),
);

const steps = computed(() => {
  const count = props.activities.length;
  return `${count} step${count === 1 ? '' : 's'}`;
});

const duration = computed(() => {
  const first = props.activities[0]?.createdAt ?? 0;
  const last = props.activities.at(-1)?.createdAt ?? first;
  const seconds = Math.round((last - first) / 1000);
  if (seconds < 1) return '';
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? ` for ${minutes}m ${seconds % 60}s` : ` for ${seconds}s`;
});

const label = computed(() => {
  if (props.working) return `Working · ${steps.value}`;
  if (interrupted.value) return `Interrupted, retried · ${steps.value}`;
  return `Worked${duration.value} · ${steps.value}`;
});
</script>

<template>
  <div class="activity-group" :class="{ interrupted, working }">
    <button type="button" class="summary" :aria-expanded="open" @click="open = !open">
      <span class="marker" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
      {{ label }}
    </button>
    <ol v-if="open" class="steps">
      <li v-for="activity in activities" :key="activity.id" :class="activity.kind">
        {{ activity.text }}
      </li>
    </ol>
  </div>
</template>

<style scoped>
.activity-group {
  margin: 0.5rem 0;
  font-size: 0.8rem;
  color: var(--text-muted);
}

.activity-group.interrupted {
  opacity: 0.55;
}

.summary {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.15rem 0.5rem;
  border: none;
  background: none;
  color: inherit;
  font-size: inherit;
}

.working .summary::after {
  content: '';
  width: 0.4rem;
  height: 0.4rem;
  border-radius: 50%;
  background: var(--accent);
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.25;
  }
}

.steps {
  margin: 0.2rem 0 0;
  padding-left: 1.6rem;
}

.steps li {
  margin: 0.15rem 0;
  overflow-wrap: anywhere;
}

.steps li.text {
  white-space: pre-wrap;
  font-style: italic;
}
</style>
