<script setup lang="ts">
import type { BoardColumn, Fork } from '@shared/types';
import { computed, nextTick, ref } from 'vue';
import { api, ApiError } from '../api';
import { boardLayout, dropAnchor } from '../lib/board';
import { archivingFork } from '../lib/conversation';
import { offline } from '../lib/online';
import { awaitsAnswer } from '../lib/read-state';
import { openExploration } from '../stores/exploration';
import { explorationIndex } from '../stores/exploration-index';
import BoardCard from './BoardCard.vue';
import ConfirmButton from './ConfirmButton.vue';
import MediaIcon from './MediaIcon.vue';

const props = defineProps<{
  explorationId: string;
  currentForkId?: string;
  archivedOnly: boolean;
}>();

const state = computed(() => openExploration(props.explorationId));
const columns = computed(() => state.value.exploration?.boardColumns ?? []);
const archivedIds = computed(
  () =>
    new Set(
      [...state.value.forks.values()]
        .filter((fork) => archivingFork(fork, state.value.forks))
        .map((fork) => fork.id),
    ),
);
const layout = computed(() =>
  boardLayout(state.value.forks.values(), columns.value, archivedIds.value, props.archivedOnly),
);
const movable = computed(() => !props.archivedOnly && !offline.value);

const messageCounts = computed(() => {
  const counts = new Map<string, number>();
  for (const message of state.value.messages.values()) {
    counts.set(message.forkId, (counts.get(message.forkId) ?? 0) + 1);
  }
  return counts;
});
const attention = computed(() => explorationIndex(state.value).attentionByFork.value);
const awaiting = (fork: Fork) =>
  awaitsAnswer(fork, state.value.messages, state.value.forkRuns.get(fork.id));
const forkUrl = (fork: Fork) =>
  fork.parentForkId ? `/e/${props.explorationId}/f/${fork.id}` : `/e/${props.explorationId}`;

const error = ref('');
async function change(request: Promise<unknown>) {
  error.value = '';
  try {
    await request;
  } catch (failure) {
    error.value = failure instanceof ApiError ? failure.message : 'Something went wrong.';
  }
}

// Moves with the menu: one place up or down among the cards shown, or to the bottom of a column.
function moveBy(fork: Fork, cards: Fork[], step: -1 | 1) {
  const index = cards.findIndex((card) => card.id === fork.id);
  const target = index + step;
  if (target < 0 || target >= cards.length) return;
  return change(
    api.moveFork(
      fork.id,
      fork.boardColumnId,
      dropAnchor(
        cards.map((c) => c.id),
        fork.id,
        target,
      ),
    ),
  );
}

function moveToColumn(fork: Fork, columnId: string | null) {
  const target =
    columnId === null
      ? layout.value.ungrouped
      : (layout.value.columns.find((view) => view.column.id === columnId)?.forks ?? []);
  const last = target.at(-1);
  return change(api.moveFork(fork.id, columnId, last?.id ?? null));
}

// Columns.
const addingColumn = ref(false);
const newName = ref('');
const newInput = ref<HTMLInputElement | null>(null);
async function startAdding() {
  addingColumn.value = true;
  newName.value = '';
  await nextTick();
  newInput.value?.focus();
}
async function addColumn() {
  const name = newName.value.trim();
  if (!name) return;
  addingColumn.value = false;
  await change(api.addBoardColumn(props.explorationId, name));
}

const renamingId = ref<string | null>(null);
const renameDraft = ref('');
const renameInput = ref<HTMLInputElement | null>(null);
async function startRename(column: BoardColumn) {
  renamingId.value = column.id;
  renameDraft.value = column.name;
  await nextTick();
  renameInput.value?.select();
}
async function saveRename(column: BoardColumn) {
  const name = renameDraft.value.trim();
  if (!name) return;
  renamingId.value = null;
  if (name !== column.name) {
    await change(api.renameBoardColumn(props.explorationId, column.id, name));
  }
}
function moveColumn(column: BoardColumn, step: -1 | 1) {
  const index = columns.value.findIndex((each) => each.id === column.id);
  const target = index + step;
  if (target < 0 || target >= columns.value.length) return;
  const others = columns.value.filter((each) => each.id !== column.id);
  return change(
    api.reorderBoardColumn(
      props.explorationId,
      column.id,
      target === 0 ? null : others[target - 1]!.id,
    ),
  );
}

// Dragging a card: a placeholder shows where it lands. Dropping on a card puts it before or after
// that card; dropping on the empty part of a column puts it last.
const dragged = ref<string | null>(null);
// Set a moment after the drag starts, so the browser has taken its drag image of the card first.
const dragHidesSource = ref(false);
const draggedFork = computed(() =>
  dragged.value ? state.value.forks.get(dragged.value) : undefined,
);
const placeholderAt = (columnId: string | null, index: number) =>
  dragged.value !== null &&
  indicator.value?.columnId === columnId &&
  indicator.value.index === index;
// `pointerY` and `bodyHeight` (px, within the column) let an empty column show the placeholder
// under the pointer, wherever the column is on the screen.
const indicator = ref<{
  columnId: string | null;
  index: number;
  pointerY?: number;
  bodyHeight?: number;
} | null>(null);

function onDragStart(event: DragEvent, fork: Fork) {
  if (!movable.value) return event.preventDefault();
  dragged.value = fork.id;
  setTimeout(() => (dragHidesSource.value = dragged.value === fork.id), 0);
  event.dataTransfer?.setData('text/plain', fork.id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}

function onDragOverCard(event: DragEvent, columnId: string | null, index: number, across: boolean) {
  if (!dragged.value) return;
  event.preventDefault();
  event.stopPropagation();
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const after = across
    ? event.clientX > rect.left + rect.width / 2
    : event.clientY > rect.top + rect.height / 2;
  indicator.value = { columnId, index: index + (after ? 1 : 0) };
}

function onDragOverBody(event: DragEvent, columnId: string | null, cards: Fork[]) {
  if (!dragged.value) return;
  event.preventDefault();
  const body = (event.currentTarget as HTMLElement).getBoundingClientRect();
  indicator.value = {
    columnId,
    index: cards.length,
    pointerY: event.clientY - body.top,
    bodyHeight: body.height,
  };
}

// An empty column's placeholder sits where the pointer entered it, kept inside the column.
function underPointer() {
  const { pointerY = 0, bodyHeight = 0 } = indicator.value ?? {};
  return {
    marginTop: `min(max(0px, calc(${pointerY}px - 2.75rem)), max(0px, calc(${bodyHeight}px - 5.5rem)))`,
  };
}

function endDrag() {
  dragged.value = null;
  dragHidesSource.value = false;
  indicator.value = null;
}

async function onDrop(columnId: string | null, cards: Fork[]) {
  const movedId = dragged.value;
  const where = indicator.value;
  endDrag();
  if (!movedId || !where || where.columnId !== columnId) return;
  const ids = cards.map((card) => card.id);
  const from = ids.indexOf(movedId);
  const index = from !== -1 && from < where.index ? where.index - 1 : where.index;
  const anchor = dropAnchor(ids, movedId, index);
  if (from !== -1) {
    const others = ids.filter((id) => id !== movedId);
    const at = anchor === null ? 0 : others.indexOf(anchor) + 1;
    if (at === from) return;
  }
  await change(api.moveFork(movedId, columnId, anchor));
}
</script>

<template>
  <div class="board">
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <section class="main-row">
      <BoardCard
        v-if="layout.main"
        :fork="layout.main"
        :url="forkUrl(layout.main)"
        :message-count="messageCounts.get(layout.main.id) ?? 0"
        :awaiting-answer="awaiting(layout.main)"
        :attention="attention.get(layout.main.id)"
        :archived="false"
        :current="layout.main.id === currentForkId"
        :movable="false"
        :columns="[]"
        :can-move-up="false"
        :can-move-down="false"
      />
      <button
        v-if="!archivedOnly && !offline"
        type="button"
        class="icon-button add-column"
        aria-label="New group"
        title="New group"
        @click="startAdding"
      >
        <MediaIcon name="plus" />
      </button>
    </section>
    <hr class="divider" />

    <div class="columns-scroll">
      <div class="columns">
        <section
          v-for="(view, columnIndex) in layout.columns"
          :key="view.column.id"
          class="column"
          :data-column="view.column.name"
        >
          <header class="column-heading">
            <form
              v-if="renamingId === view.column.id"
              class="rename"
              @submit.prevent="saveRename(view.column)"
            >
              <input
                ref="renameInput"
                v-model="renameDraft"
                aria-label="Column name"
                maxlength="80"
                @keydown.esc="renamingId = null"
              />
              <div class="form-buttons">
                <ConfirmButton
                  class="icon-button delete-column"
                  label="Delete column"
                  title="Delete column"
                  danger
                  @confirm="change(api.deleteBoardColumn(explorationId, view.column.id))"
                >
                  <MediaIcon name="trash" /><span class="visually-hidden">Delete column</span>
                </ConfirmButton>
                <button type="button" @click="renamingId = null">Cancel</button>
                <button type="submit" class="primary" :disabled="!renameDraft.trim()">Save</button>
              </div>
            </form>
            <template v-else>
              <h2>{{ view.column.name }}</h2>
              <span class="count">{{ view.forks.length }}</span>
              <div v-if="!archivedOnly && !offline" class="column-actions">
                <button
                  type="button"
                  class="icon-button"
                  aria-label="Rename column"
                  title="Rename column"
                  @click="startRename(view.column)"
                >
                  <MediaIcon name="edit" />
                </button>
                <button
                  type="button"
                  class="icon-button"
                  aria-label="Move column left"
                  title="Move column left"
                  :disabled="columnIndex === 0"
                  @click="moveColumn(view.column, -1)"
                >
                  ‹
                </button>
                <button
                  type="button"
                  class="icon-button"
                  aria-label="Move column right"
                  title="Move column right"
                  :disabled="columnIndex === layout.columns.length - 1"
                  @click="moveColumn(view.column, 1)"
                >
                  ›
                </button>
              </div>
            </template>
          </header>
          <div
            class="column-body"
            @dragover="onDragOverBody($event, view.column.id, view.forks)"
            @drop.prevent="onDrop(view.column.id, view.forks)"
          >
            <p
              v-if="view.forks.length === 0 && !placeholderAt(view.column.id, 0)"
              class="muted empty"
            >
              Drop forks here.
            </p>
            <template v-for="(fork, index) in view.forks" :key="fork.id">
              <div
                v-if="placeholderAt(view.column.id, index)"
                class="drop-placeholder"
                @dragover.prevent.stop
                @drop.prevent.stop="onDrop(view.column.id, view.forks)"
              >
                {{ draggedFork?.summary }}
              </div>
              <BoardCard
                :fork="fork"
                :url="forkUrl(fork)"
                :class="{ 'drag-source': dragHidesSource && dragged === fork.id }"
                :message-count="messageCounts.get(fork.id) ?? 0"
                :awaiting-answer="awaiting(fork)"
                :attention="attention.get(fork.id)"
                :archived="archivedIds.has(fork.id)"
                :current="fork.id === currentForkId"
                :movable="movable"
                :columns="columns"
                :can-move-up="index > 0"
                :can-move-down="index < view.forks.length - 1"
                :draggable="movable"
                @dragstart="onDragStart($event, fork)"
                @dragend="endDrag"
                @dragover="onDragOverCard($event, view.column.id, index, false)"
                @drop.prevent.stop="onDrop(view.column.id, view.forks)"
                @move-to="moveToColumn(fork, $event)"
                @up="moveBy(fork, view.forks, -1)"
                @down="moveBy(fork, view.forks, 1)"
              />
            </template>
            <div
              v-if="placeholderAt(view.column.id, view.forks.length)"
              class="drop-placeholder"
              :style="view.forks.length === 0 ? underPointer() : undefined"
              @dragover.prevent.stop
              @drop.prevent.stop="onDrop(view.column.id, view.forks)"
            >
              {{ draggedFork?.summary }}
            </div>
          </div>
        </section>

        <section v-if="addingColumn" class="column new-column">
          <form class="rename" @submit.prevent="addColumn">
            <input
              ref="newInput"
              v-model="newName"
              aria-label="New column name"
              placeholder="Column name"
              maxlength="80"
              @keydown.esc="addingColumn = false"
            />
            <div class="form-buttons">
              <button type="button" @click="addingColumn = false">Cancel</button>
              <button type="submit" class="primary" :disabled="!newName.trim()">Save</button>
            </div>
          </form>
        </section>
      </div>
    </div>

    <section
      v-if="layout.ungrouped.length > 0 || (dragged !== null && !archivedOnly)"
      class="ungrouped"
      aria-label="Ungrouped"
    >
      <h2 class="ungrouped-heading">Ungrouped</h2>
      <div
        class="ungrouped-body"
        @dragover="onDragOverBody($event, null, layout.ungrouped)"
        @drop.prevent="onDrop(null, layout.ungrouped)"
      >
        <template v-for="(fork, index) in layout.ungrouped" :key="fork.id">
          <div
            v-if="placeholderAt(null, index)"
            class="drop-placeholder"
            @dragover.prevent.stop
            @drop.prevent.stop="onDrop(null, layout.ungrouped)"
          >
            {{ draggedFork?.summary }}
          </div>
          <BoardCard
            :fork="fork"
            :url="forkUrl(fork)"
            :class="{ 'drag-source': dragHidesSource && dragged === fork.id }"
            :message-count="messageCounts.get(fork.id) ?? 0"
            :awaiting-answer="awaiting(fork)"
            :attention="attention.get(fork.id)"
            :archived="archivedIds.has(fork.id)"
            :current="fork.id === currentForkId"
            :movable="movable"
            :columns="columns"
            :can-move-up="index > 0"
            :can-move-down="index < layout.ungrouped.length - 1"
            :draggable="movable"
            @dragstart="onDragStart($event, fork)"
            @dragend="endDrag"
            @dragover="onDragOverCard($event, null, index, true)"
            @drop.prevent.stop="onDrop(null, layout.ungrouped)"
            @move-to="moveToColumn(fork, $event)"
            @up="moveBy(fork, layout.ungrouped, -1)"
            @down="moveBy(fork, layout.ungrouped, 1)"
          />
        </template>
        <div
          v-if="placeholderAt(null, layout.ungrouped.length)"
          class="drop-placeholder"
          @dragover.prevent.stop
          @drop.prevent.stop="onDrop(null, layout.ungrouped)"
        >
          {{ draggedFork?.summary }}
        </div>
      </div>
    </section>

    <p
      v-if="archivedOnly && layout.columns.length === 0 && layout.ungrouped.length === 0"
      class="muted"
    >
      No archived forks.
    </p>
  </div>
</template>

<style scoped>
.board {
  padding-bottom: 2rem;
}

.main-row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem;
}

.main-row > :first-child {
  width: 12rem;
}

.divider {
  margin: 1rem 0;
  border: none;
  border-top: 2px solid var(--border);
}

.columns-scroll {
  overflow-x: auto;
  padding-bottom: 0.5rem;
}

.columns {
  display: flex;
  align-items: stretch;
  gap: 0.75rem;
  width: max-content;
  min-width: 100%;
}

.column {
  display: flex;
  flex: none;
  flex-direction: column;
  width: 13rem;
  padding: 0 0.6rem;
  border-left: 1px dashed var(--border);
}

.column:first-child {
  border-left: none;
  padding-left: 0;
}

.column-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem;
  min-height: 2rem;
  margin-bottom: 0.5rem;
}

.column-actions {
  display: flex;
  flex: 1 1 100%;
  align-items: center;
  justify-content: flex-end;
  gap: 0.25rem;
}

.column-heading h2 {
  flex: 1;
  margin: 0;
  overflow: hidden;
  font-size: 0.9rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.count {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.column-actions .icon-button {
  min-width: 1.5rem;
  min-height: 1.5rem;
  padding: 0;
  border-color: transparent;
  background: transparent;
  color: var(--text-muted);
}

.rename input {
  width: 100%;
  font: inherit;
  color: inherit;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.4rem 0.6rem;
}

.rename input:focus {
  outline: 2px solid var(--accent-soft);
  border-color: var(--accent);
}

.column-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 0.5rem;
  min-height: 6rem;
}

.empty {
  margin: 0;
  font-size: 0.8rem;
}

.new-column {
  border-left: none;
}

.add-column {
  margin-left: auto;
}

.form-buttons {
  display: flex;
  justify-content: flex-end;
  gap: 0.4rem;
  margin-top: 0.4rem;
}

.delete-column {
  margin-right: auto;
}

.ungrouped {
  margin-top: 1.5rem;
  padding-top: 1rem;
  border-top: 2px solid var(--border);
}

.ungrouped-heading {
  margin: 0 0 0.5rem;
  font-size: 0.9rem;
}

.ungrouped-body {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  min-height: 6rem;
}

.ungrouped-body > * {
  width: 13rem;
}

.drop-placeholder {
  display: flex;
  align-items: center;
  min-height: 5.5rem;
  padding: 0.6rem 0.75rem;
  border: 2px dashed var(--accent);
  border-radius: var(--radius);
  background: var(--accent-soft);
  font-size: 0.85rem;
  font-weight: 600;
  overflow: hidden;
}

/* The card being dragged leaves its place, so the cards close up around the placeholder. */
.column-body .drag-source,
.ungrouped-body .drag-source {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.ungrouped-body > .drop-placeholder {
  width: 13rem;
}

.error {
  color: var(--danger);
}
</style>
