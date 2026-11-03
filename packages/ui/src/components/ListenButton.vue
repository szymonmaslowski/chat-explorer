<script setup lang="ts">
import { renderMarkdown } from '@shared/markdown';
import { computed } from 'vue';
import { speechBlocks } from '../lib/speech-blocks';
import {
  checkSpeechAvailable,
  playFrom,
  speech,
  speechSourceId,
  togglePause,
} from '../stores/speech';
import MediaIcon from './MediaIcon.vue';

const props = defineProps<{ text: string }>();

void checkSpeechAvailable();

const draft = computed(() => props.text.trim());
const current = computed(() => speech.playback?.id === speechSourceId({ text: draft.value }));

function listen() {
  if (current.value) {
    togglePause();
    return;
  }
  const rendered = document.createElement('div');
  rendered.innerHTML = renderMarkdown(draft.value);
  const blocks = speechBlocks(rendered).map(({ block }) => block);
  if (blocks.length > 0) playFrom({ text: draft.value }, blocks, 0);
}
</script>

<template>
  <!-- Keeps the focus in the text box, so a phone keeps its keyboard up. -->
  <button
    v-if="speech.available && draft"
    type="button"
    class="listen-button"
    :aria-label="current && speech.playing ? 'Pause' : 'Listen'"
    :title="current && speech.playing ? 'Pause' : 'Listen to what you wrote'"
    @pointerdown.prevent
    @mousedown.prevent
    @click="listen"
  >
    <MediaIcon :name="current && speech.playing ? 'pause' : 'play'" />
  </button>
</template>

<style scoped>
.listen-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
</style>
