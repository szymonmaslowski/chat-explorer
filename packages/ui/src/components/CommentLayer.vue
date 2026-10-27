<script setup lang="ts">
import type { Comment, CommentType } from '@shared/types';
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import { anchorOfRange, locateAnchor, type TextAnchor } from '../lib/anchoring';
import { layoutCards } from '../lib/card-layout';
import { pointer } from '../lib/pointer';
import CommentCard from './CommentCard.vue';
import CommentEditor from './CommentEditor.vue';
import CommentTray from './CommentTray.vue';

const props = defineProps<{
  explorationId: string;
  forkId: string;
  comments: Comment[];
  layoutKey: string;
}>();

const draftWidth = 280;
const submittedWidth = 220;
const estimatedHeight = { draft: 78, queued: 60, submitted: 28 } as const;
const flashMs = 1_400;

const route = useRoute();
const router = useRouter();
const layer = ref<HTMLElement | null>(null);
const layerWidth = ref(0);
const anchors = shallowRef(new Map<string, Range>());
const anchorBoxes = shallowRef(new Map<string, { top: number; left: number }>());
const heights = reactive(new Map<string, number>());
const trayIds = shallowRef(new Set<string>());
const selection = ref<{
  messageId: string;
  anchor: TextAnchor;
  buttonTop: number;
  buttonLeft: number;
  lineTop: number;
  lineLeft: number;
} | null>(null);
const editor = ref<{ messageId: string; anchor: TextAnchor; top: number; left: number } | null>(
  null,
);

const container = () => layer.value?.parentElement ?? null;
const anchorRootOf = (node: Node) =>
  (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
    '[data-anchor-root]',
  ) ?? null;
const firstLineRect = (range: Range) => range.getClientRects()[0] ?? range.getBoundingClientRect();

const relative = (rect: DOMRect) => {
  const base = layer.value!.getBoundingClientRect();
  return {
    top: rect.top - base.top,
    left: rect.left - base.left,
    right: rect.right - base.left,
    bottom: rect.bottom - base.top,
  };
};

function reanchor() {
  const root = container();
  if (!root) return;
  const next = new Map<string, Range>();
  for (const comment of props.comments) {
    const anchorRoot = root.querySelector<HTMLElement>(`[data-anchor-root="${comment.messageId}"]`);
    const range = anchorRoot && locateAnchor(anchorRoot, comment);
    if (range) next.set(comment.id, range);
  }
  anchors.value = next;
  paintHighlights();
  measure();
}

function measure() {
  if (!layer.value) return;
  layerWidth.value = layer.value.clientWidth;
  const boxes = new Map<string, { top: number; left: number }>();
  for (const [id, range] of anchors.value) boxes.set(id, relative(firstLineRect(range)));
  anchorBoxes.value = boxes;
  updateTray();
}

function updateTray() {
  const header = document.querySelector('[data-sticky-header]');
  const limit = header ? header.getBoundingClientRect().bottom : 0;
  const inTray = new Set<string>();
  for (const comment of props.comments) {
    const range = anchors.value.get(comment.id);
    if (comment.status === 'draft' && range && firstLineRect(range).bottom < limit) {
      inTray.add(comment.id);
    }
  }
  const changed =
    inTray.size !== trayIds.value.size || [...inTray].some((id) => !trayIds.value.has(id));
  if (changed) trayIds.value = inTray;
}

function paintHighlights() {
  if (!('highlights' in CSS)) return;
  const groups: Record<string, Range[]> = {
    'comment-inline': [],
    'comment-fork': [],
    'comment-submitted': [],
  };
  for (const comment of props.comments) {
    const range = anchors.value.get(comment.id);
    if (!range) continue;
    const group = comment.status === 'submitted' ? 'comment-submitted' : `comment-${comment.type}`;
    groups[group]!.push(range);
  }
  for (const [name, ranges] of Object.entries(groups)) {
    CSS.highlights.set(name, new Highlight(...ranges));
  }
}

function flash(range: Range) {
  if (!('highlights' in CSS)) return;
  CSS.highlights.set('comment-flash', new Highlight(range));
  setTimeout(() => CSS.highlights.delete('comment-flash'), flashMs);
}

function scrollToComment(commentId: string) {
  const range = anchors.value.get(commentId);
  if (!range) return false;
  const header = document.querySelector('[data-sticky-header]');
  const headerHeight = header ? header.getBoundingClientRect().height : 0;
  const top = firstLineRect(range).top + window.scrollY - headerHeight - 140;
  window.scrollTo({ top, behavior: 'smooth' });
  flash(range);
  return true;
}

const floatingCards = computed(() => {
  const requests = props.comments.flatMap((comment) => {
    const box = anchorBoxes.value.get(comment.id);
    if (!box || trayIds.value.has(comment.id)) return [];
    return [
      {
        id: comment.id,
        anchorTop: box.top,
        anchorLeft: box.left,
        width: comment.status === 'submitted' ? submittedWidth : draftWidth,
        height: heights.get(comment.id) ?? estimatedHeight[comment.status],
      },
    ];
  });
  const byId = new Map(props.comments.map((comment) => [comment.id, comment]));
  return layoutCards(requests, layerWidth.value).map((placement) => ({
    ...placement,
    comment: byId.get(placement.id)!,
  }));
});

const trayComments = computed(() =>
  props.comments.filter((comment) => trayIds.value.has(comment.id)),
);

function onMouseUp() {
  setTimeout(() => {
    if (editor.value) return;
    const current = window.getSelection();
    if (!current || current.isCollapsed || current.rangeCount === 0) {
      selection.value = null;
      return;
    }
    const range = current.getRangeAt(0);
    const root = anchorRootOf(range.startContainer);
    const anchor = root && root === anchorRootOf(range.endContainer) && anchorOfRange(root, range);
    if (!root || !anchor) {
      selection.value = null;
      return;
    }
    const rects = range.getClientRects();
    const lastLine = relative(rects[rects.length - 1] ?? range.getBoundingClientRect());
    const firstLine = relative(firstLineRect(range));
    selection.value = {
      messageId: root.dataset.anchorRoot!,
      anchor,
      buttonTop: lastLine.bottom + 4,
      buttonLeft: Math.max(0, Math.min(lastLine.right + 6, layerWidth.value - 84)),
      lineTop: firstLine.top,
      lineLeft: firstLine.left,
    };
  });
}

function onSelectionChange() {
  if (!editor.value && window.getSelection()?.isCollapsed) selection.value = null;
}

function openEditor() {
  if (!selection.value) return;
  const { messageId, anchor, lineTop, lineLeft } = selection.value;
  editor.value = {
    messageId,
    anchor,
    top: lineTop,
    left: Math.max(0, Math.min(lineLeft, layerWidth.value - draftWidth)),
  };
  selection.value = null;
}

async function saveComment(body: string, type: CommentType) {
  if (!editor.value) return;
  const { messageId, anchor } = editor.value;
  await api.createComment(props.explorationId, {
    messageId,
    viewForkId: props.forkId,
    ...anchor,
    body,
    type,
  });
  editor.value = null;
  window.getSelection()?.removeAllRanges();
}

function openSubmitted(comment: Comment) {
  if (comment.createdForkId) {
    void router.push(`/e/${props.explorationId}/f/${comment.createdForkId}`);
  } else if (comment.replyMessageId) {
    void router.push({ hash: `#m-${comment.replyMessageId}` });
  }
}

let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
  const root = container();
  root?.addEventListener('mouseup', onMouseUp);
  document.addEventListener('selectionchange', onSelectionChange);
  resizeObserver = new ResizeObserver(() => measure());
  if (root) resizeObserver.observe(root);
  reanchor();
});

onBeforeUnmount(() => {
  container()?.removeEventListener('mouseup', onMouseUp);
  document.removeEventListener('selectionchange', onSelectionChange);
  resizeObserver?.disconnect();
  if ('highlights' in CSS) CSS.highlights.clear();
});

watch(() => [props.comments, props.layoutKey], reanchor, { flush: 'post' });
watch(() => pointer.frame, updateTray);

let handledHash = '';
watch(
  [() => route.hash, anchors],
  ([hash]) => {
    if (!hash.startsWith('#c-') || hash === handledHash) return;
    if (scrollToComment(hash.slice(3))) handledHash = hash;
  },
  { flush: 'post' },
);
</script>

<template>
  <div ref="layer" class="comment-layer">
    <Teleport to="#comment-tray" defer>
      <CommentTray :comments="trayComments" @jump="scrollToComment" />
    </Teleport>

    <CommentCard
      v-for="card in floatingCards"
      :key="card.id"
      :comment="card.comment"
      :top="card.top"
      :left="card.left"
      :width="card.width"
      @measure="(height) => heights.set(card.id, height)"
      @open="openSubmitted"
    />

    <button
      v-if="selection"
      type="button"
      class="comment-button"
      :style="{ top: `${selection.buttonTop}px`, left: `${selection.buttonLeft}px` }"
      title="Comment on the selection"
      @mousedown.prevent
      @click="openEditor"
    >
      Comment
    </button>

    <CommentEditor
      v-if="editor"
      :quote="editor.anchor.quote"
      :top="editor.top"
      :left="editor.left"
      :width="draftWidth"
      @save="saveComment"
      @cancel="editor = null"
    />
  </div>
</template>

<style scoped>
.comment-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.comment-layer > * {
  pointer-events: auto;
}

.comment-button {
  position: absolute;
  z-index: 4;
  border-radius: 999px;
  box-shadow: var(--shadow);
  font-size: 0.8rem;
  padding: 0.15rem 0.7rem;
}
</style>
