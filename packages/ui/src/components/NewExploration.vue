<script setup lang="ts">
import { claudeModels, defaultClaudeModel, type ClaudeModel } from '@shared/models';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { insertAtCursor } from '../lib/insert-text';
import { modelLabels } from '../lib/models';
import { transferredFiles } from '../lib/transferred-files';
import { newChatFilesOwner, useFileDrafts } from '../stores/file-drafts';
import AttachButton from './AttachButton.vue';
import DictationButton from './DictationButton.vue';
import FileDraftList from './FileDraftList.vue';

const router = useRouter();
const message = ref('');
const model = ref<ClaudeModel>(defaultClaudeModel);
const starting = ref(false);
const error = ref('');
const textarea = ref<HTMLTextAreaElement | null>(null);
const insertDictation = (text: string) => insertAtCursor(textarea.value, message, text);
const files = useFileDrafts(() => newChatFilesOwner);
const canStart = computed(
  () =>
    !starting.value &&
    !files.uploading.value &&
    (message.value.trim() !== '' || files.readyIds.value.length > 0),
);

onMounted(async () => {
  try {
    model.value = (await api.settings()).defaultModel;
  } catch {
    // The list below reports a daemon that cannot be reached.
  }
});

async function start() {
  if (!canStart.value) return;
  starting.value = true;
  error.value = '';
  try {
    const { explorationId } = await api.createExploration(
      message.value,
      model.value,
      files.readyIds.value,
    );
    files.clear();
    await router.push(`/e/${explorationId}`);
  } catch {
    error.value = 'Could not start the chat.';
    starting.value = false;
  }
}

function onPaste(event: ClipboardEvent) {
  const pasted = transferredFiles(event.clipboardData);
  if (pasted.length === 0) return;
  event.preventDefault();
  files.add(pasted);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void start();
  }
}
</script>

<template>
  <form
    class="new-exploration"
    @submit.prevent="start"
    @dragover.prevent
    @drop.prevent="files.add(transferredFiles($event.dataTransfer))"
  >
    <textarea
      ref="textarea"
      v-model="message"
      rows="3"
      placeholder="Start a new chat: ask anything (⌘↵ to start)"
      @keydown="onKeydown"
      @paste="onPaste"
    />
    <FileDraftList :drafts="files.drafts.value" @remove="files.remove" />
    <div class="actions">
      <select v-model="model" title="Model">
        <option v-for="option in claudeModels" :key="option" :value="option">
          {{ modelLabels[option] }}
        </option>
      </select>
      <AttachButton @files="files.add" />
      <DictationButton @text="insertDictation" />
      <span class="spacer" />
      <span v-if="error" class="error">{{ error }}</span>
      <button type="submit" class="primary" :disabled="!canStart">Start</button>
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
