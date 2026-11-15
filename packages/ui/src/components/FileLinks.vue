<script setup lang="ts">
import type { MessageFile } from '@shared/types';
import { useImageViewer } from '../composables/useImageViewer';
import FileIcon from './FileIcon.vue';

defineProps<{ files: readonly MessageFile[] }>();
const imageViewer = useImageViewer();

function openImage(event: MouseEvent, file: MessageFile) {
  if (file.kind !== 'image') return;
  event.preventDefault();
  imageViewer.open(file.id);
}
</script>

<template>
  <div v-if="files.length" class="files">
    <a
      v-for="file in files"
      :key="file.id"
      :href="`/api/files/${file.id}`"
      target="_blank"
      rel="noopener"
      :class="file.kind"
      :title="file.name"
      @click.stop="openImage($event, file)"
    >
      <img
        v-if="file.kind === 'image'"
        :src="`/api/files/${file.id}`"
        :alt="file.name"
        decoding="async"
      />
      <template v-else>
        <FileIcon />
        <span class="name">{{ file.name }}</span>
      </template>
    </a>
  </div>
</template>

<style scoped>
.files {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 0.4rem 0;
}

.files a {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  max-width: 100%;
  color: inherit;
  text-decoration: none;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.files a:not(.image) {
  padding: 0.3rem 0.6rem 0.3rem 0.45rem;
  font-size: 0.85rem;
}

.files img {
  display: block;
  max-width: 10rem;
  max-height: 8rem;
  border-radius: var(--radius);
}

.files .name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
