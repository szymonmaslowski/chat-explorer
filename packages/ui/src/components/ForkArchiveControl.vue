<script setup lang="ts">
import type { Fork } from '@shared/types';
import { ref } from 'vue';
import { api, ApiError } from '../api';
import { forkTitle } from '../lib/conversation';
import ConfirmButton from './ConfirmButton.vue';
import MediaIcon from './MediaIcon.vue';

const props = defineProps<{ explorationId: string; fork: Fork; archivedBy: Fork | null }>();

const error = ref('');

async function setArchived(archive: boolean) {
  error.value = '';
  try {
    await (archive ? api.archiveFork(props.fork.id) : api.unarchiveFork(props.archivedBy!.id));
  } catch (failure) {
    error.value = failure instanceof ApiError ? failure.message : 'Something went wrong.';
  }
}
</script>

<template>
  <div class="fork-archive">
    <span v-if="error" class="error" role="alert">{{ error }}</span>
    <ConfirmButton
      v-if="!archivedBy"
      label="Archive fork"
      title="Archive fork"
      class="icon-button"
      @confirm="setArchived(true)"
    >
      <MediaIcon name="archive" /><span class="visually-hidden">Archive fork</span>
    </ConfirmButton>
    <button
      v-else
      type="button"
      class="icon-button"
      aria-label="Restore"
      :title="archivedBy.id === fork.id ? 'Restore this fork' : `Restore ${forkTitle(archivedBy)}`"
      @click="setArchived(false)"
    >
      <MediaIcon name="unarchive" />
    </button>
  </div>
</template>

<style scoped>
.fork-archive {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}

.error {
  color: var(--danger);
}
</style>
