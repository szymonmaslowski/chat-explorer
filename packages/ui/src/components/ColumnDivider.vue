<script setup lang="ts">
import { ref } from 'vue';

defineProps<{
  label: string;
  // The column's share of the page, in percent, for screen readers.
  percent: number;
}>();

const emit = defineEmits<{
  // The pointer's distance from the page's left edge, where the column's edge should go.
  drag: [clientX: number];
  // Pixels to move the edge by, from the keyboard.
  step: [pixels: number];
  // The drag or step ended, so the width can be kept.
  done: [];
  reset: [];
}>();

const keyStep = 16;
const dragging = ref(false);

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  dragging.value = true;
}

function onPointerMove(event: PointerEvent) {
  if (dragging.value) emit('drag', event.clientX);
}

function onPointerUp() {
  if (!dragging.value) return;
  dragging.value = false;
  emit('done');
}

function onKeydown(event: KeyboardEvent) {
  const direction = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
  if (!direction) return;
  event.preventDefault();
  emit('step', direction * keyStep);
  emit('done');
}
</script>

<template>
  <div
    class="column-divider"
    :class="{ dragging }"
    role="separator"
    aria-orientation="vertical"
    :aria-label="label"
    :aria-valuenow="Math.round(percent)"
    aria-valuemin="0"
    aria-valuemax="100"
    tabindex="0"
    title="Drag to resize, double-click to reset"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @keydown="onKeydown"
    @dblclick="emit('reset')"
  />
</template>

<style scoped>
/* Negative margins take its width back, so it lies over the border of the column before it. */
.column-divider {
  position: sticky;
  top: 0;
  z-index: 2;
  flex: 0 0 11px;
  height: 100dvh;
  margin: 0 -5px 0 -6px;
  cursor: col-resize;
  touch-action: none;
  outline: none;
}

.column-divider::after {
  content: '';
  position: absolute;
  inset: 0 5px 0 4px;
  pointer-events: none;
}

.column-divider:hover::after,
.column-divider:focus-visible::after,
.column-divider.dragging::after {
  background: var(--accent);
}
</style>
