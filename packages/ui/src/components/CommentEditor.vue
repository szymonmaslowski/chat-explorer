<script setup lang="ts">
import { defaultGroupName } from '@shared/notes';
import type { CommentType } from '@shared/types';
import { computed, onMounted, ref, watch } from 'vue';
import { useAutosave } from '../composables/useAutosave';
import { useExpandedArea } from '../composables/useExpandedArea';
import type { TextAnchor } from '../lib/anchoring';
import { insertAtCursor } from '../lib/insert-text';
import { sortedGroups } from '../lib/notes';
import { transferredFiles } from '../lib/transferred-files';
import { openExploration } from '../stores/exploration';
import { commentFilesOwner, useFileDrafts } from '../stores/file-drafts';
import { newId, outbox } from '../stores/outbox';
import AttachButton from './AttachButton.vue';
import CommentTypePicker from './CommentTypePicker.vue';
import BoardColumnPicker from './BoardColumnPicker.vue';
import DictationButton from './DictationButton.vue';
import ExpandButton from './ExpandButton.vue';
import FileDraftList from './FileDraftList.vue';
import ListenButton from './ListenButton.vue';

const props = defineProps<{
  explorationId: string;
  viewForkId: string;
  messageId: string;
  anchor: TextAnchor;
}>();
const emit = defineEmits<{
  created: [commentId: string];
  close: [savedCommentId: string | null];
}>();

const newGroupChoice = '';

const body = ref('');
const type = ref<CommentType>('inline');
const groups = computed(() => sortedGroups(openExploration(props.explorationId).noteGroups));
const newGroupName = computed(() => defaultGroupName(groups.value.map((group) => group.name)));
// Undefined until the reader picks a group, which means the first one. Null asks for a new group,
// made on Submit, so a comment never sent leaves no empty group behind.
const chosenGroupId = ref<string | null | undefined>(undefined);
const noteGroupId = computed(() =>
  chosenGroupId.value === undefined ? (groups.value[0]?.id ?? null) : chosenGroupId.value,
);
const pickedGroup = computed({
  get: () => noteGroupId.value ?? newGroupChoice,
  set: (choice: string) => {
    chosenGroupId.value = choice === newGroupChoice ? null : choice;
  },
});
// Where the fork goes on the board, when this comment starts one. Null: its parent's column.
const boardColumnChoice = ref<string | null>(null);
const parentForkId = computed(
  () => openExploration(props.explorationId).messages.get(props.messageId)?.forkId,
);
const textarea = ref<HTMLTextAreaElement | null>(null);
const expanded = ref(false);
const expandedStyle = useExpandedArea(expanded, { coverDock: false, marginPx: 8 });
const insertDictation = (text: string) => insertAtCursor(textarea.value, body, text);
const target = () => ({
  messageId: props.messageId,
  viewForkId: props.viewForkId,
  ...props.anchor,
});

// The comment is stored from the first words on, as one still being written (empty body), so a
// closed page brings it back in its editor.
const commentId = newId();
let created = false;
const files = useFileDrafts(() => commentFilesOwner(commentId));
const canSave = computed(() => body.value.trim() !== '' && !files.uploading.value);

function onPaste(event: ClipboardEvent) {
  const pasted = transferredFiles(event.clipboardData);
  if (pasted.length === 0) return;
  event.preventDefault();
  files.add(pasted);
}
const autosave = useAutosave(() => {
  const { explorationId } = props;
  if (created) {
    outbox.add({
      type: 'comment.update',
      explorationId,
      commentId,
      changes: {
        editBody: body.value,
        type: type.value,
        noteGroupId: noteGroupId.value,
        boardColumnChoice: boardColumnChoice.value,
      },
    });
    return;
  }
  if (!body.value.trim()) return;
  outbox.add({
    type: 'comment.create',
    explorationId,
    comment: {
      id: commentId,
      ...target(),
      body: '',
      editBody: body.value,
      type: type.value,
      noteGroupId: noteGroupId.value,
      boardColumnChoice: boardColumnChoice.value,
    },
  });
  created = true;
  emit('created', commentId);
});
watch([body, type, noteGroupId, boardColumnChoice], autosave.changed);

onMounted(() => textarea.value?.focus());

function close(action: () => void, saved: boolean) {
  autosave.finish(action);
  emit('close', saved ? commentId : null);
}

function addSaved() {
  const { explorationId } = props;
  outbox.add(
    created
      ? {
          type: 'comment.update',
          explorationId,
          commentId,
          changes: {
            body: body.value,
            editBody: null,
            type: type.value,
            noteGroupId: noteGroupId.value,
            boardColumnChoice: boardColumnChoice.value,
            fileIds: files.readyIds.value,
          },
        }
      : {
          type: 'comment.create',
          explorationId,
          comment: {
            id: commentId,
            ...target(),
            body: body.value,
            type: type.value,
            noteGroupId: noteGroupId.value,
            boardColumnChoice: boardColumnChoice.value,
            fileIds: files.readyIds.value,
          },
        },
  );
  files.clear();
}

function save() {
  if (!canSave.value) return;
  close(addSaved, true);
}

function cancel() {
  files.discard();
  close(() => {
    if (created)
      outbox.add({ type: 'comment.delete', explorationId: props.explorationId, commentId });
  }, false);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') cancel();
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save();
}
</script>

<template>
  <div
    class="comment-editor"
    :class="[type, { expanded }]"
    :style="expandedStyle ?? undefined"
    @dragover.prevent
    @drop.prevent="files.add(transferredFiles($event.dataTransfer))"
  >
    <p class="quote">{{ anchor.quote }}</p>
    <textarea
      ref="textarea"
      v-model="body"
      rows="3"
      placeholder="Your comment (⌘↵ to save)"
      @keydown="onKeydown"
      @paste="onPaste"
    />
    <FileDraftList class="attachments" :drafts="files.drafts.value" @remove="files.remove" />
    <div class="actions">
      <div class="tools">
        <CommentTypePicker v-model="type" />
        <AttachButton @files="files.add" />
        <DictationButton :hint="anchor.quote" @text="insertDictation" />
        <ExpandButton v-model="expanded" />
        <ListenButton :text="body" />
      </div>
      <div class="final">
        <button type="button" @click="cancel">Cancel</button>
        <button type="button" class="primary" :disabled="!canSave" @click="save">Save</button>
      </div>
    </div>
    <BoardColumnPicker
      v-if="type === 'fork'"
      v-model="boardColumnChoice"
      :exploration-id="explorationId"
      :parent-fork-id="parentForkId"
    />
    <div v-if="type === 'note'" class="note-group">
      <select v-model="pickedGroup" aria-label="Note group">
        <option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option>
        <option :value="newGroupChoice">{{ newGroupName }} (new)</option>
      </select>
    </div>
  </div>
</template>

<style scoped>
.comment-editor {
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 0.5rem;
  font-size: 0.85rem;
}

.comment-editor.expanded {
  z-index: 7;
  display: flex;
  flex-direction: column;
}

.expanded textarea {
  flex: 1;
  resize: none;
}

.comment-editor.fork {
  border-left-color: var(--fork);
}

.comment-editor.note {
  border-left-color: var(--note);
}

.quote {
  margin: 0 0 0.4rem;
  color: var(--text-muted);
  max-height: 3.2em;
  overflow: hidden;
}

/* The tools wrap on the left; Cancel and Save stay together on the first line. */
.actions {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  margin-top: 0.4rem;
}

.tools {
  flex: 1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}

.final {
  display: flex;
  gap: 0.4rem;
}

.attachments {
  margin-top: 0.4rem;
}

.note-group {
  margin-top: 0.4rem;
}
</style>
