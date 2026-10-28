<script setup lang="ts">
import type { Comment } from '@shared/types';
import { computed, ref } from 'vue';
import { api } from '../api';
import { insertAtCursor } from '../lib/insert-text';
import { transferredFiles } from '../lib/transferred-files';
import { replyFilesOwner, useFileDrafts } from '../stores/file-drafts';
import { replyDrafts } from '../stores/reply-drafts';
import AttachButton from './AttachButton.vue';
import DictationButton from './DictationButton.vue';
import FileDraftList from './FileDraftList.vue';

const props = defineProps<{
  explorationId: string;
  forkId: string;
  drafts: Comment[];
  hint: string;
}>();
const emit = defineEmits<{ submitted: [] }>();

const sending = ref(false);
const newFork = ref(false);
const error = ref('');
const textarea = ref<HTMLTextAreaElement | null>(null);

const text = computed({
  get: () => replyDrafts.get(props.forkId),
  set: (value: string) => replyDrafts.set(props.forkId, value),
});
const insertDictation = (dictated: string) => insertAtCursor(textarea.value, text, dictated);
const files = useFileDrafts(() => replyFilesOwner(props.forkId));
const fileCount = computed(() => files.readyIds.value.length);
const forkCount = computed(() => props.drafts.filter((draft) => draft.type === 'fork').length);
const inlineCount = computed(() => props.drafts.length - forkCount.value);
const allForks = computed(() => props.drafts.length > 0 && forkCount.value === props.drafts.length);
const summary = computed(() => {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const reply = [
    inlineCount.value ? plural(inlineCount.value, 'comment') : '',
    text.value.trim() ? 'message' : '',
    fileCount.value ? plural(fileCount.value, 'file') : '',
  ]
    .filter(Boolean)
    .join(', ');
  return [
    forkCount.value ? plural(forkCount.value, 'fork') : '',
    newFork.value && reply ? `new fork with ${reply}` : reply,
  ]
    .filter(Boolean)
    .join(', ');
});
const replyEmpty = computed(
  () => inlineCount.value === 0 && !text.value.trim() && fileCount.value === 0,
);
const canSubmit = computed(
  () =>
    !sending.value &&
    !files.uploading.value &&
    summary.value !== '' &&
    !(newFork.value && replyEmpty.value),
);

async function submit() {
  if (!canSubmit.value) return;
  sending.value = true;
  error.value = '';
  try {
    await api.submit(props.explorationId, props.forkId, text.value, {
      newFork: newFork.value,
      fileIds: files.readyIds.value,
    });
    text.value = '';
    newFork.value = false;
    files.clear();
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

function onPaste(event: ClipboardEvent) {
  const pasted = transferredFiles(event.clipboardData);
  if (pasted.length === 0) return;
  event.preventDefault();
  files.add(pasted);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void submit();
  }
}
</script>

<template>
  <form
    class="reply-bar"
    :class="{ 'new-fork': newFork }"
    @submit.prevent="submit"
    @dragover.prevent
    @drop.prevent="files.add(transferredFiles($event.dataTransfer))"
  >
    <textarea
      ref="textarea"
      v-model="text"
      rows="2"
      placeholder="Reply to Claude (⌘↵ to send)"
      @keydown="onKeydown"
      @paste="onPaste"
    />
    <FileDraftList :drafts="files.drafts.value" @remove="files.remove" />
    <div class="actions">
      <button
        type="button"
        :disabled="drafts.length === 0"
        :title="allForks ? 'Answer all comments in this fork' : 'Start a fork for every comment'"
        @click="toggleForkAll"
      >
        {{ allForks ? 'Unfork all' : 'Fork all' }}
      </button>
      <label
        class="new-fork-toggle"
        title="Send the message and inline comments to a new fork, leaving this one as it is"
      >
        <input v-model="newFork" type="checkbox" /> New fork
      </label>
      <AttachButton @files="files.add" />
      <DictationButton :hint="hint" @text="insertDictation" />
      <span class="spacer" />
      <span v-if="error" class="error">{{ error }}</span>
      <span v-else-if="summary" class="summary muted">{{ summary }}</span>
      <button type="submit" class="primary" :disabled="!canSubmit">Submit</button>
    </div>
  </form>
</template>

<style scoped>
.reply-bar {
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

.new-fork-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.85rem;
  white-space: nowrap;
}

.new-fork textarea {
  border-left: 3px solid var(--fork);
}

.summary {
  font-size: 0.85rem;
}

.error {
  color: var(--danger);
  font-size: 0.85rem;
}
</style>
