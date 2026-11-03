<script setup lang="ts">
import { defaultGroupName, reorderedIds } from '@shared/notes';
import type { Note } from '@shared/types';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ConfirmButton from '../components/ConfirmButton.vue';
import ExplorationHeader from '../components/ExplorationHeader.vue';
import NoteEditor from '../components/NoteEditor.vue';
import NoteGroupForm from '../components/NoteGroupForm.vue';
import NoteGroupStrip from '../components/NoteGroupStrip.vue';
import NoteDeletionNotice from '../components/NoteDeletionNotice.vue';
import NoteItem from '../components/NoteItem.vue';
import SpeechPlayer from '../components/SpeechPlayer.vue';
import { useDragSort } from '../composables/useDragSort';
import {
  dropAnchor,
  dropRange,
  notesInGroup,
  readChecklistOrder,
  sortedGroups,
  storeChecklistOrder,
  uncheckedFirst,
  type ChecklistOrder,
} from '../lib/notes';
import { openExploration } from '../stores/exploration';
import { newId, outbox } from '../stores/outbox';
import { stopSpeech } from '../stores/speech';

const props = defineProps<{ explorationId: string }>();

const flashMs = 1_400;

const route = useRoute();
const router = useRouter();
const state = computed(() => openExploration(props.explorationId));
const readOnly = computed(() => Boolean(state.value.exploration?.archivedAt));
const groups = computed(() => sortedGroups(state.value.noteGroups));
const activeGroup = computed(() => {
  const chosen = typeof route.query.group === 'string' ? route.query.group : null;
  return (chosen ? state.value.noteGroups.get(chosen) : undefined) ?? groups.value[0] ?? null;
});
const notes = computed(() =>
  activeGroup.value ? notesInGroup(state.value.notes, activeGroup.value.id) : [],
);
const otherGroups = computed(() =>
  groups.value.filter((group) => group.id !== activeGroup.value?.id),
);
const nextGroupName = computed(() => defaultGroupName(groups.value.map((group) => group.name)));
const checklistOrder = ref<ChecklistOrder>('original');
watch(
  () => activeGroup.value?.id,
  (groupId) => {
    if (groupId) checklistOrder.value = readChecklistOrder(groupId);
  },
  { immediate: true },
);
const keepsParts = computed(
  () => Boolean(activeGroup.value?.checklist) && checklistOrder.value === 'unchecked-first',
);
const shownNotes = computed(() => (keepsParts.value ? uncheckedFirst(notes.value) : notes.value));
const notesList = ref<HTMLElement | null>(null);
const {
  draggedId,
  offset: dragOffset,
  indicatorTop,
  start: startDrag,
} = useDragSort({
  container: notesList,
  range: (noteId) => dropRange(shownNotes.value, noteId, keepsParts.value),
  onDrop: reorderNote,
});

const selectedNoteId = ref<string | null>(null);
const editingNoteId = ref<string | null>(null);
const creatingNote = ref(false);
const groupForm = ref<'new' | 'edit' | null>(null);
const groupActionsShown = ref(false);
const deleteDialog = ref<HTMLDialogElement | null>(null);

function selectGroup(groupId: string) {
  void router.replace({ query: { ...route.query, group: groupId }, hash: '' });
}

watch(
  () => activeGroup.value?.id,
  () => {
    selectedNoteId.value = null;
    editingNoteId.value = null;
    groupActionsShown.value = false;
    if (groupForm.value === 'edit') groupForm.value = null;
  },
);

function addGroup(group: { name?: string; checklist?: boolean } = {}) {
  const id = newId();
  outbox.add({
    type: 'note-group.create',
    explorationId: props.explorationId,
    group: { id, ...group },
  });
  return id;
}

function createGroup(group: { name: string; checklist: boolean }) {
  selectGroup(addGroup(group));
  groupForm.value = null;
}

function updateGroup(changes: { name: string; checklist: boolean }) {
  if (!activeGroup.value) return;
  outbox.add({
    type: 'note-group.update',
    explorationId: props.explorationId,
    groupId: activeGroup.value.id,
    changes,
  });
  groupForm.value = null;
  groupActionsShown.value = false;
}

function deleteGroup() {
  if (!activeGroup.value) return;
  if (notes.value.length > 0 && !deleteDialog.value?.open) {
    deleteDialog.value?.showModal();
    return;
  }
  deleteDialog.value?.close();
  outbox.add({
    type: 'note-group.delete',
    explorationId: props.explorationId,
    groupId: activeGroup.value.id,
  });
  groupActionsShown.value = false;
  void router.replace({ query: {}, hash: '' });
}

function createNote(note: { topic: string; description: string }) {
  const groupId = activeGroup.value?.id ?? addGroup();
  outbox.add({
    type: 'note.create',
    explorationId: props.explorationId,
    note: { id: newId(), groupId, ...note },
  });
  creatingNote.value = false;
}

function updateNote(noteId: string, changes: { topic: string; description: string }) {
  outbox.add({ type: 'note.update', explorationId: props.explorationId, noteId, changes });
  editingNoteId.value = null;
}

function setChecklistOrder(order: ChecklistOrder) {
  checklistOrder.value = order;
  if (activeGroup.value) storeChecklistOrder(activeGroup.value.id, order);
}

function toggleChecked(note: Note) {
  outbox.add({
    type: 'note.update',
    explorationId: props.explorationId,
    noteId: note.id,
    changes: { checked: !note.checked },
  });
  selectedNoteId.value = null;
}

function reorderNote(noteId: string, index: number) {
  const afterNoteId = dropAnchor(shownNotes.value, notes.value, noteId, index, keepsParts.value);
  const noteIds = notes.value.map((note) => note.id);
  if (reorderedIds(noteIds, noteId, afterNoteId).join() === noteIds.join()) return;
  outbox.add({ type: 'note.reorder', explorationId: props.explorationId, noteId, afterNoteId });
}

function keepNote(noteId: string) {
  outbox.add({ type: 'note.keep', explorationId: props.explorationId, noteId });
}

function deleteNote(noteId: string) {
  outbox.add({ type: 'note.delete', explorationId: props.explorationId, noteId });
  selectedNoteId.value = null;
}

function changeNoteGroup(noteId: string, groupId: string | null) {
  outbox.add({
    type: 'note.change-group',
    explorationId: props.explorationId,
    noteId,
    groupId: groupId ?? addGroup(),
  });
  selectedNoteId.value = null;
}

function toggleSelected(noteId: string) {
  selectedNoteId.value = selectedNoteId.value === noteId ? null : noteId;
}

function deselectOutsideNotes(event: MouseEvent) {
  if (event.target instanceof Element && !event.target.closest('.note, .speech-player')) {
    selectedNoteId.value = null;
  }
}
onMounted(() => document.addEventListener('click', deselectOutsideNotes));
onBeforeUnmount(() => document.removeEventListener('click', deselectOutsideNotes));
onBeforeUnmount(stopSpeech);

// A `#n-` link opens the note's group, then scrolls to the note and selects it.
let handledHash = '';
watch(
  () => [route.hash, state.value.notes.size] as const,
  async ([hash]) => {
    if (!hash.startsWith('#n-') || hash === handledHash) return;
    const note = state.value.notes.get(hash.slice(3));
    if (!note) return;
    handledHash = hash;
    if (note.groupId !== activeGroup.value?.id) {
      await router.replace({ query: { ...route.query, group: note.groupId }, hash });
    }
    selectedNoteId.value = note.id;
    const target = document.getElementById(`n-${note.id}`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target?.classList.add('flash');
    setTimeout(() => target?.classList.remove('flash'), flashMs);
  },
  { flush: 'post', immediate: true },
);
</script>

<template>
  <div class="page notes-view">
    <ExplorationHeader :state="state" class="top" data-sticky-header>
      <template #links>
        · <RouterLink :to="`/e/${explorationId}/map`">Map</RouterLink> · <span>Notes</span>
      </template>
    </ExplorationHeader>

    <p v-if="state.status === 'loading'" class="muted">Loading…</p>
    <p v-else-if="state.status !== 'ready'" class="muted">This chat is not available.</p>

    <template v-else>
      <NoteDeletionNotice :exploration-id="explorationId" :notes="state.notes" />
      <section class="groups">
        <NoteGroupStrip
          v-if="groups.length > 0 || !readOnly"
          :groups="groups"
          :active-group-id="activeGroup?.id ?? null"
          :read-only="readOnly"
          @select="selectGroup"
          @toggle-actions="groupActionsShown = !groupActionsShown"
          @add="groupForm = groupForm === 'new' ? null : 'new'"
        />
        <div v-if="groupActionsShown && activeGroup && !groupForm" class="group-actions">
          <button type="button" @click="groupForm = 'edit'">Edit group</button>
          <ConfirmButton label="Delete group" danger @confirm="deleteGroup" />
        </div>
        <NoteGroupForm
          v-if="groupForm === 'new'"
          :placeholder-name="nextGroupName"
          save-label="Create"
          @save="createGroup"
          @cancel="groupForm = null"
        />
        <NoteGroupForm
          v-else-if="groupForm === 'edit' && activeGroup"
          :key="activeGroup.id"
          :name="activeGroup.name"
          :checklist="activeGroup.checklist"
          :placeholder-name="activeGroup.name"
          save-label="Save"
          @save="updateGroup"
          @cancel="groupForm = null"
        />
      </section>

      <div v-if="activeGroup?.checklist && notes.length > 0" class="checklist-order">
        <button
          type="button"
          :aria-pressed="checklistOrder === 'original'"
          @click="setChecklistOrder('original')"
        >
          Original order
        </button>
        <button
          type="button"
          :aria-pressed="checklistOrder === 'unchecked-first'"
          @click="setChecklistOrder('unchecked-first')"
        >
          Unchecked first
        </button>
      </div>

      <section ref="notesList" class="notes">
        <p v-if="notes.length === 0 && !creatingNote" class="muted empty">No notes yet.</p>
        <template v-if="!readOnly">
          <NoteEditor v-if="creatingNote" @save="createNote" @cancel="creatingNote = false" />
          <button v-else type="button" class="new-note" @click="creatingNote = true">
            + New note
          </button>
        </template>
        <template v-for="note in shownNotes" :key="note.id">
          <NoteEditor
            v-if="editingNoteId === note.id"
            :topic="note.topic ?? ''"
            :description="note.description"
            @save="updateNote(note.id, $event)"
            @cancel="editingNoteId = null"
          />
          <NoteItem
            v-else
            :note="note"
            :selected="selectedNoteId === note.id"
            :read-only="readOnly"
            :checklist="activeGroup?.checklist ?? false"
            :other-groups="otherGroups"
            :data-drag-id="note.id"
            :class="{ dragged: draggedId === note.id }"
            :style="
              draggedId === note.id ? { transform: `translateY(${dragOffset}px)` } : undefined
            "
            @toggle-selected="toggleSelected(note.id)"
            @toggle-checked="toggleChecked(note)"
            @drag-start="startDrag($event, note.id)"
            @edit="editingNoteId = note.id"
            @delete="deleteNote(note.id)"
            @keep="keepNote(note.id)"
            @change-group="changeNoteGroup(note.id, $event)"
          />
        </template>
        <div v-if="indicatorTop !== null" class="drop-line" :style="{ top: `${indicatorTop}px` }" />
      </section>
      <div class="dock" data-dock>
        <SpeechPlayer />
      </div>
    </template>

    <dialog ref="deleteDialog" class="delete-dialog" @cancel="deleteDialog?.close()">
      <p>
        Delete "{{ activeGroup?.name }}" and its {{ notes.length }}
        {{ notes.length === 1 ? 'note' : 'notes' }}?
      </p>
      <div class="dialog-actions">
        <button type="button" @click="deleteDialog?.close()">Cancel</button>
        <button type="button" class="danger" @click="deleteGroup">Delete</button>
      </div>
    </dialog>
  </div>
</template>

<style scoped>
.dock {
  position: sticky;
  bottom: 0;
  z-index: 5;
  background: var(--background);
}

.top {
  position: sticky;
  top: 0;
  z-index: 6;
  background: var(--background);
}

.groups {
  margin: 1rem 0 0.75rem;
}

.group-actions {
  display: flex;
  gap: 0.4rem;
  margin-top: 0.5rem;
}

.checklist-order {
  display: inline-flex;
  margin-bottom: 0.5rem;
}

.checklist-order button {
  font-size: 0.8rem;
  padding: 0.15rem 0.6rem;
}

.checklist-order button:first-child {
  border-radius: 6px 0 0 6px;
}

.checklist-order button:last-child {
  border-left: none;
  border-radius: 0 6px 6px 0;
}

.checklist-order button[aria-pressed='true'] {
  background: var(--accent-soft);
  border-color: var(--accent);
}

.notes {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding-bottom: 3rem;
}

.dragged {
  position: relative;
  z-index: 2;
  box-shadow: var(--shadow);
}

.drop-line {
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  margin-top: -2px;
  background: var(--accent);
  pointer-events: none;
}

.empty {
  margin: 0 0 0.3rem;
}

.new-note {
  text-align: left;
  padding: 0.6rem 0.75rem;
  border-style: dashed;
  border-radius: var(--radius);
  color: var(--text-muted);
  background: none;
  font-size: 0.95rem;
}

@media (hover: hover) {
  .new-note:hover {
    color: var(--text);
    border-color: var(--accent);
  }
}

.delete-dialog {
  max-width: min(24rem, calc(100vw - 2rem));
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.delete-dialog::backdrop {
  background: rgb(0 0 0 / 0.35);
}

.delete-dialog p {
  margin-top: 0;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.4rem;
}

.dialog-actions .danger {
  background: var(--danger);
  border-color: var(--danger);
  color: var(--background);
}
</style>
