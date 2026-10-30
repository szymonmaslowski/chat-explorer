<script setup lang="ts">
import type { CommentType } from '@shared/types';
import { onMounted, ref, watch } from 'vue';
import { useAutosave } from '../composables/useAutosave';
import { useExpandedArea } from '../composables/useExpandedArea';
import type { TextAnchor } from '../lib/anchoring';
import { insertAtCursor } from '../lib/insert-text';
import { newId, outbox } from '../stores/outbox';
import DictationButton from './DictationButton.vue';
import ExpandButton from './ExpandButton.vue';

const props = defineProps<{
  explorationId: string;
  viewForkId: string;
  messageId: string;
  anchor: TextAnchor;
  top: number;
  left: number;
  width: number;
}>();
const emit = defineEmits<{ created: [commentId: string]; close: [] }>();

const body = ref('');
const asFork = ref(false);
const textarea = ref<HTMLTextAreaElement | null>(null);
const expanded = ref(false);
const expandedStyle = useExpandedArea(expanded, { coverDock: false, marginPx: 8 });
const insertDictation = (text: string) => insertAtCursor(textarea.value, body, text);
const type = (): CommentType => (asFork.value ? 'fork' : 'inline');
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
      changes: { editBody: body.value, type: type() },
    });
    return;
  }
  if (!body.value.trim()) return;
  outbox.add({
    type: 'comment.create',
    explorationId,
    comment: { id: commentId, ...target(), body: '', editBody: body.value, type: type() },
  });
  created = true;
  emit('created', commentId);
});
watch([body, asFork], autosave.changed);

onMounted(() => textarea.value?.focus());

function close(action: () => void) {
  autosave.finish(action);
  emit('close');
}

function addSaved() {
  const { explorationId } = props;
  outbox.add(
    created
      ? {
          type: 'comment.update',
          explorationId,
          commentId,
          changes: { body: body.value, editBody: null, type: type() },
        }
      : {
          type: 'comment.create',
          explorationId,
          comment: { id: commentId, ...target(), body: body.value, type: type() },
        },
  );
}

function save() {
  if (!body.value.trim()) return;
  close(addSaved);
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
  });
}

function cancel() {
  close(() => {
    if (created)
      outbox.add({ type: 'comment.delete', explorationId: props.explorationId, commentId });
  });
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') cancel();
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save();
}
</script>

<template>
  <div
    class="comment-editor"
    :class="{ fork: asFork, expanded }"
    :style="expandedStyle ?? { top: `${top}px`, left: `${left}px`, width: `${width}px` }"
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
      <label><input v-model="asFork" type="checkbox" /> Fork</label>
      <DictationButton :hint="anchor.quote" @text="insertDictation" />
      <ExpandButton v-model="expanded" />
      <span class="spacer" />
      <button type="button" @click="cancel">Cancel</button>
      <button v-if="asFork" type="button" :disabled="!body.trim()" @click="forkNow">
        Fork now
      </button>
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

.comment-editor.expanded {
  z-index: 7;
  display: flex;
  flex-direction: column;
  transform: none;
  margin-top: 0;
}

.expanded textarea {
  flex: 1;
  resize: none;
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
