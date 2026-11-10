<script setup lang="ts">
import type { Fork } from '@shared/types';
import { stratify, tree } from 'd3-hierarchy';
import { computed, ref } from 'vue';
import { api, ApiError } from '../api';
import AttentionDot from '../components/AttentionDot.vue';
import ExplorationHeader from '../components/ExplorationHeader.vue';
import { archivingFork, forkLineage, forkTitle } from '../lib/conversation';
import { awaitsAnswer, forkAttention, type Attention } from '../lib/read-state';
import { openExploration } from '../stores/exploration';

const props = defineProps<{ explorationId: string; currentForkId?: string; side?: boolean }>();

// Narrow enough that the main fork and its children fit side by side on a phone.
const boxWidth = 160;
const boxHeight = 86;
// Boxes grow by a line once any fork of the chat has bookmarks, so all stay the same height.
const bookmarksLineHeight = 16;
const depthGap = 32;
const toggleSize = 16;
const chipHeight = 20;
// How far the collapse button reaches into its box, from the top left corner.
const toggleOverlap = 3;
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

// The forks on the way to the open fork stay on the map even when collapsed, so it is not missing.
const revealedForks = computed(() => {
  const current = props.currentForkId ? state.value.forks.get(props.currentForkId) : undefined;
  return new Set(current ? forkLineage(current, state.value.forks).map((fork) => fork.id) : []);
});

const error = ref('');

async function change(request: Promise<unknown>) {
  error.value = '';
  try {
    await request;
  } catch (failure) {
    error.value = failure instanceof ApiError ? failure.message : 'Something went wrong.';
  }
}

const collapse = (fork: Fork) => change(api.collapseFork(fork.id));
const expandChildren = (fork: Fork) => change(api.expandCollapsedChildren(fork.id));

function strongestAttention(attentions: (Attention | undefined)[]) {
  if (attentions.includes('failed')) return 'failed' as const;
  return attentions.includes('unread') ? ('unread' as const) : undefined;
}

const forkUrl = (fork: Fork) =>
  fork.parentForkId ? `/e/${props.explorationId}/f/${fork.id}` : `/e/${props.explorationId}`;

const layout = computed(() => {
  const shownForks = [...state.value.forks.values()].filter(
    (fork) => showArchived.value || !archivedForks.value.has(fork.id),
  );
  const childrenOf = new Map<string | null, Fork[]>();
  for (const fork of shownForks) {
    childrenOf.set(fork.parentForkId, [...(childrenOf.get(fork.parentForkId) ?? []), fork]);
  }
  const subtree = (fork: Fork): Fork[] => [
    fork,
    ...(childrenOf.get(fork.id) ?? []).flatMap(subtree),
  ];
  const forks: Fork[] = [];
  const hiddenBelow = new Map<string, Fork[]>();
  const visit = (fork: Fork) => {
    forks.push(fork);
    for (const child of childrenOf.get(fork.id) ?? []) {
      if (!child.collapsed || revealedForks.value.has(child.id)) visit(child);
      else hiddenBelow.set(fork.id, [...(hiddenBelow.get(fork.id) ?? []), ...subtree(child)]);
    }
  };
  for (const root of childrenOf.get(null) ?? []) visit(root);
  if (forks.length === 0) return null;
  const bookmarkCounts = new Map<string, number>();
  for (const bookmark of state.value.bookmarks.values()) {
    bookmarkCounts.set(bookmark.forkId, (bookmarkCounts.get(bookmark.forkId) ?? 0) + 1);
  }
  const height = boxHeight + (bookmarkCounts.size > 0 ? bookmarksLineHeight : 0);
  const root = stratify<Fork>()
    .id((fork) => fork.id)
    .parentId((fork) => fork.parentForkId)(forks);
  tree<Fork>().nodeSize([height + siblingGap, boxWidth + depthGap])(root);
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
  const awaiting = (fork: Fork) =>
    awaitsAnswer(fork, state.value.messages, state.value.forkRuns.get(fork.id));
  const boxes = nodes.map((node) => {
    const fork = node.data;
    const hidden = hiddenBelow.get(fork.id) ?? [];
    return {
      fork,
      ...position(node.x, node.y),
      messageCount: messageCounts.get(fork.id) ?? 0,
      bookmarkCount: bookmarkCounts.get(fork.id) ?? 0,
      awaitingAnswer: awaiting(fork),
      attention: attention.get(fork.id),
      archived: archivedForks.value.has(fork.id),
      hidden: {
        count: hidden.length,
        attention: strongestAttention(hidden.map((each) => attention.get(each.id))),
        awaitingAnswer: hidden.some(awaiting),
      },
    };
  });
  const edges = root.links().map(({ source, target }) => {
    const from = position(source.x, source.y);
    const to = position(target.x, target.y);
    const startX = from.left + boxWidth;
    const startY = from.top + height / 2;
    const endX = to.left;
    const endY = to.top + height / 2;
    const middleX = (startX + endX) / 2;
    return {
      id: target.data.id,
      path: `M ${startX} ${startY} C ${middleX} ${startY}, ${middleX} ${endY}, ${endX} ${endY}`,
    };
  });
  return {
    boxes,
    edges,
    boxHeight: height,
    width:
      Math.max(...boxes.map((box) => box.left + (box.hidden.count > 0 ? depthGap : 0))) +
      boxWidth +
      padding,
    height: Math.max(...boxes.map((box) => box.top)) + height + padding,
  };
});
</script>

<template>
  <div class="map-page">
    <ExplorationHeader :state="state" page="map" :side="side" class="top" />

    <label v-if="archivedForks.size > 0" class="show-archived">
      <input v-model="showArchived" type="checkbox" />
      Show archived forks ({{ archivedForks.size }})
    </label>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
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
            height: `${layout.boxHeight}px`,
          }"
        >
          <AttentionDot v-if="box.attention" :attention="box.attention" class="dot" />
          <span class="summary">{{ forkTitle(box.fork) }}</span>
          <span class="meta">
            {{ box.messageCount }} message{{ box.messageCount === 1 ? '' : 's' }}
            <span v-if="box.awaitingAnswer" class="awaiting">· awaiting answer</span>
            <span v-if="box.archived">· archived</span>
            <span v-if="box.bookmarkCount" class="bookmarks">
              {{ box.bookmarkCount }} bookmark{{ box.bookmarkCount === 1 ? '' : 's' }}
            </span>
          </span>
        </RouterLink>
        <template v-for="box in layout.boxes" :key="`toggles-${box.fork.id}`">
          <button
            v-if="box.fork.parentForkId && !revealedForks.has(box.fork.id)"
            type="button"
            class="collapse-toggle"
            :aria-label="`Collapse ${forkTitle(box.fork)}`"
            title="Hide this fork and the forks below it from the map"
            :style="{
              left: `${box.left - toggleSize + toggleOverlap}px`,
              top: `${box.top - toggleSize + toggleOverlap}px`,
              width: `${toggleSize}px`,
              height: `${toggleSize}px`,
            }"
            @click="collapse(box.fork)"
          >
            −
          </button>
          <button
            v-if="box.hidden.count > 0"
            type="button"
            class="hidden-chip"
            :class="{ awaiting: box.hidden.awaitingAnswer }"
            :aria-label="`Show ${box.hidden.count} collapsed fork${box.hidden.count === 1 ? '' : 's'}`"
            title="Show the collapsed forks below"
            :style="{
              left: `${box.left + boxWidth - chipHeight / 2}px`,
              top: `${box.top + (layout.boxHeight - chipHeight) / 2}px`,
              height: `${chipHeight}px`,
            }"
            @click="expandChildren(box.fork)"
          >
            +{{ box.hidden.count }}
            <AttentionDot v-if="box.hidden.attention" :attention="box.hidden.attention" />
          </button>
        </template>
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
  color: var(--accent);
}

.collapse-toggle,
.hidden-chip {
  position: absolute;
  min-width: 0;
  min-height: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.25rem;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text-muted);
  font-size: 0.75rem;
  line-height: 1;
}

.collapse-toggle {
  font-size: 0.7rem;
}

/* A bigger target than the small circle, reaching only the box's corner padding. */
.collapse-toggle::before {
  content: '';
  position: absolute;
  inset: -6px;
}

.collapse-toggle:hover,
.hidden-chip:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.hidden-chip {
  padding: 0 0.45rem;
  font-weight: 600;
}

.hidden-chip.awaiting {
  color: var(--accent);
}

.error {
  color: var(--danger);
}

.bookmarks {
  display: block;
  color: var(--bookmark);
}
</style>
