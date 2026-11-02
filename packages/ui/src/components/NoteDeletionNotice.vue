<script setup lang="ts">
import type { Note } from '@shared/types';
import { computed } from 'vue';

const props = defineProps<{ explorationId: string; notes: Map<string, Note> }>();

const requested = computed(() =>
  [...props.notes.values()].filter((note) => note.deletionRequestedAt !== null),
);
</script>

<template>
  <p v-if="requested.length > 0" class="deletion-notice" role="status">
    Claude asks to delete {{ requested.length }} {{ requested.length === 1 ? 'note' : 'notes' }}.
    <RouterLink :to="`/e/${explorationId}/notes#n-${requested[0]!.id}`">Review</RouterLink>
  </p>
</template>

<style scoped>
.deletion-notice {
  margin: 0.75rem 0 0;
  padding: 0.4rem 0.7rem;
  border: 1px solid var(--warning);
  border-radius: var(--radius);
  font-size: 0.85rem;
}
</style>
