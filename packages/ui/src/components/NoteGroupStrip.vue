<script setup lang="ts">
import type { NoteGroup } from '@shared/types';
import { ref } from 'vue';
import { useDragSort } from '../composables/useDragSort';
import MediaIcon from './MediaIcon.vue';

const props = defineProps<{ groups: NoteGroup[]; activeGroupId: string | null }>();
const emit = defineEmits<{
  select: [groupId: string];
  toggleActions: [];
  add: [];
  reorder: [groupId: string, afterGroupId: string | null];
}>();

// Expanded, the groups stack one per line, every one in sight and each with a grip to drag it.
const expanded = ref(false);
const list = ref<HTMLElement | null>(null);
const {
  draggedId,
  offset: dragOffset,
  indicatorTop,
  start: startDrag,
} = useDragSort({
  container: list,
  range: () => ({ first: 0, last: props.groups.length - 1 }),
  onDrop: (groupId, index) => {
    const others = props.groups.filter((group) => group.id !== groupId);
    const afterGroupId = index === 0 ? null : (others[index - 1]?.id ?? null);
    const currentIndex = props.groups.findIndex((group) => group.id === groupId);
    if (index !== currentIndex) emit('reorder', groupId, afterGroupId);
  },
});

const chooseGroup = (groupId: string) =>
  groupId === props.activeGroupId ? emit('toggleActions') : emit('select', groupId);
</script>

<template>
  <div class="group-strip" :class="{ expanded }">
    <div
      ref="list"
      class="chips"
      role="tablist"
      aria-label="Note groups"
      :aria-orientation="expanded ? 'vertical' : 'horizontal'"
    >
      <div
        v-for="group in groups"
        :key="group.id"
        class="chip-slot"
        :class="{ dragged: draggedId === group.id }"
        :data-drag-id="group.id"
        :style="draggedId === group.id ? { transform: `translateY(${dragOffset}px)` } : undefined"
      >
        <button
          v-if="expanded"
          type="button"
          class="handle icon-button"
          :aria-label="`Drag ${group.name} to reorder`"
          title="Drag to reorder"
          @pointerdown="startDrag($event, group.id)"
        >
          <MediaIcon name="grip" />
        </button>
        <button
          type="button"
          role="tab"
          class="chip"
          :class="{ active: group.id === activeGroupId }"
          :aria-selected="group.id === activeGroupId"
          @click="chooseGroup(group.id)"
        >
          {{ group.name
          }}<span v-if="group.checklist" class="checklist-mark" aria-label="checklist"> ✓</span>
        </button>
      </div>
      <div v-if="indicatorTop !== null" class="drop-line" :style="{ top: `${indicatorTop}px` }" />
    </div>
    <div class="strip-actions">
      <button type="button" class="add" @click="emit('add')">+ Group</button>
      <button
        v-if="groups.length > 1"
        type="button"
        class="icon-button"
        :aria-expanded="expanded"
        :aria-label="expanded ? 'Show groups in one line' : 'Show all groups'"
        :title="expanded ? 'Show groups in one line' : 'Show all groups, to reorder them'"
        @click="expanded = !expanded"
      >
        <MediaIcon :name="expanded ? 'shrink' : 'expand'" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.group-strip {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.group-strip.expanded {
  align-items: flex-start;
}

.chips {
  position: relative;
  flex: 1;
  display: flex;
  gap: 0.4rem;
  overflow-x: auto;
  scrollbar-width: none;
  padding: 0.2rem 0;
}

.expanded .chips {
  flex-direction: column;
  align-items: flex-start;
  overflow-x: visible;
}

.chip-slot {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 0.3rem;
}

.chip-slot.dragged {
  position: relative;
  z-index: 2;
}

.chip-slot.dragged .chip {
  box-shadow: var(--shadow);
}

.chip {
  flex-shrink: 0;
  max-width: 14rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-radius: 999px;
  padding: 0.2rem 0.8rem;
}

.expanded .chip {
  max-width: none;
  white-space: normal;
  text-align: left;
}

.chip.active {
  background: var(--accent);
  border-color: var(--accent);
  color: white;
}

.checklist-mark {
  opacity: 0.8;
}

.handle {
  touch-action: none;
  cursor: grab;
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

.strip-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 0.4rem;
}

.add {
  flex-shrink: 0;
  border-style: dashed;
  border-radius: 999px;
}

@media (pointer: coarse) {
  .chip,
  .add {
    min-height: 2.25rem;
    font-size: 0.95rem;
  }
}
</style>
