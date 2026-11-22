<script setup lang="ts">
// The "Group" row of a fork or note comment: a short select while the comment is being written or
// edited, and the chosen group as plain text otherwise. Both types share it, so they look alike.
defineProps<{
  options: { value: string; label: string }[];
  modelValue: string;
  label: string;
  readonly?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<template>
  <div class="group-field" :class="{ readonly }">
    <span class="name">Group</span>
    <span v-if="readonly" class="value">
      {{ options.find((option) => option.value === modelValue)?.label ?? '' }}
    </span>
    <select
      v-else
      :value="modelValue"
      :aria-label="label"
      @click.stop
      @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
    >
      <option v-for="option in options" :key="option.value" :value="option.value">
        {{ option.label }}
      </option>
    </select>
  </div>
</template>

<style scoped>
.group-field {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  color: var(--text-muted);
}

select {
  max-width: 14rem;
  min-width: 0;
}

.value {
  color: var(--text);
}
</style>
