<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useExpandedArea } from '../composables/useExpandedArea';
import { insertAtCursor } from '../lib/insert-text';
import DictationButton from './DictationButton.vue';
import ExpandButton from './ExpandButton.vue';
import ListenButton from './ListenButton.vue';

const props = defineProps<{ topic: string | null }>();
const emit = defineEmits<{ create: [message: string]; cancel: [] }>();

const message = ref('');
const textarea = ref<HTMLTextAreaElement | null>(null);
const expanded = ref(false);
const expandedStyle = useExpandedArea(expanded, { coverDock: true, marginPx: 8 });
const canCreate = computed(() => message.value.trim() !== '');
const insertDictation = (text: string) => insertAtCursor(textarea.value, message, text);

onMounted(() => textarea.value?.focus());

function create() {
  if (canCreate.value) emit('create', message.value);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('cancel');
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    create();
  }
}
</script>

<template>
  <div class="note-fork" :class="{ expanded }" :style="expandedStyle ?? undefined">
    <p class="muted">New fork about this note</p>
    <textarea
      ref="textarea"
      v-model="message"
      rows="3"
      placeholder="Your message to Claude (⌘↵ to create the fork)"
      aria-label="Message for the new fork"
      @keydown="onKeydown"
    />
    <div class="actions">
      <DictationButton :hint="props.topic ?? ''" @text="insertDictation" />
      <ListenButton :text="message" />
      <ExpandButton v-model="expanded" />
      <span class="spacer" />
      <button type="button" @click="emit('cancel')">Cancel</button>
      <button type="button" class="primary" :disabled="!canCreate" @click="create">
        Create fork
      </button>
    </div>
  </div>
</template>

<style scoped>
.note-fork {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  margin-top: 0.4rem;
  padding: 0.5rem 0.75rem;
  background: var(--surface);
  border: 1px solid var(--fork);
  border-radius: var(--radius);
}

.note-fork.expanded {
  z-index: 7;
  margin-top: 0;
  box-shadow: var(--shadow);
}

.note-fork p {
  margin: 0;
  font-size: 0.8rem;
}

textarea {
  font: inherit;
  font-size: 0.9rem;
  color: inherit;
  background: none;
  border: none;
  padding: 0.2rem 0;
  outline: none;
  resize: vertical;
}

.expanded textarea {
  flex: 1;
  resize: none;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}

.spacer {
  flex: 1;
}
</style>
