<script setup lang="ts">
import { renderMarkdown } from '@shared/markdown';
import type { Note, NoteGroup } from '@shared/types';
import { computed, ref, shallowRef, watch } from 'vue';
import { useCopied } from '../composables/useCopied';
import { bringToReadingLine } from '../lib/reading-line';
import { blockIndexAt, speechBlocks, type SpokenElement } from '../lib/speech-blocks';
import { outbox } from '../stores/outbox';
import {
  checkSpeechAvailable,
  playBlock,
  playFrom,
  speech,
  speechSourceId,
  togglePause,
} from '../stores/speech';
import ConfirmButton from './ConfirmButton.vue';
import MediaIcon from './MediaIcon.vue';
import NoteForkComposer from './NoteForkComposer.vue';

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
  fork: [message: string];
}>();

// A checklist keeps its notes to one line, opened one by one; elsewhere picking a note opens it.
const expandedByButton = ref(false);
const expanded = computed(() => (props.checklist ? expandedByButton.value : props.selected));
const choosingGroup = ref(false);
const forking = ref(false);
const { copied, copy } = useCopied();
const html = computed(() => (props.note.description ? renderMarkdown(props.note.description) : ''));

const article = ref<HTMLElement | null>(null);
const descriptionElement = ref<HTMLElement | null>(null);
const blocks = shallowRef<SpokenElement[]>([]);
const pickedIndex = ref<number | null>(null);
const pickedTop = ref(0);
const speechSource = computed(() => ({ text: props.note.description }));
const listenable = computed(
  () => speech.available && props.selected && expanded.value && blocks.value.length > 0,
);
const speakingIndex = computed(() =>
  speech.playback?.id === speechSourceId(speechSource.value) ? speech.playback.index : -1,
);
const pickedPlaying = computed(
  () => speech.playing && pickedIndex.value !== null && speakingIndex.value === pickedIndex.value,
);

void checkSpeechAvailable();

watch(
  () => props.selected,
  (selected) => {
    if (!selected) choosingGroup.value = false;
  },
);

watch(
  [html, descriptionElement],
  () => {
    blocks.value = descriptionElement.value ? speechBlocks(descriptionElement.value) : [];
  },
  { flush: 'post' },
);

watch(listenable, (canListen) => {
  if (!canListen) pickBlock(null);
});

watch(
  [speakingIndex, blocks],
  ([index], [previousIndex]) => {
    for (const [position, { element }] of blocks.value.entries()) {
      element.classList.toggle('speaking', position === index);
    }
    const current = blocks.value[index];
    if (current && index !== previousIndex) bringToReadingLine(current.element);
  },
  { flush: 'post' },
);

function pickBlock(index: number | null) {
  if (pickedIndex.value !== null)
    blocks.value[pickedIndex.value]?.element.classList.remove('picked');
  pickedIndex.value = index;
  const element = index === null ? undefined : blocks.value[index]?.element;
  if (!element || !article.value) return;
  element.classList.add('picked');
  pickedTop.value = element.getBoundingClientRect().top - article.value.getBoundingClientRect().top;
}

// In an expanded note, a tap on a block of the description picks it to read aloud from there.
function pickBlockAt(target: EventTarget | null) {
  if (!listenable.value || !(target instanceof Element) || target.closest('a')) return false;
  if (!descriptionElement.value?.contains(target)) return false;
  const index = blockIndexAt(blocks.value, target);
  if (index === -1) return false;
  pickBlock(index === pickedIndex.value ? null : index);
  return true;
}

// Ending a text selection inside the note is not a tap on it.
function onClick(event: MouseEvent) {
  if (window.getSelection()?.toString()) return;
  if (pickBlockAt(event.target)) return;
  emit('toggleSelected');
}

const spokenBlocks = () => blocks.value.map(({ block }) => block);

function listen() {
  if (speakingIndex.value === -1) playFrom(speechSource.value, spokenBlocks(), 0);
  else togglePause();
}

function playPicked() {
  if (pickedIndex.value === null) return;
  playBlock(speechSource.value, spokenBlocks(), pickedIndex.value);
  pickBlock(null);
}

function createFork(message: string) {
  forking.value = false;
  emit('fork', message);
}

function changeGroup(groupId: string | null) {
  choosingGroup.value = false;
  emit('changeGroup', groupId);
}
</script>

<template>
  <article
    ref="article"
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
    <button
      v-if="listenable"
      type="button"
      class="listen"
      :aria-label="speakingIndex === -1 ? 'Listen' : speech.playing ? 'Pause' : 'Resume'"
      @click.stop="listen"
    >
      <MediaIcon :name="speakingIndex !== -1 && speech.playing ? 'pause' : 'play'" />
      {{ speakingIndex === -1 ? 'Listen' : speech.playing ? 'Pause' : 'Resume' }}
    </button>
    <div v-if="html" ref="descriptionElement" class="description" v-html="html" />
    <button
      v-if="pickedIndex !== null"
      type="button"
      class="block-play"
      :style="{ top: `${pickedTop}px` }"
      :aria-label="pickedPlaying ? 'Pause' : 'Read aloud from here'"
      :title="pickedPlaying ? 'Pause' : 'Read aloud from here'"
      @click.stop="playPicked"
    >
      <MediaIcon :name="pickedPlaying ? 'pause' : 'play'" />
    </button>
    <div v-if="note.deletionRequestedAt !== null && !readOnly" class="deletion-request" @click.stop>
      <span>Claude asks to delete this note.</span>
      <ConfirmButton label="Delete" danger @confirm="emit('delete')" />
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
        <MediaIcon name="grip" />
      </button>
      <button
        v-if="html && checklist"
        type="button"
        :aria-label="expanded ? 'Collapse' : 'Expand'"
        :title="expanded ? 'Collapse' : 'Expand'"
        @click="expandedByButton = !expandedByButton"
      >
        <MediaIcon :name="expanded ? 'shrink' : 'expand'" />
      </button>
      <template v-if="!readOnly">
        <button type="button" aria-label="Edit" title="Edit" @click="emit('edit')">
          <MediaIcon name="edit" />
        </button>
        <button
          type="button"
          :aria-expanded="forking"
          aria-label="New fork"
          title="New fork about this note"
          @click="forking = !forking"
        >
          <MediaIcon name="fork" />
        </button>
        <button
          type="button"
          :aria-expanded="choosingGroup"
          aria-label="Move"
          title="Move to another group"
          @click="choosingGroup = !choosingGroup"
        >
          <MediaIcon name="move" />
        </button>
        <ConfirmButton label="Delete" danger title="Delete" @confirm="emit('delete')">
          <MediaIcon name="trash" /><span class="visually-hidden">Delete</span>
        </ConfirmButton>
      </template>
    </div>
    <div v-if="selected" class="note-id" @click.stop>
      <span class="muted">ID</span>
      <code>{{ note.id }}</code>
      <button
        type="button"
        :aria-label="copied ? 'Copied' : 'Copy ID'"
        :title="copied ? 'Copied' : 'Copy ID'"
        @click="copy({ plain: note.id })"
      >
        <MediaIcon :name="copied ? 'check' : 'copy'" />
      </button>
      <button
        v-if="checklist && !readOnly"
        type="button"
        class="check-button"
        :class="{ on: note.checked }"
        :aria-label="note.checked ? 'Uncheck' : 'Check'"
        :title="note.checked ? 'Uncheck' : 'Check'"
        @click="emit('toggleChecked')"
      >
        <MediaIcon name="check" />
      </button>
    </div>
    <NoteForkComposer
      v-if="forking && !readOnly"
      :topic="note.topic"
      @click.stop
      @create="createFork"
      @cancel="forking = false"
    />
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
  position: relative;
  padding: 0.6rem 0.75rem;
  border: 1px solid transparent;
  border-radius: var(--radius);
  cursor: pointer;
  scroll-margin-top: 8rem;
}

/* A touch screen keeps hover on whatever ends up under the finger, so only a mouse gets it. */
@media (hover: hover) {
  .note:hover {
    background: var(--surface-muted);
  }
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

.listen {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  margin-top: 0.4rem;
  padding: 0.15rem 0.6rem;
  font-size: 0.8rem;
}

.block-play {
  position: absolute;
  right: 0.5rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 2rem;
  min-height: 1.75rem;
  padding: 0.2rem 0.45rem;
  box-shadow: var(--shadow);
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
.group-choices,
.note-id {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem;
  margin-top: 0.4rem;
}

.actions button,
.note-id button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 2rem;
  min-height: 1.75rem;
  padding: 0.2rem 0.45rem;
}

.note-id .check-button {
  margin-left: auto;
}

.note-id button.on {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}

.group-choices button {
  padding: 0.1rem 0.5rem;
  font-size: 0.75rem;
}

.actions .handle {
  touch-action: none;
  cursor: grab;
}

.note-id {
  font-size: 0.8rem;
}

.group-choices .muted {
  font-size: 0.8rem;
}

@media (pointer: coarse) {
  .actions button,
  .note-id button,
  .block-play {
    min-width: 2.75rem;
    min-height: 2.25rem;
  }

  .group-choices button {
    padding: 0.2rem 0.8rem;
    font-size: 0.875rem;
  }
}
</style>
