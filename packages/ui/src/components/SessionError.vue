<script setup lang="ts">
import { ref } from 'vue';
import { api, ApiError } from '../api';

const props = defineProps<{ explorationId: string; message: string }>();

const retrying = ref(false);
const retryError = ref('');

async function retry() {
  retrying.value = true;
  retryError.value = '';
  try {
    await api.startSession(props.explorationId);
  } catch (caught) {
    retryError.value = caught instanceof ApiError ? caught.message : 'Could not start Claude.';
  } finally {
    retrying.value = false;
  }
}
</script>

<template>
  <div class="session-error" role="alert">
    <pre>{{ message }}</pre>
    <p v-if="retryError" class="retry-error">{{ retryError }}</p>
    <button type="button" :disabled="retrying" @click="retry">Retry</button>
  </div>
</template>

<style scoped>
.session-error {
  margin: 1rem 0;
  padding: 0.6rem 0.8rem;
  border: 1px solid var(--danger);
  border-radius: var(--radius);
  font-size: 0.85rem;
}

pre {
  margin: 0 0 0.5rem;
  white-space: pre-wrap;
  background: none;
  padding: 0;
}

.retry-error {
  color: var(--danger);
  margin: 0 0 0.5rem;
}
</style>
