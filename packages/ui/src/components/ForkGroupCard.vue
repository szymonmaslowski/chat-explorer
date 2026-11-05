<script setup lang="ts">
import type { Comment } from '@shared/types';
import { onBeforeUnmount, onMounted, ref } from 'vue';
import CommentCard from './CommentCard.vue';

// Fork comments joined into one fork, in the order of the text they quote. Without a placement
// the group is listed in the page flow, on narrow and touch screens.
const props = defineProps<{
  comments: Comment[];
  placement?: { top: number; left: number; width: number };
}>();
const emit = defineEmits<{
  measure: [height: number];
  open: [comment: Comment];
  jump: [comment: Comment];
}>();

const group = ref<HTMLElement | null>(null);
let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
  resizeObserver = new ResizeObserver(([entry]) => {
    if (entry) emit('measure', entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height);
  });
  if (group.value) resizeObserver.observe(group.value);
});
onBeforeUnmount(() => resizeObserver?.disconnect());
</script>

<template>
  <div
    ref="group"
    class="fork-group"
    :class="{ listed: !props.placement }"
    :style="
      props.placement && {
        top: `${props.placement.top}px`,
        left: `${props.placement.left}px`,
        width: `${props.placement.width}px`,
      }
    "
  >
    <div class="label">One fork · {{ comments.length }} comments</div>
    <CommentCard
      v-for="(comment, index) in comments"
      :key="comment.id"
      :comment="comment"
      :group-role="index === 0 ? 'head' : 'member'"
      @open="emit('open', $event)"
      @jump="emit('jump', $event)"
    />
  </div>
</template>

<style scoped>
.fork-group {
  position: absolute;
  z-index: 3;
  padding: 0.3rem 0.4rem 0.4rem;
  background: var(--fork-soft);
  border: 1px solid var(--fork);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.fork-group.listed {
  position: static;
  box-shadow: none;
  margin-top: 0.4rem;
}

.label {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--fork);
}

.fork-group :deep(.comment-card) {
  box-shadow: none;
}
</style>
