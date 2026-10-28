<script setup lang="ts">
defineProps<{ name: 'play' | 'pause' | 'stop' | 'previous' | 'next' | 'chain' }>();
</script>

<template>
  <svg viewBox="0 0 24 24" aria-hidden="true" class="media-icon" :class="name">
    <path v-if="name === 'play'" d="M8 5v14l11-7z" />
    <path v-else-if="name === 'pause'" d="M7 5h4v14H7zM13 5h4v14h-4z" />
    <rect v-else-if="name === 'stop'" x="6" y="6" width="12" height="12" rx="1" />
    <path v-else-if="name === 'previous'" d="M6 5h2v14H6zM20 5v14L9 12z" />
    <path v-else-if="name === 'next'" d="M16 5h2v14h-2zM4 5v14l11-7z" />
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

.media-icon.chain {
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
}
</style>
