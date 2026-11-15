<script setup lang="ts">
import { renderMarkdown } from '@shared/markdown';
import type { Note, NoteGroup } from '@shared/types';
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useCopied } from '../composables/useCopied';
import { useMediaQuery } from '../composables/useMediaQuery';
import { placeUnderRange } from '../lib/action-placement';
import { blockClipboardText, noteQuote } from '../lib/clipboard';
import { bringToReadingLine } from '../lib/reading-line';
import {
  blockIndexAt,
  blockTextRange,
  speechBlocks,
  type SpokenElement,
} from '../lib/speech-blocks';
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
import CopyableId from './CopyableId.vue';
import MediaIcon from './MediaIcon.vue';
import NoteForkComposer from './NoteForkComposer.vue';
import { offline } from '../lib/online';

const props = defineProps<{
  note: Note;
  selected: boolean;
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
const html = computed(() => (props.note.description ? renderMarkdown(props.note.description) : ''));

const article = ref<HTMLElement | null>(null);
const descriptionElement = ref<HTMLElement | null>(null);
const blocks = shallowRef<SpokenElement[]>([]);
const pickedIndex = ref<number | null>(null);
const pickedPlace = ref({ top: 0, left: 0 });
const coarsePointer = useMediaQuery('(pointer: coarse)');
const speechSource = computed(() => ({ text: props.note.description }));
const pickable = computed(() => props.selected && expanded.value && blocks.value.length > 0);
const listenable = computed(() => speech.available && pickable.value);
const speakingIndex = computed(() =>
  speech.playback?.id === speechSourceId(speechSource.value) ? speech.playback.index : -1,
);
const listenLabel = computed(() =>
  speakingIndex.value === -1 ? 'Listen' : speech.playing ? 'Pause' : 'Resume',
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

watch(pickable, (canPick) => {
  if (!canPick) pickBlock(null);
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
  pickedPlace.value = placeActions(blockTextRange(element), false);
}

const placeActions = (range: Range, clearHandles: boolean) =>
  placeUnderRange(range, article.value!.getBoundingClientRect(), {
    buttonCount: listenable.value ? 2 : 1,
    coarse: coarsePointer.value,
    clearHandles,
  });

// In an expanded note, a tap on a block of the description picks it to copy or read aloud.
function pickBlockAt(target: EventTarget | null) {
  if (!pickable.value || !(target instanceof Element) || target.closest('a')) return false;
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

const selection = ref<{ text: string; blockIndex: number; top: number; left: number } | null>(null);
// A selection inside a picked block takes the buttons over until it goes.
const actions = computed(
  () =>
    selection.value ??
    (pickedIndex.value === null
      ? null
      : { text: null, blockIndex: pickedIndex.value, ...pickedPlace.value }),
);
const actionsPlaying = computed(
  () =>
    speech.playing && actions.value !== null && speakingIndex.value === actions.value.blockIndex,
);

function playActions() {
  if (!actions.value) return;
  playBlock(speechSource.value, spokenBlocks(), actions.value.blockIndex);
  window.getSelection()?.removeAllRanges();
  pickBlock(null);
}

const { copied: quoteCopied, copy: copyQuote } = useCopied();

function copyActions() {
  if (!actions.value) return;
  const { text, blockIndex } = actions.value;
  const element = blocks.value[blockIndex]?.element;
  const quoted = text ?? (element ? blockClipboardText(element).plain : '');
  if (quoted) void copyQuote(noteQuote(props.note, quoted));
}

// A touch screen sends no click after a cancelled touchstart, so its tap acts on pointerup.
const onTouchUp = (event: PointerEvent, action: () => void) => {
  if (event.pointerType !== 'mouse') action();
};

function onSelectionChange() {
  const current = window.getSelection();
  const range = current && !current.isCollapsed && current.rangeCount > 0 && current.getRangeAt(0);
  if (
    !range ||
    !article.value ||
    !descriptionElement.value?.contains(range.commonAncestorContainer)
  ) {
    selection.value = null;
    return;
  }
  const start = range.startContainer;
  const startElement = start instanceof Element ? start : start.parentElement;
  const blockIndex = startElement ? blockIndexAt(blocks.value, startElement) : -1;
  selection.value = {
    text: current.toString(),
    blockIndex: Math.max(blockIndex, 0),
    ...placeActions(range, true),
  };
}

onMounted(() => document.addEventListener('selectionchange', onSelectionChange));
onBeforeUnmount(() => document.removeEventListener('selectionchange', onSelectionChange));

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
      <span v-if="offline && outbox.isPending(note.id)" class="unsent"> · not sent yet </span>
    </h3>
    <CopyableId
      v-if="selected && expanded"
      class="note-meta"
      label="ID"
      :id="note.id"
      @click.stop
    />
    <div v-if="selected" class="actions" @click.stop>
      <ConfirmButton
        label="Delete"
        class="icon-button"
        danger
        title="Delete"
        @confirm="emit('delete')"
      >
        <MediaIcon name="trash" /><span class="visually-hidden">Delete</span>
      </ConfirmButton>
      <button
        type="button"
        class="icon-button"
        :aria-expanded="choosingGroup"
        aria-label="Move"
        title="Move to another group"
        @click="choosingGroup = !choosingGroup"
      >
        <MediaIcon name="move" />
      </button>
      <button
        type="button"
        class="icon-button"
        :aria-expanded="forking"
        aria-label="New fork"
        title="New fork about this note"
        @click="forking = !forking"
      >
        <MediaIcon name="fork" />
      </button>
      <button
        type="button"
        class="icon-button"
        aria-label="Edit"
        title="Edit"
        @click="emit('edit')"
      >
        <MediaIcon name="edit" />
      </button>
      <button
        v-if="html && checklist"
        type="button"
        class="icon-button"
        :aria-label="expanded ? 'Collapse' : 'Expand'"
        :title="expanded ? 'Collapse' : 'Expand'"
        @click="expandedByButton = !expandedByButton"
      >
        <MediaIcon :name="expanded ? 'shrink' : 'expand'" />
      </button>
      <button
        v-if="listenable"
        type="button"
        class="icon-button"
        :aria-label="listenLabel"
        :title="listenLabel"
        @click="listen"
      >
        <MediaIcon :name="speakingIndex !== -1 && speech.playing ? 'pause' : 'play'" />
      </button>
      <button
        type="button"
        class="icon-button handle"
        aria-label="Drag to reorder"
        title="Drag to reorder"
        @pointerdown="emit('dragStart', $event)"
      >
        <MediaIcon name="grip" />
      </button>
      <button
        v-if="checklist"
        type="button"
        class="icon-button check-button"
        :class="{ on: note.checked }"
        :aria-label="note.checked ? 'Uncheck' : 'Check'"
        :title="note.checked ? 'Uncheck' : 'Check'"
        @click="emit('toggleChecked')"
      >
        <MediaIcon name="check" />
      </button>
    </div>
    <NoteForkComposer
      v-if="forking"
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
    <div v-if="html" ref="descriptionElement" class="description" v-html="html" />
    <div
      v-if="actions"
      class="block-actions"
      :style="{ top: `${actions.top}px`, left: `${actions.left}px` }"
      @click.stop
    >
      <button
        type="button"
        :aria-label="quoteCopied ? 'Copied' : 'Copy as a quote'"
        :title="quoteCopied ? 'Copied' : 'Copy as a quote from this note'"
        @pointerdown.prevent
        @mousedown.prevent
        @touchstart.prevent
        @pointerup="onTouchUp($event, copyActions)"
        @click="copyActions"
      >
        <MediaIcon :name="quoteCopied ? 'check' : 'copy'" />
      </button>
      <button
        v-if="listenable"
        type="button"
        :aria-label="actionsPlaying ? 'Pause' : 'Read aloud from here'"
        :title="actionsPlaying ? 'Pause' : 'Read aloud from here'"
        @pointerdown.prevent
        @mousedown.prevent
        @touchstart.prevent
        @pointerup="onTouchUp($event, playActions)"
        @click="playActions"
      >
        <MediaIcon :name="actionsPlaying ? 'pause' : 'play'" />
      </button>
    </div>
    <div v-if="note.deletionRequestedAt !== null" class="deletion-request" @click.stop>
      <span>Claude asks to delete this note.</span>
      <ConfirmButton label="Delete" danger @confirm="emit('delete')" />
      <button type="button" @click="emit('keep')">Keep</button>
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

.block-actions {
  position: absolute;
  z-index: 2;
  display: flex;
  gap: 0.4rem;
}

.block-actions button {
  display: inline-grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
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
.note-meta {
  margin-top: 0.4rem;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.actions .check-button {
  margin-left: auto;
}

.actions button.on {
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

.note-meta {
  font-size: 0.8rem;
}

.group-choices .muted {
  font-size: 0.8rem;
}

@media (pointer: coarse) {
  .block-actions button {
    width: 2.75rem;
    height: 2.75rem;
  }

  .group-choices button {
    padding: 0.2rem 0.8rem;
    font-size: 0.875rem;
  }
}
</style>
