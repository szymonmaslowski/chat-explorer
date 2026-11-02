<script setup lang="ts">
import { onMounted, ref } from 'vue';

const props = defineProps<{
  name?: string;
  checklist?: boolean;
  placeholderName: string;
  saveLabel: string;
}>();
const emit = defineEmits<{ save: [group: { name: string; checklist: boolean }]; cancel: [] }>();

const name = ref(props.name ?? '');
const checklist = ref(props.checklist ?? false);
const nameInput = ref<HTMLInputElement | null>(null);

onMounted(() => nameInput.value?.focus());

const save = () => emit('save', { name: name.value, checklist: checklist.value });

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('cancel');
  if (event.key === 'Enter') save();
}
</script>

<template>
  <form class="group-form" @submit.prevent="save">
    <label class="name">
      Name
      <input ref="nameInput" v-model="name" :placeholder="placeholderName" @keydown="onKeydown" />
    </label>
    <div class="row">
      <label><input v-model="checklist" type="checkbox" /> Checklist</label>
      <span class="spacer" />
      <button type="button" @click="emit('cancel')">Cancel</button>
      <button type="submit" class="primary">{{ saveLabel }}</button>
    </div>
  </form>
</template>

<style scoped>
.group-form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.5rem;
  padding: 0.6rem 0.75rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 0.9rem;
}

.name {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.name input {
  flex: 1;
  min-width: 0;
  font: inherit;
  color: inherit;
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.25rem 0.5rem;
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}

.spacer {
  flex: 1;
}
</style>
