<script setup lang="ts">
import type { Comment } from '@shared/types';
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '../api';
import { useProximityFade } from '../composables/useProximityFade';

// Without a placement the card is listed in the page flow, on narrow and touch screens.
const props = defineProps<{
  comment: Comment;
  placement?: { top: number; left: number; width: number };
}>();
const emit = defineEmits<{ measure: [height: number]; open: [comment: Comment] }>();

const card = ref<HTMLElement | null>(null);
const editing = ref(false);
const draftBody = ref('');
const busy = ref(false);
const isDraft = computed(() => props.comment.status === 'draft');
const { opacity, interactive } = useProximityFade(
  card,
  computed(() => editing.value || !props.placement),
);

let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
  resizeObserver = new ResizeObserver(([entry]) => {
    if (entry) emit('measure', entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height);
  });
  if (card.value) resizeObserver.observe(card.value);
});
onBeforeUnmount(() => resizeObserver?.disconnect());

const run = async (action: () => Promise<unknown>) => {
  busy.value = true;
  try {
    await action();
  } finally {
    busy.value = false;
  }
};

async function startEditing() {
  draftBody.value = props.comment.body;
  editing.value = true;
  await nextTick();
  card.value?.querySelector('textarea')?.focus();
}

const save = () =>
  run(async () => {
    if (!draftBody.value.trim()) return;
    await api.updateComment(props.comment.id, { body: draftBody.value });
    editing.value = false;
  });

const toggleType = () =>
  run(() =>
    api.updateComment(props.comment.id, {
      type: props.comment.type === 'fork' ? 'inline' : 'fork',
    }),
  );

const remove = () => run(() => api.deleteComment(props.comment.id));

function onEditorKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') editing.value = false;
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void save();
}
</script>

<template>
  <div
    ref="card"
    class="comment-card"
    :class="[comment.type, comment.status, { listed: !placement }]"
    :style="
      placement && {
        top: `${placement.top}px`,
        left: `${placement.left}px`,
        width: `${placement.width}px`,
        opacity,
        pointerEvents: interactive ? 'auto' : 'none',
      }
    "
    @click="comment.status === 'submitted' && emit('open', comment)"
  >
    <template v-if="editing">
      <textarea v-model="draftBody" rows="3" @keydown="onEditorKeydown" />
      <div class="actions">
        <button type="button" @click="editing = false">Cancel</button>
        <button type="button" class="primary" :disabled="busy" @click="save">Save</button>
      </div>
    </template>
    <template v-else>
      <div class="label">
        {{ comment.type === 'fork' ? 'Fork' : 'Comment' }}
        <span v-if="comment.status === 'queued'">· queued</span>
        <span v-if="comment.status === 'submitted'">· sent</span>
      </div>
      <p v-if="!placement" class="quote">{{ comment.quote }}</p>
      <p class="body">{{ comment.body }}</p>
      <div v-if="isDraft" class="actions">
        <button
          type="button"
          :disabled="busy"
          :title="comment.type === 'fork' ? 'Answer in this fork instead' : 'Start a new fork'"
          @click="toggleType"
        >
          {{ comment.type === 'fork' ? 'Unfork' : 'Fork' }}
        </button>
        <button type="button" :disabled="busy" @click="startEditing">Edit</button>
        <button type="button" :disabled="busy" @click="remove">Delete</button>
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

.fork .label {
  color: var(--fork);
}

.submitted .label {
  color: var(--text-muted);
}

.quote {
  margin: 0.1rem 0 0;
  padding-left: 0.5rem;
  border-left: 2px solid var(--border);
  color: var(--text-muted);
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
  gap: 0.3rem;
  margin-top: 0.35rem;
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
