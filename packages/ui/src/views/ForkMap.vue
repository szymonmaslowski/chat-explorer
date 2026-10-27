<script setup lang="ts">
import type { Fork } from '@shared/types';
import { stratify, tree } from 'd3-hierarchy';
import { computed } from 'vue';
import ExplorationHeader from '../components/ExplorationHeader.vue';
import { forkPath, forkTitle } from '../lib/conversation';
import { openExploration } from '../stores/exploration';

const props = defineProps<{ explorationId: string; currentForkId?: string }>();

const boxWidth = 200;
const boxHeight = 86;
const horizontalGap = 28;
const verticalGap = 56;
const padding = 16;

const state = computed(() => openExploration(props.explorationId));

const forkUrl = (fork: Fork) =>
  fork.parentForkId ? `/e/${props.explorationId}/f/${fork.id}` : `/e/${props.explorationId}`;

const layout = computed(() => {
  const forks = [...state.value.forks.values()];
  if (forks.length === 0) return null;
  const root = stratify<Fork>()
    .id((fork) => fork.id)
    .parentId((fork) => fork.parentForkId)(forks);
  tree<Fork>().nodeSize([boxWidth + horizontalGap, boxHeight + verticalGap])(root);
  const nodes = root.descendants();
  const minX = Math.min(...nodes.map((node) => node.x ?? 0));
  const position = (x = 0, y = 0) => ({ left: x - minX + padding, top: y + padding });
  const messageCounts = new Map<string, number>();
  for (const message of state.value.messages.values()) {
    messageCounts.set(message.forkId, (messageCounts.get(message.forkId) ?? 0) + 1);
  }
  const boxes = nodes.map((node) => {
    const fork = node.data;
    const last = forkPath(fork, state.value.messages).at(-1);
    return {
      fork,
      ...position(node.x, node.y),
      messageCount: messageCounts.get(fork.id) ?? 0,
      awaitingAnswer: last?.role === 'user',
    };
  });
  const edges = root.links().map(({ source, target }) => {
    const from = position(source.x, source.y);
    const to = position(target.x, target.y);
    const startX = from.left + boxWidth / 2;
    const startY = from.top + boxHeight;
    const endX = to.left + boxWidth / 2;
    const endY = to.top;
    const middleY = (startY + endY) / 2;
    return {
      id: target.data.id,
      path: `M ${startX} ${startY} C ${startX} ${middleY}, ${endX} ${middleY}, ${endX} ${endY}`,
    };
  });
  return {
    boxes,
    edges,
    width: Math.max(...boxes.map((box) => box.left)) + boxWidth + padding,
    height: Math.max(...boxes.map((box) => box.top)) + boxHeight + padding,
  };
});
</script>

<template>
  <div class="map-page">
    <ExplorationHeader :state="state" class="top">
      <template #links>· <span>Map</span></template>
    </ExplorationHeader>

    <p v-if="state.status === 'loading'" class="muted">Loading…</p>
    <p v-else-if="state.status !== 'ready'" class="muted">This exploration is not available.</p>

    <div
      v-else-if="layout"
      class="canvas"
      :style="{ width: `${layout.width}px`, height: `${layout.height}px` }"
    >
      <svg :width="layout.width" :height="layout.height" class="edges">
        <path v-for="edge in layout.edges" :key="edge.id" :d="edge.path" />
      </svg>
      <RouterLink
        v-for="box in layout.boxes"
        :key="box.fork.id"
        :to="forkUrl(box.fork)"
        class="fork-box"
        :class="{ current: box.fork.id === currentForkId }"
        :style="{
          left: `${box.left}px`,
          top: `${box.top}px`,
          width: `${boxWidth}px`,
          height: `${boxHeight}px`,
        }"
      >
        <span class="summary">{{ forkTitle(box.fork) }}</span>
        <span class="meta">
          {{ box.messageCount }} message{{ box.messageCount === 1 ? '' : 's' }}
          <span v-if="box.awaitingAnswer" class="awaiting">· awaiting answer</span>
        </span>
      </RouterLink>
    </div>
  </div>
</template>

<style scoped>
.map-page {
  padding: 0 1rem 2rem;
}

.top {
  margin-bottom: 1rem;
}

.canvas {
  position: relative;
  margin: 0 auto;
}

.edges {
  position: absolute;
  inset: 0;
}

.edges path {
  fill: none;
  stroke: var(--border);
  stroke-width: 2;
}

.fork-box {
  position: absolute;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 0.6rem 0.75rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: inherit;
  text-decoration: none;
  font-size: 0.85rem;
}

.fork-box:hover {
  border-color: var(--accent);
}

.fork-box.current {
  border: 2px solid var(--accent);
}

.summary {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-weight: 600;
}

.meta {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.awaiting {
  color: var(--warning);
}
</style>
