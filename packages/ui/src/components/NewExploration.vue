<script setup lang="ts">
import { claudeModels, defaultClaudeModel, type ClaudeModel } from '@shared/models';
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { insertAtCursor } from '../lib/insert-text';
import { modelLabels } from '../lib/models';
import DictationButton from './DictationButton.vue';

const router = useRouter();
const message = ref('');
const model = ref<ClaudeModel>(defaultClaudeModel);
const starting = ref(false);
const error = ref('');
const textarea = ref<HTMLTextAreaElement | null>(null);

onMounted(async () => {
  try {
    model.value = (await api.settings()).defaultModel;
  } catch {
    // The list below reports a daemon that cannot be reached.
  }
});

async function start() {
  if (!message.value.trim() || starting.value) return;
  starting.value = true;
  error.value = '';
  try {
    const { explorationId } = await api.createExploration(message.value, model.value);
    await router.push(`/e/${explorationId}`);
  } catch {
    error.value = 'Could not start the chat.';
    starting.value = false;
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void start();
  }
}
</script>

<template>
  <form class="new-exploration" @submit.prevent="start">
    <textarea
      ref="textarea"
      v-model="message"
      rows="3"
      placeholder="Start a new chat: ask anything (⌘↵ to start)"
      @keydown="onKeydown"
    />
    <div class="actions">
      <select v-model="model" title="Model">
        <option v-for="option in claudeModels" :key="option" :value="option">
          {{ modelLabels[option] }}
        </option>
      </select>
      <DictationButton @text="(text) => (message = insertAtCursor(textarea, message, text))" />
      <span class="spacer" />
      <span v-if="error" class="error">{{ error }}</span>
      <button type="submit" class="primary" :disabled="!message.trim() || starting">Start</button>
    </div>
  </form>
</template>

<style scoped>
.new-exploration {
  display: grid;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
}

.spacer {
  flex: 1;
}

.error {
  color: var(--danger);
  font-size: 0.85rem;
}
</style>
