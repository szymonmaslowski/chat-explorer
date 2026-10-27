<script setup lang="ts">
import type { Comment } from '@shared/types';
import { computed, ref } from 'vue';
import { api } from '../api';
import { insertAtCursor } from '../lib/insert-text';
import { replyDrafts } from '../stores/reply-drafts';
import DictationButton from './DictationButton.vue';

const props = defineProps<{
  explorationId: string;
  forkId: string;
  drafts: Comment[];
  hint: string;
}>();
const emit = defineEmits<{ submitted: [] }>();

const sending = ref(false);
const error = ref('');
const textarea = ref<HTMLTextAreaElement | null>(null);

const text = computed({
  get: () => replyDrafts.get(props.forkId),
  set: (value: string) => replyDrafts.set(props.forkId, value),
});
const forkCount = computed(() => props.drafts.filter((draft) => draft.type === 'fork').length);
const inlineCount = computed(() => props.drafts.length - forkCount.value);
const allForks = computed(() => props.drafts.length > 0 && forkCount.value === props.drafts.length);
const summary = computed(() => {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  return [
    forkCount.value ? plural(forkCount.value, 'fork') : '',
    inlineCount.value ? plural(inlineCount.value, 'comment') : '',
    text.value.trim() ? 'message' : '',
  ]
    .filter(Boolean)
    .join(', ');
});
const canSubmit = computed(() => !sending.value && summary.value !== '');

async function submit() {
  if (!canSubmit.value) return;
  sending.value = true;
  error.value = '';
  try {
    await api.submit(props.explorationId, props.forkId, text.value);
    text.value = '';
    emit('submitted');
  } catch {
    error.value = 'Could not send. Is the chat-explorer daemon running?';
  } finally {
    sending.value = false;
  }
}

async function toggleForkAll() {
  await api.toggleForkAll(props.explorationId, props.forkId);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void submit();
  }
}
</script>

<template>
  <form class="reply-bar" @submit.prevent="submit">
    <textarea
      ref="textarea"
      v-model="text"
      rows="2"
      placeholder="Reply to Claude (⌘↵ to send)"
      @keydown="onKeydown"
    />
    <div class="actions">
      <button
        type="button"
        :disabled="drafts.length === 0"
        :title="allForks ? 'Answer all comments in this fork' : 'Start a fork for every comment'"
        @click="toggleForkAll"
      >
        {{ allForks ? 'Unfork all' : 'Fork all' }}
      </button>
      <DictationButton
        :hint="hint"
        @text="(dictated) => (text = insertAtCursor(textarea, text, dictated))"
      />
      <span class="spacer" />
      <span v-if="error" class="error">{{ error }}</span>
      <span v-else-if="summary" class="summary muted">{{ summary }}</span>
      <button type="submit" class="primary" :disabled="!canSubmit">Submit</button>
    </div>
  </form>
</template>

<style scoped>
.reply-bar {
  position: sticky;
  bottom: 0;
  z-index: 5;
  background: var(--background);
  padding: 0.75rem 0 1rem;
  border-top: 1px solid var(--border);
  display: grid;
  gap: 0.5rem;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
}

.spacer {
  flex: 1;
}

.summary {
  font-size: 0.85rem;
}

.error {
  color: var(--danger);
  font-size: 0.85rem;
}
</style>
