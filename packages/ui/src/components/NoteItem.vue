<script setup lang="ts">
import { renderMarkdown } from '@shared/markdown';
import type { Note, NoteGroup } from '@shared/types';
import { computed, ref, watch } from 'vue';
import { outbox } from '../stores/outbox';
import ConfirmButton from './ConfirmButton.vue';

const props = defineProps<{
  note: Note;
  selected: boolean;
  readOnly: boolean;
  checklist: boolean;
  otherGroups: NoteGroup[];
}>();
const emit = defineEmits<{
  toggleSelected: [];
  edit: [];
  delete: [];
  keep: [];
  toggleChecked: [];
  dragStart: [event: PointerEvent];
  // Null asks for a new group.
  changeGroup: [groupId: string | null];
}>();

const expanded = ref(false);
const choosingGroup = ref(false);
const html = computed(() => (props.note.description ? renderMarkdown(props.note.description) : ''));

watch(
  () => props.selected,
  (selected) => {
    if (!selected) choosingGroup.value = false;
  },
);

// Ending a text selection inside the note is not a tap on it.
function onClick() {
  if (window.getSelection()?.toString()) return;
  emit('toggleSelected');
}

function changeGroup(groupId: string | null) {
  choosingGroup.value = false;
  emit('changeGroup', groupId);
}
</script>

<template>
  <article
    :id="`n-${note.id}`"
    class="note"
    :class="{
      selected,
      expanded,
      checked: checklist && note.checked,
      'deletion-requested': note.deletionRequestedAt !== null,
    }"
    @click="onClick"
  >
    <h3 class="topic" :class="{ preparing: note.topic === null }">
      {{ note.topic ?? 'Preparing topic…' }}
      <span v-if="outbox.stalled.value && outbox.isPending(note.id)" class="unsent">
        · not sent yet
      </span>
    </h3>
    <div v-if="html" class="description" v-html="html" />
    <div v-if="note.deletionRequestedAt !== null && !readOnly" class="deletion-request" @click.stop>
      <span>Claude asks to delete this note.</span>
      <button type="button" class="danger" @click="emit('delete')">Delete</button>
      <button type="button" @click="emit('keep')">Keep</button>
    </div>
    <div v-if="selected" class="actions" @click.stop>
      <button
        v-if="!readOnly"
        type="button"
        class="handle"
        aria-label="Drag to reorder"
        title="Drag to reorder"
        @pointerdown="emit('dragStart', $event)"
      >
        ⠿
      </button>
      <button v-if="checklist && !readOnly" type="button" @click="emit('toggleChecked')">
        {{ note.checked ? 'Uncheck' : 'Check' }}
      </button>
      <button v-if="html" type="button" @click="expanded = !expanded">
        {{ expanded ? 'Collapse' : 'Expand' }}
      </button>
      <template v-if="!readOnly">
        <button type="button" @click="emit('edit')">Edit</button>
        <button
          type="button"
          :aria-expanded="choosingGroup"
          @click="choosingGroup = !choosingGroup"
        >
          Move
        </button>
        <ConfirmButton label="Delete" danger @confirm="emit('delete')" />
      </template>
    </div>
    <div v-if="selected && choosingGroup" class="group-choices" role="menu" @click.stop>
      <span class="muted">Move to</span>
      <button
        v-for="group in otherGroups"
        :key="group.id"
        type="button"
        role="menuitem"
        @click="changeGroup(group.id)"
      >
        {{ group.name }}
      </button>
      <button type="button" role="menuitem" @click="changeGroup(null)">New group…</button>
    </div>
  </article>
</template>

<style scoped>
.note {
  padding: 0.6rem 0.75rem;
  border: 1px solid transparent;
  border-radius: var(--radius);
  cursor: pointer;
  scroll-margin-top: 8rem;
}

.note:hover {
  background: var(--surface-muted);
}

.note.selected {
  background: var(--surface);
  border-color: var(--border);
  cursor: default;
}

.checked .topic,
.checked .description {
  color: var(--text-muted);
  opacity: 0.6;
}

.checked .topic,
.deletion-requested .topic {
  text-decoration: line-through;
}

.deletion-request {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem;
  margin-top: 0.4rem;
  font-size: 0.8rem;
  color: var(--warning);
}

.deletion-request button {
  padding: 0.1rem 0.5rem;
  font-size: 0.75rem;
}

.deletion-request .danger {
  color: var(--danger);
  border-color: var(--danger);
}

.topic {
  margin: 0;
  font-size: 1rem;
  overflow-wrap: anywhere;
}

.topic.preparing {
  color: var(--text-muted);
  font-weight: 400;
  font-style: italic;
}

.unsent {
  color: var(--warning);
  font-size: 0.8rem;
  font-weight: 400;
}

.description {
  font-size: 0.9rem;
  color: var(--text-muted);
  overflow-wrap: anywhere;
}

/* One line until expanded: the blocks run inline so the clamp can end the line with an ellipsis. */
.note:not(.expanded) .description {
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.note:not(.expanded) .description :deep(*) {
  display: inline;
  margin: 0;
  padding: 0;
  font-size: inherit;
}

.note:not(.expanded) .description :deep(* + *)::before {
  content: ' ';
}

.expanded .description {
  color: var(--text);
}

.expanded .description :deep(:first-child) {
  margin-top: 0.3rem;
}

.actions,
.group-choices {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem;
  margin-top: 0.4rem;
}

.actions button,
.group-choices button {
  padding: 0.1rem 0.5rem;
  font-size: 0.75rem;
}

.actions .handle {
  touch-action: none;
  cursor: grab;
  font-size: 1rem;
  line-height: 1;
  padding: 0.1rem 0.45rem;
}

.group-choices .muted {
  font-size: 0.8rem;
}

@media (pointer: coarse) {
  .actions button,
  .group-choices button {
    padding: 0.2rem 0.8rem;
    font-size: 0.875rem;
  }
}
</style>
