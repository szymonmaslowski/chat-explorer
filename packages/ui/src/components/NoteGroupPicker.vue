<script setup lang="ts">
import { computed } from 'vue';
import { defaultGroupName } from '@shared/notes';
import { sortedGroups } from '../lib/notes';
import { openExploration } from '../stores/exploration';
import GroupField from './GroupField.vue';

// The note group a note comment goes into. Null asks for a new group, made on Submit, so a
// comment never sent leaves no empty group behind.
const props = defineProps<{
  explorationId: string;
  modelValue: string | null;
  readonly?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [groupId: string | null] }>();

const newGroupChoice = '';
const groups = computed(() => sortedGroups(openExploration(props.explorationId).noteGroups));
const options = computed(() => [
  ...groups.value.map((group) => ({ value: group.id, label: group.name })),
  {
    value: newGroupChoice,
    label: `${defaultGroupName(groups.value.map((group) => group.name))} (new)`,
  },
]);
</script>

<template>
  <GroupField
    :options="options"
    :model-value="modelValue ?? newGroupChoice"
    :readonly="readonly"
    label="Note group"
    @update:model-value="emit('update:modelValue', $event === newGroupChoice ? null : $event)"
  />
</template>
