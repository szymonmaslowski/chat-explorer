<script setup lang="ts">
import type { Bookmark } from '@shared/types';

defineProps<{ bookmarks: Bookmark[] }>();
const emit = defineEmits<{ jump: [] }>();
</script>

<template>
  <ol class="bookmark-list" aria-label="Bookmarks">
    <li v-for="bookmark in bookmarks" :key="bookmark.id">
      <RouterLink :to="{ hash: `#b-${bookmark.id}` }" class="row" @click="emit('jump')">
        {{ bookmark.quote }}
      </RouterLink>
    </li>
  </ol>
</template>

<style scoped>
.bookmark-list {
  max-height: 40vh;
  overflow-y: auto;
  margin: 0.5rem 0 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.bookmark-list li + li {
  border-top: 1px solid var(--border);
}

.row {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  padding: 0.5rem 0.75rem;
  border-left: 3px solid var(--bookmark);
  color: inherit;
  text-decoration: none;
}

.row:hover {
  background: var(--surface-muted);
}

@media (pointer: coarse) {
  .row {
    padding: 0.7rem 0.75rem;
    font-size: 1rem;
  }
}
</style>
