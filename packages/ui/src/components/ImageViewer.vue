<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useImageViewer } from '../composables/useImageViewer';
import MediaIcon from './MediaIcon.vue';

const minScale = 1;
const maxScale = 6;
const doubleTapScale = 2.5;
const doubleTapMs = 300;
const tapSlopPx = 10;

interface Point {
  x: number;
  y: number;
}

const { openFileId, close } = useImageViewer();
const stage = ref<HTMLElement | null>(null);
const view = reactive({ scale: 1, x: 0, y: 0 });
const pointers = new Map<number, Point>();
let pinch: { distance: number; scale: number; anchor: Point } | null = null;
let lastTap: { time: number; point: Point } | null = null;
let pressStart: Point | null = null;

const imageStyle = computed(() => ({
  transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
}));

const clampScale = (scale: number) => Math.min(maxScale, Math.max(minScale, scale));

function stageCentre(): Point {
  const box = stage.value!.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

// The point of the image under the screen point, in unscaled image pixels from its centre.
function imagePointUnder(screen: Point): Point {
  const centre = stageCentre();
  return {
    x: (screen.x - centre.x - view.x) / view.scale,
    y: (screen.y - centre.y - view.y) / view.scale,
  };
}

// Scales the image while the given image point stays under the given screen point.
function zoomTo(scale: number, anchor: Point, screen: Point) {
  const centre = stageCentre();
  view.scale = clampScale(scale);
  view.x = screen.x - centre.x - anchor.x * view.scale;
  view.y = screen.y - centre.y - anchor.y * view.scale;
  if (view.scale === minScale) reset();
}

function reset() {
  view.scale = 1;
  view.x = 0;
  view.y = 0;
}

const pointOf = (event: MouseEvent): Point => ({ x: event.clientX, y: event.clientY });
const distanceBetween = (first: Point, second: Point) =>
  Math.hypot(first.x - second.x, first.y - second.y);
const midpointOf = (first: Point, second: Point): Point => ({
  x: (first.x + second.x) / 2,
  y: (first.y + second.y) / 2,
});

function startPinch() {
  const [first, second] = [...pointers.values()] as [Point, Point];
  pinch = {
    distance: distanceBetween(first, second),
    scale: view.scale,
    anchor: imagePointUnder(midpointOf(first, second)),
  };
}

function onPointerDown(event: PointerEvent) {
  stage.value!.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, pointOf(event));
  pressStart = pointers.size === 1 ? pointOf(event) : null;
  if (pointers.size === 2) startPinch();
}

function onPointerMove(event: PointerEvent) {
  const previous = pointers.get(event.pointerId);
  if (!previous) return;
  const current = pointOf(event);
  pointers.set(event.pointerId, current);
  if (pinch && pointers.size === 2) {
    const [first, second] = [...pointers.values()] as [Point, Point];
    const scale = (pinch.scale * distanceBetween(first, second)) / pinch.distance;
    zoomTo(scale, pinch.anchor, midpointOf(first, second));
    return;
  }
  if (pointers.size === 1 && view.scale > minScale) {
    view.x += current.x - previous.x;
    view.y += current.y - previous.y;
  }
}

function onPointerUp(event: PointerEvent) {
  pointers.delete(event.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pressStart && distanceBetween(pressStart, pointOf(event)) < tapSlopPx) onTap(pointOf(event));
  pressStart = null;
}

function onTap(point: Point) {
  const isDoubleTap =
    lastTap !== null &&
    performance.now() - lastTap.time < doubleTapMs &&
    distanceBetween(lastTap.point, point) < tapSlopPx * 3;
  lastTap = isDoubleTap ? null : { time: performance.now(), point };
  if (!isDoubleTap) return;
  if (view.scale > minScale) reset();
  else zoomTo(doubleTapScale, imagePointUnder(point), point);
}

function onWheel(event: WheelEvent) {
  const point = pointOf(event);
  zoomTo(view.scale * Math.exp(-event.deltaY * 0.002), imagePointUnder(point), point);
}

function zoomStep(factor: number) {
  const centre = stageCentre();
  zoomTo(view.scale * factor, imagePointUnder(centre), centre);
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape') close();
}

watch(
  openFileId,
  (fileId) => {
    reset();
    pointers.clear();
    pinch = null;
    document.documentElement.classList.toggle('image-viewer-open', fileId !== null);
    if (fileId) document.addEventListener('keydown', onKeyDown);
    else document.removeEventListener('keydown', onKeyDown);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  document.documentElement.classList.remove('image-viewer-open');
  document.removeEventListener('keydown', onKeyDown);
});
</script>

<template>
  <Teleport to="body">
    <div v-if="openFileId" class="image-viewer" role="dialog" aria-label="Image">
      <div class="bar">
        <button type="button" aria-label="Back" title="Back" @click="close">
          <MediaIcon name="back" />
        </button>
        <span class="zoom">
          <button type="button" aria-label="Zoom out" title="Zoom out" @click="zoomStep(1 / 1.5)">
            −
          </button>
          <button type="button" aria-label="Zoom in" title="Zoom in" @click="zoomStep(1.5)">
            +
          </button>
        </span>
      </div>
      <div
        ref="stage"
        class="stage"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @wheel.prevent="onWheel"
      >
        <img :src="`/api/files/${openFileId}`" alt="" :style="imageStyle" draggable="false" />
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.image-viewer {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  background: #111;
  color: white;
}

.bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: calc(env(safe-area-inset-top) + 0.5rem) 0.75rem 0.5rem;
}

.bar button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 2.5rem;
  min-height: 2.5rem;
  padding: 0;
  font-size: 1.25rem;
  background: rgb(255 255 255 / 0.12);
  border-color: transparent;
  color: inherit;
}

.bar .media-icon {
  width: 1.25rem;
  height: 1.25rem;
}

.zoom {
  display: flex;
  gap: 0.5rem;
}

.stage {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  overflow: hidden;
  touch-action: none;
  padding-bottom: env(safe-area-inset-bottom);
}

.stage img {
  max-width: 100%;
  max-height: 100%;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}
</style>
