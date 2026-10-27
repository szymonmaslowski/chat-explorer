<script setup lang="ts">
import { computed } from 'vue';
import { useDictation } from '../composables/useDictation';

const props = defineProps<{ hint?: string }>();
const emit = defineEmits<{ text: [text: string] }>();

const { available, state, error, seconds, level, start, stop, cancel } = useDictation({
  hint: () => props.hint ?? '',
  onText: (text) => emit('text', text),
});

const clock = computed(() => {
  const wholeSeconds = Math.floor(seconds.value);
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, '0')}`;
});
</script>

<template>
  <span v-if="available" class="dictation">
    <template v-if="state === 'idle'">
      <button type="button" class="mic" title="Dictate" aria-label="Dictate" @click="start">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M6 11a6 6 0 0 0 12 0M12 17v4" />
        </svg>
      </button>
      <span v-if="error" class="error" role="alert">{{ error }}</span>
    </template>
    <template v-else-if="state === 'recording'">
      <button
        type="button"
        class="mic recording"
        title="Stop and transcribe"
        aria-label="Stop dictation"
        @click="stop"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="7" y="7" width="10" height="10" />
        </svg>
      </button>
      <span class="meter"><span :style="{ width: `${Math.min(100, level * 400)}%` }" /></span>
      <span class="clock">{{ clock }}</span>
      <button
        type="button"
        class="cancel"
        aria-label="Cancel dictation"
        title="Cancel"
        @click="cancel"
      >
        ✕
      </button>
    </template>
    <template v-else>
      <span class="muted">Transcribing…</span>
      <button
        type="button"
        class="cancel"
        aria-label="Cancel dictation"
        title="Cancel"
        @click="cancel"
      >
        ✕
      </button>
    </template>
  </span>
</template>

<style scoped>
.dictation {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8rem;
  min-width: 0;
}

.mic {
  display: inline-grid;
  place-items: center;
  padding: 0.25rem 0.45rem;
}

.mic svg {
  width: 1rem;
  height: 1rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
}

.mic.recording {
  color: var(--danger);
  border-color: var(--danger);
}

.mic.recording svg {
  fill: currentColor;
  stroke: none;
}

.meter {
  width: 3rem;
  height: 0.35rem;
  border-radius: 999px;
  background: var(--surface-muted);
  overflow: hidden;
}

.meter span {
  display: block;
  height: 100%;
  background: var(--accent);
}

.cancel {
  padding: 0.25rem 0.5rem;
}

.clock {
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
}

.error {
  color: var(--danger);
}
</style>
