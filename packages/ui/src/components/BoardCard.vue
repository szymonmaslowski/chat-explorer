<script setup lang="ts">
import type { BoardColumn, Fork } from '@shared/types';
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useCopied } from '../composables/useCopied';
import { usePopover } from '../composables/usePopover';
import { forkTitle } from '../lib/conversation';
import type { Attention } from '../lib/read-state';
import AttentionDot from './AttentionDot.vue';
import MediaIcon from './MediaIcon.vue';

const props = defineProps<{
  fork: Fork;
  url: string;
  messageCount: number;
  awaitingAnswer: boolean;
  attention: Attention | undefined;
  archived: boolean;
  current: boolean;
  // Cards can be moved while the board shows the live forks and the daemon is reachable.
  movable: boolean;
  columns: BoardColumn[];
  canMoveUp: boolean;
  canMoveDown: boolean;
}>();
const emit = defineEmits<{
  moveTo: [columnId: string | null];
  up: [];
  down: [];
}>();

const { open, closeOnEscape } = usePopover('root');
const { copy } = useCopied();

// The menu is placed against the screen, not the card, so the scrolling area around the columns
// can't cut it off. It opens below the button, or above it when there is no room below.
const menuButton = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({});
const close = () => (open.value = false);

watch(open, async (isOpen) => {
  if (!isOpen) {
    window.removeEventListener('scroll', close, true);
    return;
  }
  window.addEventListener('scroll', close, true);
  const anchor = menuButton.value?.getBoundingClientRect();
  if (!anchor) return;
  menuStyle.value = {
    top: `${anchor.bottom + 4}px`,
    right: `${window.innerWidth - anchor.right}px`,
  };
  await nextTick();
  const height = menu.value?.offsetHeight ?? 0;
  if (anchor.bottom + 4 + height > window.innerHeight && anchor.top - 4 - height > 0) {
    menuStyle.value = { ...menuStyle.value, top: `${anchor.top - 4 - height}px` };
  }
});
onBeforeUnmount(() => window.removeEventListener('scroll', close, true));

function pick(action: () => void) {
  open.value = false;
  action();
}
</script>

<template>
  <div
    ref="root"
    class="board-card"
    :class="{ archived, current, 'awaiting-box': awaitingAnswer }"
    :data-fork-id="fork.id"
    @keydown.esc="closeOnEscape"
  >
    <RouterLink :to="url" class="card-link" draggable="false">
      <AttentionDot v-if="attention" :attention="attention" class="dot" />
      <span class="fork-id">{{ fork.id }}</span>
      <span class="summary">{{ forkTitle(fork) }}</span>
      <span class="meta">
        {{ messageCount }} message{{ messageCount === 1 ? '' : 's' }}
        <span v-if="awaitingAnswer" class="awaiting">· awaiting answer</span>
        <span v-if="archived">· archived</span>
      </span>
    </RouterLink>
    <button
      ref="menuButton"
      type="button"
      class="icon-button more"
      aria-label="Fork actions"
      title="Fork actions"
      :aria-expanded="open"
      @click="open = !open"
    >
      <MediaIcon name="more" />
    </button>
    <div v-if="open" ref="menu" class="menu" role="menu" :style="menuStyle">
      <button type="button" role="menuitem" @click="pick(() => copy({ plain: props.fork.id }))">
        Copy id
      </button>
      <template v-if="movable">
        <button
          type="button"
          role="menuitem"
          :disabled="!canMoveUp"
          @click="pick(() => emit('up'))"
        >
          Move up
        </button>
        <button
          type="button"
          role="menuitem"
          :disabled="!canMoveDown"
          @click="pick(() => emit('down'))"
        >
          Move down
        </button>
        <p class="menu-label">Move to</p>
        <button
          v-for="column in columns"
          :key="column.id"
          type="button"
          role="menuitem"
          :disabled="column.id === fork.boardColumnId"
          @click="pick(() => emit('moveTo', column.id))"
        >
          {{ column.name }}
        </button>
        <button
          type="button"
          role="menuitem"
          :disabled="fork.boardColumnId === null"
          @click="pick(() => emit('moveTo', null))"
        >
          Ungrouped
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.board-card {
  position: relative;
  min-height: 5.5rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 0.85rem;
}

.board-card:hover {
  border-color: var(--accent);
}

.board-card.archived {
  border-style: dashed;
  opacity: 0.6;
}

.board-card.current {
  /* Same 1px border as other cards, so selecting never changes the size. */
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}

@keyframes box-pulse {
  50% {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent);
  }
}

.board-card.awaiting-box {
  animation: box-pulse 2.6s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .board-card.awaiting-box {
    animation: none;
    border-color: var(--accent);
  }
}

.card-link {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-height: 5.5rem;
  padding: 0.6rem 2.2rem 0.6rem 0.75rem;
  color: inherit;
  text-decoration: none;
}

.dot {
  position: absolute;
  bottom: 0.5rem;
  right: 0.6rem;
}

.fork-id {
  font-size: 0.65rem;
  line-height: 1.2;
  color: var(--text-muted);
  opacity: 0.8;
}

.summary {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-weight: 600;
}

.meta {
  margin-top: auto;
  font-size: 0.75rem;
  color: var(--text-muted);
}

.awaiting {
  color: var(--accent);
}

.more {
  position: absolute;
  top: 0.25rem;
  right: 0.25rem;
  min-width: 1.6rem;
  min-height: 1.6rem;
  padding: 0;
  border-color: transparent;
  background: transparent;
  color: var(--text-muted);
}

.menu {
  position: fixed;
  z-index: 20;
  display: flex;
  flex-direction: column;
  min-width: 9rem;
  padding: 0.25rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 4px 14px rgb(0 0 0 / 18%);
}

.menu button {
  border: none;
  background: transparent;
  text-align: left;
}

.menu button:disabled {
  opacity: 0.4;
}

.menu-label {
  margin: 0.25rem 0.5rem 0;
  font-size: 0.7rem;
  color: var(--text-muted);
}
</style>
