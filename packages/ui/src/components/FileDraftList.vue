<script setup lang="ts">
import { useImageViewer } from '../composables/useImageViewer';
import type { DraftFile } from '../stores/file-drafts';
import FileIcon from './FileIcon.vue';

defineProps<{ drafts: DraftFile[] }>();
const emit = defineEmits<{ remove: [draft: DraftFile] }>();
const imageViewer = useImageViewer();
</script>

<template>
  <ul v-if="drafts.length" class="file-drafts">
    <li v-for="draft in drafts" :key="draft.key" :class="draft.status">
      <button
        v-if="draft.previewUrl && draft.file?.kind === 'image'"
        type="button"
        class="preview"
        :aria-label="`Open ${draft.name}`"
        :title="`Open ${draft.name}`"
        @click="imageViewer.open(draft.file.id)"
      >
        <img :src="draft.previewUrl" alt="" />
      </button>
      <img v-else-if="draft.previewUrl" :src="draft.previewUrl" alt="" />
      <FileIcon v-else />
      <span class="name">{{ draft.name }}</span>
      <span v-if="draft.status === 'uploading'" class="muted">Uploading…</span>
      <span v-else-if="draft.status === 'failed'" class="error" role="alert">{{
        draft.error
      }}</span>
      <button
        type="button"
        class="remove"
        :aria-label="`Remove ${draft.name}`"
        @click="emit('remove', draft)"
      >
        ✕
      </button>
    </li>
  </ul>
</template>

<style scoped>
.file-drafts {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.file-drafts li {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  max-width: 100%;
  padding: 0.2rem 0.25rem 0.2rem 0.3rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  font-size: 0.8rem;
}

.file-drafts li.failed {
  border-color: var(--danger);
}

.preview {
  display: flex;
  padding: 0;
  border: none;
  background: none;
  min-width: 0;
  min-height: 0;
  cursor: zoom-in;
}

img {
  width: 2rem;
  height: 2rem;
  object-fit: cover;
  border-radius: 4px;
}

.name {
  min-width: 0;
  max-width: 12rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.error {
  color: var(--danger);
}

.remove {
  padding: 0.1rem 0.4rem;
  border: none;
  background: transparent;
  color: var(--text-muted);
}
</style>
