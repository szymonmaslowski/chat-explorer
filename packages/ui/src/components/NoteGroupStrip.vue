<script setup lang="ts">
import type { NoteGroup } from '@shared/types';

defineProps<{ groups: NoteGroup[]; activeGroupId: string | null; readOnly: boolean }>();
const emit = defineEmits<{ select: [groupId: string]; toggleActions: []; add: [] }>();
</script>

<template>
  <div class="group-strip">
    <div class="chips" role="tablist" aria-label="Note groups">
      <button
        v-for="group in groups"
        :key="group.id"
        type="button"
        role="tab"
        class="chip"
        :class="{ active: group.id === activeGroupId }"
        :aria-selected="group.id === activeGroupId"
        @click="
          group.id === activeGroupId ? !readOnly && emit('toggleActions') : emit('select', group.id)
        "
      >
        {{ group.name
        }}<span v-if="group.checklist" class="checklist-mark" aria-label="checklist"> ✓</span>
      </button>
    </div>
    <button v-if="!readOnly" type="button" class="add" @click="emit('add')">+ Group</button>
  </div>
</template>

<style scoped>
.group-strip {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.chips {
  flex: 1;
  display: flex;
  gap: 0.4rem;
  overflow-x: auto;
  scrollbar-width: none;
  padding: 0.2rem 0;
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

.chip.active {
  background: var(--accent);
  border-color: var(--accent);
  color: white;
}

.checklist-mark {
  opacity: 0.8;
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
