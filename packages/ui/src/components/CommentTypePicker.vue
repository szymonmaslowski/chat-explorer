<script setup lang="ts">
import type { CommentType } from '@shared/types';
import { computed } from 'vue';
import { usePopover } from '../composables/usePopover';
import MediaIcon from './MediaIcon.vue';

const type = defineModel<CommentType>({ required: true });

const options: { type: CommentType; label: string; icon: 'comment' | 'fork' | 'note' }[] = [
  { type: 'inline', label: 'Comment', icon: 'comment' },
  { type: 'fork', label: 'Fork', icon: 'fork' },
  { type: 'note', label: 'Note', icon: 'note' },
];

const { open, closeOnEscape } = usePopover('picker');
const current = computed(() => options.find((option) => option.type === type.value)!);

function choose(choice: CommentType) {
  type.value = choice;
  open.value = false;
}
</script>

<template>
  <div ref="picker" class="drop-up" @keydown.escape="closeOnEscape">
    <div v-if="open" class="drop-up-menu" role="menu" aria-label="Comment type">
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

.drop-up-menu button {
  color: var(--type-colour);
  white-space: nowrap;
}

.drop-up-menu button[aria-checked='true'] {
  border-color: var(--type-colour);
  background: var(--type-soft);
}
</style>
