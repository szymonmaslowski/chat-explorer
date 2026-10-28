<script setup lang="ts">
import type { CommentType } from '@shared/types';
import { onMounted, ref, watch } from 'vue';
import { api } from '../api';
import { useAutosave } from '../composables/useAutosave';
import type { TextAnchor } from '../lib/anchoring';
import { insertAtCursor } from '../lib/insert-text';
import DictationButton from './DictationButton.vue';

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
const error = ref('');
const textarea = ref<HTMLTextAreaElement | null>(null);
const insertDictation = (text: string) => insertAtCursor(textarea.value, body, text);
const type = (): CommentType => (asFork.value ? 'fork' : 'inline');
const target = () => ({
  messageId: props.messageId,
  viewForkId: props.viewForkId,
  ...props.anchor,
});

// The comment is stored from the first words on, as one still being written (empty body), so a
// closed page brings it back in its editor.
let commentId: string | null = null;
const autosave = useAutosave(async (keepalive) => {
  if (commentId) {
    await api.updateComment(commentId, { editBody: body.value, type: type() }, keepalive);
    return;
  }
  if (!body.value.trim()) return;
  const comment = await api.createComment(
    props.explorationId,
    { ...target(), body: '', editBody: body.value, type: type() },
    keepalive,
  );
  commentId = comment.id;
  emit('created', comment.id);
});
watch([body, asFork], autosave.changed);

onMounted(() => textarea.value?.focus());

async function close(operation: () => Promise<unknown>) {
  error.value = '';
  try {
    await autosave.finish(operation);
    emit('close');
  } catch {
    error.value = 'Could not save. Is the chat-explorer daemon running?';
  }
}

function save() {
  if (!body.value.trim()) return;
  void close(() =>
    commentId
      ? api.updateComment(commentId, { body: body.value, editBody: null, type: type() })
      : api.createComment(props.explorationId, { ...target(), body: body.value, type: type() }),
  );
}

function cancel() {
  void close(async () => {
    if (commentId) await api.deleteComment(commentId);
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
    :class="{ fork: asFork }"
    :style="{ top: `${top}px`, left: `${left}px`, width: `${width}px` }"
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
      <span class="spacer" />
      <span v-if="error" class="error" role="alert">{{ error }}</span>
      <button type="button" @click="cancel">Cancel</button>
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
