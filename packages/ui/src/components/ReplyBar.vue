<script setup lang="ts">
import { computed, ref } from 'vue';
import { api } from '../api';
import { replyDrafts } from '../stores/reply-drafts';

const props = defineProps<{ explorationId: string; forkId: string }>();

const sending = ref(false);
const error = ref('');

const text = computed({
  get: () => replyDrafts.get(props.forkId),
  set: (value: string) => replyDrafts.set(props.forkId, value),
});
const canSubmit = computed(() => !sending.value && text.value.trim() !== '');

async function submit() {
  if (!canSubmit.value) return;
  sending.value = true;
  error.value = '';
  try {
    await api.submit(props.explorationId, props.forkId, text.value);
    text.value = '';
  } catch {
    error.value = 'Could not send. Is the chat-explorer daemon running?';
  } finally {
    sending.value = false;
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void submit();
  }
}
</script>

<template>
  <form class="reply-bar" @submit.prevent="submit">
    <textarea
      v-model="text"
      rows="2"
      placeholder="Reply to Claude (⌘↵ to send)"
      @keydown="onKeydown"
    />
    <div class="actions">
      <span v-if="error" class="error">{{ error }}</span>
      <button type="submit" class="primary" :disabled="!canSubmit">Submit</button>
    </div>
  </form>
</template>

<style scoped>
.reply-bar {
  position: sticky;
  bottom: 0;
  background: var(--background);
  padding: 0.75rem 0 1rem;
  border-top: 1px solid var(--border);
  display: grid;
  gap: 0.5rem;
}

.actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 0.75rem;
}

.error {
  color: var(--danger);
  font-size: 0.85rem;
}
</style>
