<script setup lang="ts">
import type { Comment, CommentChanges } from '@shared/types';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useAutosave } from '../composables/useAutosave';
import { useExpandedArea } from '../composables/useExpandedArea';
import { useProximityFade } from '../composables/useProximityFade';
import { insertAtCursor } from '../lib/insert-text';
import { outbox } from '../stores/outbox';
import DictationButton from './DictationButton.vue';
import ExpandButton from './ExpandButton.vue';

// Without a placement the card is listed in the page flow, on narrow and touch screens.
const props = defineProps<{
  comment: Comment;
  placement?: { top: number; left: number; width: number };
}>();
const emit = defineEmits<{
  measure: [height: number];
  open: [comment: Comment];
  jump: [comment: Comment];
}>();

const card = ref<HTMLElement | null>(null);
// An editor left open, on this device or another, reopens with its text.
const editing = ref(props.comment.editBody !== null);
const draftBody = ref(props.comment.editBody ?? '');
const editor = ref<HTMLTextAreaElement | null>(null);
const insertDictation = (text: string) => insertAtCursor(editor.value, draftBody, text);
const expanded = ref(false);
const expandedStyle = useExpandedArea(expanded, { coverDock: false, marginPx: 8 });
watch(editing, (isEditing) => {
  if (!isEditing) expanded.value = false;
});
const isDraft = computed(() => props.comment.status === 'draft');
const { opacity, interactive } = useProximityFade(
  card,
  computed(() => editing.value || !props.placement),
);

let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
  resizeObserver = new ResizeObserver(([entry]) => {
    // Expanded, the card floats over the page, so the cards below keep their places.
    if (entry && !expanded.value)
      emit('measure', entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height);
  });
  if (card.value) resizeObserver.observe(card.value);
});
onBeforeUnmount(() => resizeObserver?.disconnect());

const update = (changes: CommentChanges) =>
  outbox.add({
    type: 'comment.update',
    explorationId: props.comment.explorationId,
    commentId: props.comment.id,
    changes,
  });
const remove = () =>
  outbox.add({
    type: 'comment.delete',
    explorationId: props.comment.explorationId,
    commentId: props.comment.id,
  });

const autosave = useAutosave(() => update({ editBody: draftBody.value }));
watch(draftBody, () => {
  if (editing.value) autosave.changed();
});
watch(
  () => props.comment.editBody,
  (editBody) => {
    if (editBody !== null && !editing.value) {
      draftBody.value = editBody;
      editing.value = true;
    } else if (editBody === null && editing.value && !autosave.isDirty()) {
      editing.value = false;
    }
  },
);

async function startEditing() {
  draftBody.value = props.comment.body;
  editing.value = true;
  autosave.finish(() => update({ editBody: props.comment.body }));
  await nextTick();
  editor.value?.focus();
}

function save() {
  if (!draftBody.value.trim()) return;
  autosave.finish(() => update({ body: draftBody.value, editBody: null }));
  editing.value = false;
}

// A comment that was never saved has nothing to go back to, so cancelling deletes it.
function cancelEditing() {
  autosave.finish(() => (props.comment.body ? update({ editBody: null }) : remove()));
  editing.value = false;
}

const toggleType = () => update({ type: props.comment.type === 'fork' ? 'inline' : 'fork' });

function onEditorKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') void cancelEditing();
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void save();
}
</script>

<template>
  <div
    ref="card"
    class="comment-card"
    :class="[comment.type, comment.status, { listed: !placement, expanded }]"
    :style="
      expandedStyle ??
      (placement && {
        top: `${placement.top}px`,
        left: `${placement.left}px`,
        width: `${placement.width}px`,
        opacity,
        pointerEvents: interactive ? 'auto' : 'none',
      })
    "
    @click="comment.status === 'submitted' && emit('open', comment)"
  >
    <template v-if="editing">
      <textarea ref="editor" v-model="draftBody" rows="3" @keydown="onEditorKeydown" />
      <div class="actions">
        <DictationButton :hint="comment.quote" @text="insertDictation" />
        <ExpandButton v-model="expanded" />
        <span class="spacer" />
        <button type="button" @click="cancelEditing">Cancel</button>
        <button type="button" class="primary" :disabled="!draftBody.trim()" @click="save">
          Save
        </button>
      </div>
    </template>
    <template v-else>
      <div class="label">
        {{ comment.type === 'fork' ? 'Fork' : 'Comment' }}
        <span v-if="comment.status === 'queued'">· queued</span>
        <span v-if="comment.status === 'submitted'">· sent</span>
        <span v-if="outbox.stalled.value && outbox.isPending(comment.id)" class="unsent">
          · not sent yet
        </span>
      </div>
      <button
        v-if="!placement"
        type="button"
        class="quote"
        title="Show in the text"
        @click.stop="emit('jump', comment)"
      >
        <span class="arrow" aria-hidden="true">↑</span>
        <span class="quoted">{{ comment.quote }}</span>
      </button>
      <p class="body">{{ comment.body }}</p>
      <div v-if="isDraft" class="actions">
        <button
          type="button"
          :title="comment.type === 'fork' ? 'Answer in this fork instead' : 'Start a new fork'"
          @click="toggleType"
        >
          {{ comment.type === 'fork' ? 'Unfork' : 'Fork' }}
        </button>
        <button type="button" @click="startEditing">Edit</button>
        <button type="button" @click="remove">Delete</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.comment-card {
  position: absolute;
  z-index: 3;
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 0.4rem 0.6rem;
  font-size: 0.85rem;
  transition: opacity 120ms linear;
}

.comment-card.listed {
  position: static;
  box-shadow: none;
  margin-top: 0.4rem;
}

.comment-card.expanded {
  z-index: 7;
  display: flex;
  flex-direction: column;
  margin-top: 0;
}

.expanded textarea {
  flex: 1;
  resize: none;
}

.comment-card.fork {
  border-left-color: var(--fork);
}

.comment-card.submitted {
  box-shadow: none;
  background: var(--surface-muted);
  color: var(--text-muted);
  cursor: pointer;
  padding: 0.2rem 0.5rem;
}

.label {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--accent);
}

.label .unsent {
  color: var(--warning);
}

.fork .label {
  color: var(--fork);
}

.submitted .label {
  color: var(--text-muted);
}

.quote {
  display: flex;
  gap: 0.35rem;
  width: 100%;
  margin: 0.1rem 0 0;
  padding: 0 0 0 0.5rem;
  border: none;
  border-left: 2px solid var(--border);
  border-radius: 0;
  background: none;
  color: var(--text-muted);
  font-size: inherit;
  text-align: left;
}

.quote .arrow {
  color: var(--accent);
}

.quote .quoted {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.body {
  margin: 0.1rem 0 0;
  white-space: pre-wrap;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.submitted .body {
  -webkit-line-clamp: 1;
}

.actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 0.3rem;
  margin-top: 0.35rem;
}

.spacer {
  flex: 1;
}

.actions button {
  padding: 0.1rem 0.5rem;
  font-size: 0.75rem;
}

@media (pointer: coarse) {
  .actions button {
    padding: 0.1rem 0.8rem;
    font-size: 0.875rem;
  }
}
</style>
