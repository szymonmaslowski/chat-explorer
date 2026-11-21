<script setup lang="ts">
import { computed } from 'vue';
import { openExploration } from '../stores/exploration';

// Where the fork a comment starts goes on the board. Null is the default, the column its parent
// is in; the rest are Ungrouped, each column, and a new column made with the fork.
const props = defineProps<{
  explorationId: string;
  // The fork the new fork branches from.
  parentForkId: string | undefined;
  modelValue: string | null;
}>();
const emit = defineEmits<{ 'update:modelValue': [choice: string] }>();

const state = computed(() => openExploration(props.explorationId));
const columns = computed(() => state.value.exploration?.boardColumns ?? []);
const parentDefault = computed(() => {
  const parent = props.parentForkId ? state.value.forks.get(props.parentForkId) : undefined;
  const columnId = parent?.parentForkId ? parent.boardColumnId : null;
  return columnId && columns.value.some((column) => column.id === columnId)
    ? columnId
    : 'ungrouped';
});
const shown = computed({
  get: () =>
    props.modelValue !== null &&
    (['ungrouped', 'new'].includes(props.modelValue) ||
      columns.value.some((column) => column.id === props.modelValue))
      ? props.modelValue
      : parentDefault.value,
  set: (choice: string) => emit('update:modelValue', choice),
});
</script>

<template>
  <label class="board-column-picker">
    Group
    <select v-model="shown" aria-label="Board group of the new fork" @click.stop>
      <option value="ungrouped">Ungrouped</option>
      <option v-for="column in columns" :key="column.id" :value="column.id">
        {{ column.name }}
      </option>
      <option value="new">New group</option>
    </select>
  </label>
</template>

<style scoped>
.board-column-picker {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  color: var(--text-muted);
}

select {
  flex: 1;
  min-width: 0;
}
</style>
