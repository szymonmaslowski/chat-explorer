<script setup lang="ts">
import { defaultGroupName } from '@shared/notes';
import type { CommentType } from '@shared/types';
import { computed, onMounted, ref, watch } from 'vue';
import { useAutosave } from '../composables/useAutosave';
import { useExpandedArea } from '../composables/useExpandedArea';
import type { TextAnchor } from '../lib/anchoring';
import { insertAtCursor } from '../lib/insert-text';
import { sortedGroups } from '../lib/notes';
import { openExploration } from '../stores/exploration';
import { newId, outbox } from '../stores/outbox';
import CommentTypePicker from './CommentTypePicker.vue';
import DictationButton from './DictationButton.vue';
import ExpandButton from './ExpandButton.vue';
import ListenButton from './ListenButton.vue';

const props = defineProps<{
  explorationId: string;
  viewForkId: string;
  messageId: string;
  anchor: TextAnchor;
  top: number;
  left: number;
  width: number;
  inRail: boolean;
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
const autosave = useAutosave(() => {
  const { explorationId } = props;
  if (created) {
    outbox.add({
      type: 'comment.update',
      explorationId,
      commentId,
      changes: { editBody: body.value, type: type.value, noteGroupId: noteGroupId.value },
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
    },
  });
  created = true;
  emit('created', commentId);
});
watch([body, type, noteGroupId], autosave.changed);

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
          },
        },
  );
}

function save() {
  if (!body.value.trim()) return;
  close(addSaved, true);
}

function forkNow() {
  if (!body.value.trim()) return;
  const { explorationId, viewForkId } = props;
  close(() => {
    addSaved();
    outbox.add({
      type: 'fork-now',
      explorationId,
      submissionId: newId(),
      forkId: viewForkId,
      commentId,
    });
  }, true);
}

function cancel() {
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
    :class="[type, { expanded, 'in-rail': inRail }]"
    :style="
      expandedStyle ??
      (inRail ? { top: `${top}px`, left: `${left}px`, width: `${width}px` } : undefined)
    "
  >
    <p class="quote">{{ anchor.quote }}</p>
    <textarea
      ref="textarea"
      v-model="body"
      rows="3"
      placeholder="Your comment (⌘↵ to save)"
      @keydown="onKeydown"
    />
    <div class="actions">
      <CommentTypePicker v-model="type" />
      <DictationButton :hint="anchor.quote" @text="insertDictation" />
      <ListenButton :text="body" />
      <ExpandButton v-model="expanded" />
      <span class="spacer" />
      <button type="button" @click="cancel">Cancel</button>
      <button v-if="type === 'fork'" type="button" :disabled="!body.trim()" @click="forkNow">
        Fork now
      </button>
      <button type="button" class="primary" :disabled="!body.trim()" @click="save">Save</button>
    </div>
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

.comment-editor.in-rail {
  position: absolute;
  z-index: 4;
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

.note-group {
  display: flex;
  justify-content: flex-end;
  margin-top: 0.4rem;
}
</style>
