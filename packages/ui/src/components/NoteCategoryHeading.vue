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
      <span class="rule" aria-hidden="true" />
      <button
        type="button"
        class="rename-button"
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
/* A delicate marker between groups of notes, not another item: small, muted, with a hairline. */
.category-heading {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.7rem;
  min-height: 1.5rem;
  color: var(--text-muted);
}

.toggle {
  display: flex;
  align-items: baseline;
  gap: 0.35rem;
  text-align: left;
  border: none;
  background: none;
  padding: 0.1rem 0.1rem 0.1rem 0.75rem;
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

.rule {
  flex: 1;
  border-top: 1px solid var(--border);
}

.rename-button {
  display: grid;
  place-items: center;
  width: 1.5rem;
  height: 1.5rem;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  opacity: 0.7;
}

.rename-button .media-icon {
  width: 0.8rem;
  height: 0.8rem;
}

@media (hover: hover) {
  .toggle:hover,
  .rename-button:hover {
    color: var(--text);
    opacity: 1;
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
