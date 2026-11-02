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
    | 'comment'
    | 'edit'
    | 'move'
    | 'trash'
    | 'grip';
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
    <path v-else-if="name === 'edit'" d="M4 20h4L19 9l-4-4L4 16zM13 7l4 4" />
    <path
      v-else-if="name === 'move'"
      d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM10 13h6M13 10l3 3-3 3"
    />
    <path v-else-if="name === 'trash'" d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
    <path v-else-if="name === 'grip'" d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" />
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
.media-icon.comment,
.media-icon.edit,
.media-icon.move,
.media-icon.trash,
.media-icon.grip {
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.media-icon.grip {
  stroke-width: 3.5;
}
</style>
