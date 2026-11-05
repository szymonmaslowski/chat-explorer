<script setup lang="ts">
import type { Comment } from '@shared/types';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { confirmJoining, forkJoining, startJoining, stopJoining } from '../stores/fork-joining';
import { newId, outbox } from '../stores/outbox';
import CommentCard from './CommentCard.vue';
import MediaIcon from './MediaIcon.vue';

// Comments joined into one fork, in the order of the text they quote. The group carries the fork
// and its buttons; the comments inside are plain ones. Without a placement the group is listed in
// the page flow, on narrow and touch screens.
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

const first = computed(() => props.comments[0]!);
const editable = computed(() => props.comments.every((comment) => comment.status === 'draft'));
const joiningHere = computed(() => props.comments.some(({ id }) => id === forkJoining.startId));
// Adding starts joining mode with the group's comments picked, so one can be unpicked too.
const add = () =>
  startJoining(
    first.value,
    props.comments.slice(1).map((comment) => comment.id),
  );
const forkNow = () =>
  outbox.add({
    type: 'fork-now',
    explorationId: first.value.explorationId,
    submissionId: newId(),
    forkId: first.value.viewForkId,
    commentId: first.value.id,
  });
const ungroup = () => {
  if (!first.value.forkGroupId) return;
  outbox.add({
    type: 'fork-group.ungroup',
    explorationId: first.value.explorationId,
    groupId: first.value.forkGroupId,
  });
};
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
    <div class="header">
      <span class="label">Fork · {{ comments.length }} comments</span>
      <template v-if="joiningHere">
        <button type="button" @click="stopJoining">Cancel</button>
        <button type="button" class="primary" @click="confirmJoining(first)">Confirm</button>
      </template>
      <template v-else-if="editable && forkJoining.startId === null">
        <button type="button" aria-label="Add comments" title="Add or remove comments" @click="add">
          <MediaIcon name="chain" />
        </button>
        <button
          type="button"
          aria-label="Fork now"
          title="Start this fork without waiting for Submit"
          @click="forkNow"
        >
          <MediaIcon name="send" />
        </button>
        <button
          type="button"
          aria-label="Ungroup"
          title="Give every comment back what it does on its own"
          @click="ungroup"
        >
          <MediaIcon name="unchain" />
        </button>
      </template>
    </div>
    <p v-if="joiningHere" class="hint">Pick the comments for this fork</p>
    <CommentCard
      v-for="comment in comments"
      :key="comment.id"
      :comment="comment"
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

.header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem;
}

.header button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.1rem 0.5rem;
  font-size: 0.75rem;
}

.hint {
  margin: 0.2rem 0 0;
  font-size: 0.75rem;
  color: var(--text-muted);
}

.label {
  margin-right: auto;
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
