<script setup lang="ts">
import type { Comment, ReplyDraft } from '@shared/types';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import { useAutosave } from '../composables/useAutosave';
import { useExpandedArea } from '../composables/useExpandedArea';
import { insertAtCursor } from '../lib/insert-text';
import { transferredFiles } from '../lib/transferred-files';
import { replyFilesOwner, restoreFileDrafts, useFileDrafts } from '../stores/file-drafts';
import { replyDrafts } from '../stores/reply-drafts';
import AttachButton from './AttachButton.vue';
import DictationButton from './DictationButton.vue';
import ExpandButton from './ExpandButton.vue';
import FileDraftList from './FileDraftList.vue';

const props = defineProps<{
  explorationId: string;
  forkId: string;
  drafts: Comment[];
  savedDraft: ReplyDraft | null;
  hint: string;
}>();
const emit = defineEmits<{ submitted: [] }>();

const sending = ref(false);
const error = ref('');
const textarea = ref<HTMLTextAreaElement | null>(null);
const expanded = ref(false);
const expandedStyle = useExpandedArea(expanded, { coverDock: true, marginPx: 0 });

const text = computed({
  get: () => replyDrafts.get(props.forkId),
  set: (value: string) => replyDrafts.set(props.forkId, value),
});
const newFork = computed({
  get: () => replyDrafts.newFork(props.forkId),
  set: (value: boolean) => replyDrafts.setNewFork(props.forkId, value),
});
const insertDictation = (dictated: string) => insertAtCursor(textarea.value, text, dictated);
const files = useFileDrafts(() => replyFilesOwner(props.forkId));
const fileCount = computed(() => files.readyIds.value.length);
const editingCount = computed(() => props.drafts.filter((draft) => draft.editBody !== null).length);
const readyDrafts = computed(() => props.drafts.filter((draft) => draft.editBody === null));
const forkCount = computed(() => readyDrafts.value.filter((draft) => draft.type === 'fork').length);
const inlineCount = computed(() => readyDrafts.value.length - forkCount.value);
const allForks = computed(() => props.drafts.length > 0 && forkCount.value === props.drafts.length);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const summary = computed(() => {
  const reply = [
    inlineCount.value ? plural(inlineCount.value, 'comment') : '',
    text.value.trim() ? 'message' : '',
    fileCount.value ? plural(fileCount.value, 'file') : '',
  ]
    .filter(Boolean)
    .join(', ');
  return [
    editingCount.value ? `${plural(editingCount.value, 'comment')} being edited` : '',
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
    editingCount.value === 0 &&
    summary.value !== '' &&
    !(newFork.value && replyEmpty.value),
);

// The box as the daemon last saw it, per fork, so only real changes are sent.
const lastSaved = new Map<string, string>();
const emptyDraft = JSON.stringify({ text: '', newFork: false, fileIds: [] });
const currentDraft = () => ({
  text: text.value,
  newFork: newFork.value,
  fileIds: files.readyIds.value,
});
let pending: { forkId: string; draft: ReturnType<typeof currentDraft> } | null = null;
const autosave = useAutosave(async (keepalive) => {
  if (!pending) return;
  const { forkId, draft } = pending;
  pending = null;
  await api.saveReplyDraft(forkId, draft, keepalive);
});

function applyDraft(draft: ReplyDraft) {
  text.value = draft.text;
  newFork.value = draft.newFork;
  files.clear();
  restoreFileDrafts(replyFilesOwner(draft.forkId), draft.files);
  lastSaved.set(
    draft.forkId,
    JSON.stringify({
      text: draft.text,
      newFork: draft.newFork,
      fileIds: draft.files.map((file) => file.id),
    }),
  );
}

// The page keeps each fork's box while it is open; the saved draft fills a box seen first.
watch(
  () => [props.forkId, props.savedDraft] as const,
  ([forkId, savedDraft]) => {
    if (replyDrafts.has(forkId)) return;
    if (savedDraft) applyDraft(savedDraft);
    else replyDrafts.set(forkId, '');
  },
  { immediate: true },
);

watch(
  () => [props.forkId, JSON.stringify(currentDraft())] as const,
  ([forkId, json]) => {
    if (json === (lastSaved.get(forkId) ?? emptyDraft)) return;
    lastSaved.set(forkId, json);
    pending = { forkId, draft: JSON.parse(json) };
    autosave.changed();
  },
);

// Another device may have changed the draft meanwhile; a box being typed in is left alone.
async function refreshFromDaemon() {
  if (document.visibilityState !== 'visible') return;
  if (autosave.isDirty() || files.uploading.value || document.activeElement === textarea.value) {
    return;
  }
  const forkId = props.forkId;
  const draft = await api.replyDraft(forkId).catch(() => null);
  const json =
    draft &&
    JSON.stringify({
      text: draft.text,
      newFork: draft.newFork,
      fileIds: draft.files.map((file) => file.id),
    });
  if (!draft || forkId !== props.forkId || json === lastSaved.get(forkId)) return;
  applyDraft(draft);
}
onMounted(() => document.addEventListener('visibilitychange', refreshFromDaemon));
onBeforeUnmount(() => document.removeEventListener('visibilitychange', refreshFromDaemon));

async function submit() {
  if (!canSubmit.value) return;
  sending.value = true;
  error.value = '';
  try {
    const forkId = props.forkId;
    await autosave.finish(() =>
      api.submit(props.explorationId, forkId, text.value, {
        newFork: newFork.value,
        fileIds: files.readyIds.value,
      }),
    );
    lastSaved.set(forkId, emptyDraft);
    text.value = '';
    newFork.value = false;
    files.clear();
    expanded.value = false;
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
    :class="{ 'new-fork': newFork, expanded }"
    :style="expandedStyle ?? undefined"
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
      <ExpandButton v-model="expanded" />
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

.reply-bar.expanded {
  z-index: 7;
  display: flex;
  flex-direction: column;
  background: var(--background);
}

.expanded textarea {
  flex: 1;
  resize: none;
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
