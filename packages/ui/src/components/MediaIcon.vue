<script setup lang="ts">
defineProps<{
  name:
    | 'play'
    | 'pause'
    | 'stop'
    | 'previous'
    | 'next'
    | 'chain'
    | 'expand'
    | 'shrink'
    | 'copy'
    | 'check'
    | 'comment';
}>();
</script>

<template>
  <svg viewBox="0 0 24 24" aria-hidden="true" class="media-icon" :class="name">
    <path v-if="name === 'play'" d="M8 5v14l11-7z" />
    <path v-else-if="name === 'pause'" d="M7 5h4v14H7zM13 5h4v14h-4z" />
    <rect v-else-if="name === 'stop'" x="6" y="6" width="12" height="12" rx="1" />
    <path v-else-if="name === 'previous'" d="M6 5h2v14H6zM20 5v14L9 12z" />
    <path v-else-if="name === 'next'" d="M16 5h2v14h-2zM4 5v14l11-7z" />
    <path v-else-if="name === 'expand'" d="M14 4h6v6M20 4l-6 6M10 20H4v-6M4 20l6-6" />
    <path v-else-if="name === 'shrink'" d="M20 4l-6 6M14 5v5h5M4 20l6-6M10 19v-5H5" />
    <path
      v-else-if="name === 'copy'"
      d="M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"
    />
    <path v-else-if="name === 'check'" d="M4 12.5l5 5L20 6.5" />
    <path
      v-else-if="name === 'comment'"
      d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"
    />
    <path
      v-else
      d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"
    />
  </svg>
</template>

<style scoped>
.media-icon {
  width: 1rem;
  height: 1rem;
  fill: currentColor;
}

.media-icon.chain,
.media-icon.expand,
.media-icon.shrink,
.media-icon.copy,
.media-icon.check,
.media-icon.comment {
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
}
</style>
