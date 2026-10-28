<script setup lang="ts">
import { ref } from 'vue';

const emit = defineEmits<{ files: [files: File[]] }>();
const input = ref<HTMLInputElement | null>(null);

function onChange() {
  const files = [...(input.value?.files ?? [])];
  if (input.value) input.value.value = '';
  if (files.length) emit('files', files);
}
</script>

<template>
  <button
    type="button"
    class="attach"
    title="Attach images, PDFs or text files"
    aria-label="Attach files"
    @click="input?.click()"
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"
      />
    </svg>
  </button>
  <input ref="input" type="file" multiple hidden @change="onChange" />
</template>

<style scoped>
.attach {
  display: inline-grid;
  place-items: center;
  padding: 0.25rem 0.45rem;
}

.attach svg {
  width: 1rem;
  height: 1rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

@media (pointer: coarse) {
  .attach svg {
    width: 1.25rem;
    height: 1.25rem;
  }
}
</style>
