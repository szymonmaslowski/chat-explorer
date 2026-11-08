<script setup lang="ts">
import type { Fork } from '@shared/types';
import { stratify, tree } from 'd3-hierarchy';
import { computed, ref } from 'vue';
import AttentionDot from '../components/AttentionDot.vue';
import ExplorationHeader from '../components/ExplorationHeader.vue';
import { archivingFork, forkTitle } from '../lib/conversation';
import { awaitsAnswer, forkAttention } from '../lib/read-state';
import { openExploration } from '../stores/exploration';

const props = defineProps<{ explorationId: string; currentForkId?: string }>();

// Narrow enough that the main fork and its children fit side by side on a phone.
const boxWidth = 160;
const boxHeight = 86;
const depthGap = 32;
const siblingGap = 14;
const padding = 16;

const state = computed(() => openExploration(props.explorationId));
const archivedForks = computed(
  () =>
    new Set(
      [...state.value.forks.values()]
        .filter((fork) => archivingFork(fork, state.value.forks))
        .map((fork) => fork.id),
    ),
);
// Shown from the start when the map opens from an archived fork, so it is not missing.
const chosenShowArchived = ref<boolean | null>(null);
const showArchived = computed({
  get: () =>
    chosenShowArchived.value ??
    (props.currentForkId !== undefined && archivedForks.value.has(props.currentForkId)),
  set: (shown) => (chosenShowArchived.value = shown),
});

const forkUrl = (fork: Fork) =>
  fork.parentForkId ? `/e/${props.explorationId}/f/${fork.id}` : `/e/${props.explorationId}`;

const layout = computed(() => {
  const forks = [...state.value.forks.values()].filter(
    (fork) => showArchived.value || !archivedForks.value.has(fork.id),
  );
  if (forks.length === 0) return null;
  const root = stratify<Fork>()
    .id((fork) => fork.id)
    .parentId((fork) => fork.parentForkId)(forks);
  tree<Fork>().nodeSize([boxHeight + siblingGap, boxWidth + depthGap])(root);
  const nodes = root.descendants();
  const minBreadth = Math.min(...nodes.map((node) => node.x ?? 0));
  const position = (breadth = 0, depth = 0) => ({
    left: depth + padding,
    top: breadth - minBreadth + padding,
  });
  const messageCounts = new Map<string, number>();
  for (const message of state.value.messages.values()) {
    messageCounts.set(message.forkId, (messageCounts.get(message.forkId) ?? 0) + 1);
  }
  const attention = forkAttention(state.value);
  const boxes = nodes.map((node) => {
    const fork = node.data;
    return {
      fork,
      ...position(node.x, node.y),
      messageCount: messageCounts.get(fork.id) ?? 0,
      awaitingAnswer: awaitsAnswer(fork, state.value.messages),
      attention: attention.get(fork.id),
      archived: archivedForks.value.has(fork.id),
    };
  });
  const edges = root.links().map(({ source, target }) => {
    const from = position(source.x, source.y);
    const to = position(target.x, target.y);
    const startX = from.left + boxWidth;
    const startY = from.top + boxHeight / 2;
    const endX = to.left;
    const endY = to.top + boxHeight / 2;
    const middleX = (startX + endX) / 2;
    return {
      id: target.data.id,
      path: `M ${startX} ${startY} C ${middleX} ${startY}, ${middleX} ${endY}, ${endX} ${endY}`,
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
      <template #links>
        · <span>Map</span> · <RouterLink :to="`/e/${explorationId}/notes`">Notes</RouterLink>
      </template>
    </ExplorationHeader>

    <label v-if="archivedForks.size > 0" class="show-archived">
      <input v-model="showArchived" type="checkbox" />
      Show archived forks ({{ archivedForks.size }})
    </label>

    <p v-if="state.status === 'loading'" class="muted">Loading…</p>
    <p v-else-if="state.status !== 'ready'" class="muted">This chat is not available.</p>

    <div v-else-if="layout" class="canvas-scroll">
      <div class="canvas" :style="{ width: `${layout.width}px`, height: `${layout.height}px` }">
        <svg :width="layout.width" :height="layout.height" class="edges">
          <path v-for="edge in layout.edges" :key="edge.id" :d="edge.path" />
        </svg>
        <RouterLink
          v-for="box in layout.boxes"
          :key="box.fork.id"
          :to="forkUrl(box.fork)"
          class="fork-box"
          :class="{ current: box.fork.id === currentForkId, archived: box.archived }"
          :style="{
            left: `${box.left}px`,
            top: `${box.top}px`,
            width: `${boxWidth}px`,
            height: `${boxHeight}px`,
          }"
        >
          <AttentionDot v-if="box.attention" :attention="box.attention" class="dot" />
          <span class="summary">{{ forkTitle(box.fork) }}</span>
          <span class="meta">
            {{ box.messageCount }} message{{ box.messageCount === 1 ? '' : 's' }}
            <span v-if="box.awaitingAnswer" class="awaiting">· awaiting answer</span>
            <span v-if="box.archived">· archived</span>
          </span>
        </RouterLink>
      </div>
    </div>
  </div>
</template>

<style scoped>
.map-page {
  display: flex;
  flex-direction: column;
  min-height: 100dvh;
  padding: 0 1rem;
}

.top {
  margin-bottom: 1rem;
}

.show-archived {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 1rem;
  font-size: 0.875rem;
}

/* Down to the bottom of the screen, so a swipe anywhere below a short map scrolls it sideways. */
.canvas-scroll {
  flex: 1;
  overflow-x: auto;
  padding-bottom: 2rem;
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

.fork-box.archived {
  border-style: dashed;
  opacity: 0.6;
}

.fork-box.current {
  border: 2px solid var(--accent);
}

.dot {
  position: absolute;
  top: 0.4rem;
  right: 0.4rem;
}

.summary {
  padding-right: 0.5rem;
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
