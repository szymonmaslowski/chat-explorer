<script setup lang="ts">
import type { Fork } from '@shared/types';
import { ref } from 'vue';
import { api, ApiError } from '../api';
import { forkTitle } from '../lib/conversation';

const props = defineProps<{ explorationId: string; fork: Fork; archivedBy: Fork }>();

const error = ref('');

async function restore() {
  error.value = '';
  try {
    await api.unarchiveFork(props.archivedBy.id);
  } catch (failure) {
    error.value = failure instanceof ApiError ? failure.message : 'Something went wrong.';
  }
}
</script>

<template>
  <div class="fork-archive">
    <p class="archived">
      <template v-if="archivedBy.id === fork.id">Fork archived, read only.</template>
      <template v-else>
        Archived with
        <RouterLink :to="`/e/${explorationId}/f/${archivedBy.id}`">{{
          forkTitle(archivedBy)
        }}</RouterLink
        >, read only.
      </template>
      <button type="button" @click="restore">Restore</button>
    </p>
    <span v-if="error" class="error" role="alert">{{ error }}</span>
  </div>
</template>

<style scoped>
.fork-archive {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin: 0 0 1rem;
  font-size: 0.875rem;
}

.archived {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  margin: 0;
  color: var(--warning);
}

.error {
  color: var(--danger);
}
</style>
