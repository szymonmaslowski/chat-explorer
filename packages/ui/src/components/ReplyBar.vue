<script setup lang="ts">
import type { Comment, CommentType, ReplyDraft } from '@shared/types';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import { useAutosave } from '../composables/useAutosave';
import { useExpandedArea } from '../composables/useExpandedArea';
import { insertAtCursor } from '../lib/insert-text';
import { transferredFiles } from '../lib/transferred-files';
import { replyFilesOwner, restoreFileDrafts, useFileDrafts } from '../stores/file-drafts';
import { newId, outbox } from '../stores/outbox';
import { replyDrafts } from '../stores/reply-drafts';
import AttachButton from './AttachButton.vue';
import DictationButton from './DictationButton.vue';
import DraftsMenu from './DraftsMenu.vue';
import ExpandButton from './ExpandButton.vue';
import FileDraftList from './FileDraftList.vue';
import ListenButton from './ListenButton.vue';
import MediaIcon from './MediaIcon.vue';

const props = defineProps<{
  explorationId: string;
  forkId: string;
  drafts: Comment[];
  // Claude is working on this fork, so the reply can also stop that and go first.
  answering: boolean;
  savedDraft: ReplyDraft | null;
  hint: string;
  // The message a general comment is written after; null while the fork has none.
  lastMessageId: string | null;
}>();
const emit = defineEmits<{ submitted: []; showDrafts: []; hideDrafts: [] }>();

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
const beingEdited = computed(() => props.drafts.filter((draft) => draft.editBody !== null));
const editingCount = computed(() => beingEdited.value.length);
const readyDrafts = computed(() => props.drafts.filter((draft) => draft.editBody === null));
const hasQuotedDrafts = computed(() => props.drafts.some((draft) => draft.quote !== ''));
// A comment in a fork group belongs to the group's fork, which counts once.
const countOf = (type: CommentType) =>
  readyDrafts.value.filter((draft) => draft.type === type && draft.forkGroupId === null).length;
const forkCount = computed(
  () =>
    new Set(
      readyDrafts.value
        .filter((draft) => draft.forkGroupId !== null || draft.type === 'fork')
        .map((draft) => draft.forkGroupId ?? draft.id),
    ).size,
);
const inlineCount = computed(() => countOf('inline'));
const noteCount = computed(() => countOf('note'));
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
    noteCount.value ? plural(noteCount.value, 'note') : '',
    forkCount.value ? plural(forkCount.value, 'fork') : '',
    newFork.value && reply ? `new fork with ${reply}` : reply,
  ]
    .filter(Boolean)
    .join(', ');
});
const hasSummary = computed(() => editingCount.value > 0 || summary.value !== '');
const hasAttachments = computed(() => files.drafts.value.length > 0);
const replyEmpty = computed(
  () => inlineCount.value === 0 && !text.value.trim() && fileCount.value === 0,
);
const canSubmit = computed(
  () =>
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
const autosave = useAutosave(() => {
  if (!pending) return;
  const { forkId, draft } = pending;
  pending = null;
  outbox.add({ type: 'reply-draft.save', explorationId: props.explorationId, forkId, draft });
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

// Another page or device may have changed the draft, or submitted it; a box with changes still
// on their way to the daemon is left alone.
const hasUnsavedChanges = () =>
  autosave.isDirty() || outbox.isPending(props.forkId) || files.uploading.value;

function applyIfChanged(draft: ReplyDraft) {
  const json = JSON.stringify({
    text: draft.text,
    newFork: draft.newFork,
    fileIds: draft.files.map((file) => file.id),
  });
  if (draft.forkId !== props.forkId || json === (lastSaved.get(draft.forkId) ?? emptyDraft)) return;
  applyDraft(draft);
}

watch(
  () => props.savedDraft,
  (draft) => {
    if (draft && !hasUnsavedChanges()) applyIfChanged(draft);
  },
);

async function refreshFromDaemon() {
  if (document.visibilityState !== 'visible') return;
  if (hasUnsavedChanges() || document.activeElement === textarea.value) return;
  const draft = await api.replyDraft(props.forkId).catch(() => null);
  if (draft) applyIfChanged(draft);
}
onMounted(() => document.addEventListener('visibilitychange', refreshFromDaemon));
onBeforeUnmount(() => document.removeEventListener('visibilitychange', refreshFromDaemon));

// Stops Claude's turn first, so the reply is answered on its own instead of joining the turn.
async function stopAndSubmit() {
  if (!canSubmit.value) return;
  await api.stopFork(props.forkId);
  submit();
}

function submit() {
  if (!canSubmit.value) return;
  const { explorationId, forkId } = props;
  const submission = {
    id: newId(),
    forkId,
    globalMessage: text.value,
    newFork: newFork.value,
    files: files.drafts.value.flatMap((draft) => (draft.file ? [draft.file] : [])),
  };
  autosave.finish(() => outbox.add({ type: 'submit', explorationId, submission }));
  lastSaved.set(forkId, emptyDraft);
  text.value = '';
  newFork.value = false;
  files.clear();
  expanded.value = false;
  emit('submitted');
}

function onPaste(event: ClipboardEvent) {
  const pasted = transferredFiles(event.clipboardData);
  if (pasted.length === 0) return;
  event.preventDefault();
  files.add(pasted);
}

// The text becomes a comment on the whole conversation, waiting for Submit with the others.
const canSaveAsComment = computed(() => text.value.trim() !== '' && props.lastMessageId !== null);
function saveAsComment() {
  const messageId = props.lastMessageId;
  if (!text.value.trim() || messageId === null) return;
  outbox.add({
    type: 'comment.create',
    explorationId: props.explorationId,
    comment: {
      id: newId(),
      messageId,
      viewForkId: props.forkId,
      quote: '',
      startOffset: 0,
      endOffset: 0,
      body: text.value.trim(),
    },
  });
  text.value = '';
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
  event.preventDefault();
  if (event.shiftKey) saveAsComment();
  else void submit();
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
    <div v-if="hasAttachments || hasSummary" class="above-reply">
      <FileDraftList class="attachments" :drafts="files.drafts.value" @remove="files.remove" />
      <p v-if="hasSummary" class="summary muted" :class="{ beside: hasAttachments }">
        <RouterLink
          v-if="editingCount"
          :to="{ hash: `#c-${beingEdited[0]!.id}` }"
          title="Save or cancel it to submit"
          >{{ plural(editingCount, 'comment') }} being edited</RouterLink
        ><template v-if="editingCount && summary">, </template>{{ summary }}
      </p>
      <DraftsMenu v-if="hasQuotedDrafts" @show="emit('showDrafts')" @hide="emit('hideDrafts')" />
    </div>
    <textarea
      ref="textarea"
      v-model="text"
      rows="2"
      placeholder="Reply to Claude (⌘↵ to send)"
      @keydown="onKeydown"
      @paste="onPaste"
    />
    <div class="actions">
      <label
        class="new-fork-toggle"
        title="Send the message and inline comments to a new fork, leaving this one as it is"
      >
        <input v-model="newFork" type="checkbox" />
        <MediaIcon name="fork" /><span class="visually-hidden">New fork</span>
      </label>
      <AttachButton @files="files.add" />
      <DictationButton :hint="hint" @text="insertDictation" />
      <ListenButton :text="text" />
      <ExpandButton v-model="expanded" />
      <button
        type="button"
        class="save-as-comment"
        aria-label="Save as comment"
        title="Save as a comment on the whole conversation (⌘⇧↵)"
        :disabled="!canSaveAsComment"
        @pointerdown.prevent
        @mousedown.prevent
        @click="saveAsComment"
      >
        <MediaIcon name="comment" />
      </button>
      <button
        v-if="answering"
        type="button"
        :disabled="!canSubmit"
        title="Stop Claude's current answer and send this instead"
        @click="stopAndSubmit"
      >
        Stop and send
      </button>
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
  gap: 0.4rem;
}

.save-as-comment {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: auto;
}

/* A checkbox drawn as an icon button, so the whole row fits on a phone. The real checkbox lies
   invisible over it and takes the taps. */
.new-fork-toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.3rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  cursor: pointer;
}

.new-fork-toggle input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.new-fork-toggle:has(input:checked) {
  border-color: var(--fork);
  background: var(--fork-soft);
  color: var(--fork);
}

.new-fork-toggle:has(input:focus-visible) {
  outline: 2px solid var(--accent);
}

@media (pointer: coarse) {
  .new-fork-toggle {
    min-width: 2.5rem;
    min-height: 2.5rem;
  }
}

.new-fork textarea {
  border-left: 3px solid var(--fork);
}

/* Attachments on the left, the summary on the right, next to the reply box below. Either takes
   the whole row when alone. */
.above-reply {
  display: flex;
  align-items: flex-end;
  gap: 0.75rem;
}

.attachments {
  flex: 1 1 auto;
  min-width: 0;
}

.summary {
  flex: 0 1 auto;
  margin: 0 0 0 auto;
  font-size: 0.85rem;
  text-align: right;
}

.summary.beside {
  flex-shrink: 0;
  max-width: 50%;
}
</style>
