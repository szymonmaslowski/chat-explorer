<script setup lang="ts">
import type { QueuedSubmission } from '@shared/types';
import { ref } from 'vue';
import { api, ApiError } from '../api';
import { replyDrafts } from '../stores/reply-drafts';

const props = defineProps<{ submission: QueuedSubmission; commentCount: number }>();

const error = ref('');
const cancelling = ref(false);

async function cancel() {
  cancelling.value = true;
  try {
    const { globalMessage } = await api.cancelSubmission(props.submission.id);
    if (globalMessage) replyDrafts.restore(props.submission.forkId, globalMessage);
  } catch (caught) {
    error.value =
      caught instanceof ApiError && caught.code === 'already_sent'
        ? 'Already sent to Claude.'
        : 'Could not cancel.';
  } finally {
    cancelling.value = false;
  }
}
</script>

<template>
  <div class="queued-submission">
    <div>
      <strong>Queued</strong><template v-if="submission.newFork"> as a new fork</template>, sent
      when Claude is free.
      <span class="muted">
        <template v-if="commentCount">
          {{ commentCount }} comment{{ commentCount === 1 ? '' : 's' }}
        </template>
        <template v-if="commentCount && submission.globalMessage">, </template>
        <template v-if="submission.globalMessage">message</template>
      </span>
      <p v-if="submission.globalMessage" class="message">{{ submission.globalMessage }}</p>
      <p v-if="error" class="error">{{ error }}</p>
    </div>
    <button :disabled="cancelling" @click="cancel">Cancel</button>
  </div>
</template>

<style scoped>
.queued-submission {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  padding: 0.6rem 1rem;
  margin: 1rem 0;
  font-size: 0.9rem;
}

.message {
  margin: 0.4rem 0 0;
  white-space: pre-wrap;
}

.error {
  margin: 0.4rem 0 0;
  color: var(--danger);
}
</style>
