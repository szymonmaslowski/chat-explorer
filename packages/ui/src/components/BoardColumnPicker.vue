<script setup lang="ts">
import { computed } from 'vue';
import { openExploration } from '../stores/exploration';
import GroupField from './GroupField.vue';

// Where the fork a comment starts goes on the board. Null is the default, the column its parent
// is in; the rest are Ungrouped, each column, and a new column made with the fork.
const props = defineProps<{
  explorationId: string;
  // The fork the new fork branches from.
  parentForkId: string | undefined;
  modelValue: string | null;
  readonly?: boolean;
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
const shown = computed(() =>
  props.modelValue !== null &&
  (['ungrouped', 'new'].includes(props.modelValue) ||
    columns.value.some((column) => column.id === props.modelValue))
    ? props.modelValue
    : parentDefault.value,
);
const options = computed(() => [
  { value: 'ungrouped', label: 'Ungrouped' },
  ...columns.value.map((column) => ({ value: column.id, label: column.name })),
  { value: 'new', label: 'New group' },
]);
</script>

<template>
  <GroupField
    :options="options"
    :model-value="shown"
    :readonly="readonly"
    label="Board group of the fork"
    @update:model-value="emit('update:modelValue', $event)"
  />
</template>
