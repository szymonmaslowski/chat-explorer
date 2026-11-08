<script setup lang="ts">
import type { CommentType } from '@shared/types';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import MediaIcon from './MediaIcon.vue';

const type = defineModel<CommentType>({ required: true });

const options: { type: CommentType; label: string; icon: 'comment' | 'fork' | 'note' }[] = [
  { type: 'inline', label: 'Comment', icon: 'comment' },
  { type: 'fork', label: 'Fork', icon: 'fork' },
  { type: 'note', label: 'Note', icon: 'note' },
];

const open = ref(false);
const picker = ref<HTMLElement | null>(null);
const current = computed(() => options.find((option) => option.type === type.value)!);

function choose(choice: CommentType) {
  type.value = choice;
  open.value = false;
}

function closeOnEscape(event: KeyboardEvent) {
  if (!open.value) return;
  event.stopPropagation();
  open.value = false;
}

function closeOutside(event: PointerEvent) {
  if (event.target instanceof Node && !picker.value?.contains(event.target)) open.value = false;
}

watch(open, (isOpen) => {
  if (isOpen) document.addEventListener('pointerdown', closeOutside);
  else document.removeEventListener('pointerdown', closeOutside);
});
onBeforeUnmount(() => document.removeEventListener('pointerdown', closeOutside));
</script>

<template>
  <div ref="picker" class="type-picker" @keydown.escape="closeOnEscape">
    <div v-if="open" class="options" role="menu" aria-label="Comment type">
      <button
        v-for="option in options"
        :key="option.type"
        type="button"
        role="menuitemradio"
        :aria-checked="option.type === type"
        :class="option.type"
        @click="choose(option.type)"
      >
        <MediaIcon :name="option.icon" />
        {{ option.label }}
      </button>
    </div>
    <button
      type="button"
      class="current"
      :class="type"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-label="`Type: ${current.label}`"
      title="Comment, fork or note"
      @click="open = !open"
    >
      <MediaIcon :name="current.icon" />
      <MediaIcon name="chevron-up" />
    </button>
  </div>
</template>

<style scoped>
.type-picker {
  position: relative;
}

button {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  --type-colour: var(--accent);
  --type-soft: var(--accent-soft);
}

button.fork {
  --type-colour: var(--fork);
  --type-soft: var(--fork-soft);
}

button.note {
  --type-colour: var(--note);
  --type-soft: var(--note-soft);
}

.current {
  padding: 0.15rem 0.4rem;
  border-color: var(--type-colour);
  background: var(--type-soft);
  color: var(--type-colour);
}

.options {
  position: absolute;
  bottom: calc(100% + 0.3rem);
  left: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.3rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.options button {
  color: var(--type-colour);
  white-space: nowrap;
}

.options button[aria-checked='true'] {
  border-color: var(--type-colour);
  background: var(--type-soft);
}
</style>
