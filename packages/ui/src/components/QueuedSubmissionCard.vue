<script setup lang="ts">
import type { MessageFile, QueuedSubmission } from '@shared/types';
import { computed } from 'vue';
import { replyFilesOwner, restoreFileDrafts } from '../stores/file-drafts';
import { outbox } from '../stores/outbox';
import { replyDrafts } from '../stores/reply-drafts';

const props = defineProps<{
  submission: QueuedSubmission;
  commentCount: number;
  files: MessageFile[];
}>();

const fileCount = computed(() => props.files.length);
const unsent = computed(() => outbox.stalled.value && outbox.isPending(props.submission.id));

// The message and files go back into the reply box at once; the daemon gets the cancel when it
// can be reached.
function cancel() {
  const { id, forkId, globalMessage, explorationId } = props.submission;
  const files = props.files.map((file) => ({ ...file, submissionId: null }));
  outbox.add({ type: 'submission.cancel', explorationId, submissionId: id });
  if (globalMessage) replyDrafts.restore(forkId, globalMessage);
  restoreFileDrafts(replyFilesOwner(forkId), files);
}
</script>

<template>
  <div class="queued-submission">
    <div>
      <strong>Queued</strong><template v-if="submission.newFork"> as a new fork</template>,
      <template v-if="unsent">waits for the connection.</template>
      <template v-else>sent when Claude is free.</template>
      <span class="muted">
        <template v-if="commentCount">
          {{ commentCount }} comment{{ commentCount === 1 ? '' : 's' }}
        </template>
        <template v-if="commentCount && submission.globalMessage">, </template>
        <template v-if="submission.globalMessage">message</template>
        <template v-if="fileCount && (commentCount || submission.globalMessage)">, </template>
        <template v-if="fileCount">{{ fileCount }} file{{ fileCount === 1 ? '' : 's' }}</template>
      </span>
      <p v-if="submission.globalMessage" class="message">{{ submission.globalMessage }}</p>
    </div>
    <button @click="cancel">Cancel</button>
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
</style>
