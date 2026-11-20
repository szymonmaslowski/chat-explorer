<script setup lang="ts">
import { nextTick, ref } from 'vue';

const props = defineProps<{
  name: string;
  count: number;
  // How many of its notes are ticked; null outside a checklist.
  ticked: number | null;
  collapsed: boolean;
}>();
const emit = defineEmits<{ toggle: []; rename: [name: string] }>();

const renaming = ref(false);
const draft = ref('');
const input = ref<HTMLInputElement | null>(null);

async function startRename() {
  draft.value = props.name;
  renaming.value = true;
  await nextTick();
  input.value?.select();
}

function save() {
  const name = draft.value.trim();
  renaming.value = false;
  if (name && name !== props.name) emit('rename', name);
}
</script>

<template>
  <div class="category-heading">
    <form v-if="renaming" class="rename" @submit.prevent="save">
      <input
        ref="input"
        v-model="draft"
        aria-label="Category name"
        maxlength="80"
        @keydown.esc="renaming = false"
      />
      <button type="submit" class="primary" :disabled="!draft.trim()">Save</button>
      <button type="button" @click="renaming = false">Cancel</button>
    </form>
    <template v-else>
      <button
        type="button"
        class="toggle"
        :aria-expanded="!collapsed"
        :aria-label="`${collapsed ? 'Show' : 'Hide'} category ${name}`"
        @click="emit('toggle')"
      >
        <span class="chevron" aria-hidden="true">{{ collapsed ? '▸' : '▾' }}</span>
        <span class="name">{{ name }}</span>
        <span class="count">{{ ticked === null ? count : `${ticked}/${count}` }}</span>
      </button>
      <button type="button" class="rename-button" @click="startRename">Rename</button>
    </template>
  </div>
</template>

<style scoped>
.category-heading {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.6rem;
}

.toggle {
  flex: 1;
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  text-align: left;
  border: none;
  background: none;
  padding: 0.2rem 0.1rem;
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--text);
}

.chevron {
  width: 1em;
  color: var(--text-muted);
}

.count {
  font-weight: 400;
  font-size: 0.8rem;
  color: var(--text-muted);
}

.rename-button {
  font-size: 0.8rem;
  padding: 0.1rem 0.5rem;
  color: var(--text-muted);
  background: none;
}

.rename {
  flex: 1;
  display: flex;
  gap: 0.3rem;
}

.rename input {
  flex: 1;
  min-width: 0;
}
</style>
