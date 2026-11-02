<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useExpandedArea } from '../composables/useExpandedArea';
import { insertAtCursor } from '../lib/insert-text';
import DictationButton from './DictationButton.vue';
import ExpandButton from './ExpandButton.vue';

const props = defineProps<{ topic?: string; description?: string }>();
const emit = defineEmits<{ save: [note: { topic: string; description: string }]; cancel: [] }>();

const topic = ref(props.topic ?? '');
const description = ref(props.description ?? '');
const topicInput = ref<HTMLInputElement | null>(null);
const descriptionInput = ref<HTMLTextAreaElement | null>(null);
const expanded = ref(false);
const expandedStyle = useExpandedArea(expanded, { coverDock: true, marginPx: 8 });
const canSave = computed(() => Boolean(topic.value.trim() || description.value.trim()));
const insertDictation = (text: string) => insertAtCursor(descriptionInput.value, description, text);

onMounted(() => topicInput.value?.focus());

function save() {
  if (canSave.value) emit('save', { topic: topic.value, description: description.value });
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('cancel');
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    save();
  }
}

function onTopicKeydown(event: KeyboardEvent) {
  onKeydown(event);
  if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
    event.preventDefault();
    descriptionInput.value?.focus();
  }
}
</script>

<template>
  <div class="note-editor" :class="{ expanded }" :style="expandedStyle ?? undefined">
    <input
      ref="topicInput"
      v-model="topic"
      class="topic"
      placeholder="Topic"
      aria-label="Topic"
      @keydown="onTopicKeydown"
    />
    <textarea
      ref="descriptionInput"
      v-model="description"
      class="description"
      rows="3"
      placeholder="Description (Markdown, ⌘↵ to save)"
      aria-label="Description"
      @keydown="onKeydown"
    />
    <div class="actions">
      <DictationButton :hint="topic" @text="insertDictation" />
      <ExpandButton v-model="expanded" />
      <span class="spacer" />
      <button type="button" @click="emit('cancel')">Cancel</button>
      <button type="button" class="primary" :disabled="!canSave" @click="save">Save</button>
    </div>
  </div>
</template>

<style scoped>
.note-editor {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.5rem 0.75rem;
  background: var(--surface);
  border: 1px solid var(--accent);
  border-radius: var(--radius);
}

.note-editor.expanded {
  z-index: 7;
  box-shadow: var(--shadow);
}

.topic,
.description {
  font: inherit;
  color: inherit;
  background: none;
  border: none;
  padding: 0.2rem 0;
  outline: none;
}

.topic {
  font-weight: 600;
}

.description {
  font-size: 0.9rem;
  resize: vertical;
}

.description:focus {
  outline: none;
}

.expanded .description {
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
