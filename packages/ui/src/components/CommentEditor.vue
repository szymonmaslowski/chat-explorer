<script setup lang="ts">
import type { CommentType } from '@shared/types';
import { onMounted, ref } from 'vue';
import { insertAtCursor } from '../lib/insert-text';
import DictationButton from './DictationButton.vue';

defineProps<{ quote: string; top: number; left: number; width: number }>();
const emit = defineEmits<{ save: [body: string, type: CommentType]; cancel: [] }>();

const body = ref('');
const asFork = ref(false);
const textarea = ref<HTMLTextAreaElement | null>(null);
const insertDictation = (text: string) => insertAtCursor(textarea.value, body, text);

onMounted(() => textarea.value?.focus());

function save() {
  if (body.value.trim()) emit('save', body.value, asFork.value ? 'fork' : 'inline');
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('cancel');
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save();
}
</script>

<template>
  <div
    class="comment-editor"
    :class="{ fork: asFork }"
    :style="{ top: `${top}px`, left: `${left}px`, width: `${width}px` }"
  >
    <p class="quote">{{ quote }}</p>
    <textarea
      ref="textarea"
      v-model="body"
      rows="3"
      placeholder="Your comment (⌘↵ to save)"
      @keydown="onKeydown"
    />
    <div class="actions">
      <label><input v-model="asFork" type="checkbox" /> Fork</label>
      <DictationButton :hint="quote" @text="insertDictation" />
      <span class="spacer" />
      <button type="button" @click="emit('cancel')">Cancel</button>
      <button type="button" class="primary" :disabled="!body.trim()" @click="save">Save</button>
    </div>
  </div>
</template>

<style scoped>
.comment-editor {
  position: absolute;
  z-index: 4;
  transform: translateY(-100%);
  margin-top: -6px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 0.5rem;
  font-size: 0.85rem;
}

.comment-editor.fork {
  border-left-color: var(--fork);
}

.quote {
  margin: 0 0 0.4rem;
  color: var(--text-muted);
  max-height: 3.2em;
  overflow: hidden;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.4rem;
}

.spacer {
  flex: 1;
}
</style>
