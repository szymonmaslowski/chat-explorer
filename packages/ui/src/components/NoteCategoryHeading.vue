<script setup lang="ts">
import { nextTick, ref } from 'vue';
import MediaIcon from './MediaIcon.vue';

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
      <button
        type="button"
        class="icon-button"
        aria-label="Rename category"
        title="Rename category"
        @click="startRename"
      >
        <MediaIcon name="edit" />
      </button>
    </template>
  </div>
</template>

<style scoped>
/* A delicate marker between groups of notes, not another item: small and muted. The name and
   count are one button across the row, so pressing anywhere but the rename button folds it. */
.category-heading {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.5rem;
  color: var(--text-muted);
}

.toggle {
  flex: 1;
  min-width: 0;
  align-self: stretch;
  display: flex;
  align-items: center;
  gap: 0.35rem;
  text-align: left;
  border: none;
  background: none;
  padding: 0 0.1rem 0 0.75rem;
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.03em;
  color: inherit;
}

.chevron {
  width: 0.9em;
  font-size: 0.7rem;
  opacity: 0.8;
}

.count {
  font-weight: 400;
  font-size: 0.7rem;
  opacity: 0.8;
}

@media (hover: hover) {
  .toggle:hover {
    color: var(--text);
  }
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
