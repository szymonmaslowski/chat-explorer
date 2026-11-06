<script setup lang="ts">
import { ref } from 'vue';
import { api, ApiError } from '../api';
import ConfirmButton from './ConfirmButton.vue';
import MediaIcon from './MediaIcon.vue';

const props = defineProps<{ forkId: string }>();

const error = ref('');

async function archive() {
  error.value = '';
  try {
    await api.archiveFork(props.forkId);
  } catch (failure) {
    error.value = failure instanceof ApiError ? failure.message : 'Something went wrong.';
  }
}
</script>

<template>
  <div class="archive-fork">
    <span v-if="error" class="error" role="alert">{{ error }}</span>
    <ConfirmButton label="Archive fork" title="Archive fork" @confirm="archive">
      <MediaIcon name="archive" /><span class="visually-hidden">Archive fork</span>
    </ConfirmButton>
  </div>
</template>

<style scoped>
.archive-fork {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
}

.archive-fork button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.9rem;
  padding: 0.15rem 0.4rem;
  line-height: 1.2;
}

.error {
  color: var(--danger);
}
</style>
