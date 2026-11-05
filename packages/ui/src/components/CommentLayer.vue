<script setup lang="ts">
import { inTextOrder } from '@shared/fork-groups';
import type { Comment } from '@shared/types';
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { anchorOfRange, clampToRoot, locateAnchor, type TextAnchor } from '../lib/anchoring';
import { draftCardWidth, layoutCards, railLeftOf, submittedCardWidth } from '../lib/card-layout';
import { pointer } from '../lib/pointer';
import { useCopied } from '../composables/useCopied';
import { blockClipboardText } from '../lib/clipboard';
import {
  blockIndexAt,
  blockTextRange,
  pickableElementAt,
  speechBlocks,
} from '../lib/speech-blocks';
import { stopJoining } from '../stores/fork-joining';
import { playBlock, speech } from '../stores/speech';
import { useMediaQuery } from '../composables/useMediaQuery';
import CommentCard from './CommentCard.vue';
import CommentEditor from './CommentEditor.vue';
import CommentTray from './CommentTray.vue';
import ForkGroupCard from './ForkGroupCard.vue';
import MediaIcon from './MediaIcon.vue';

const props = defineProps<{
  explorationId: string;
  forkId: string;
  comments: Comment[];
  layoutKey: string;
  compact: boolean;
  readOnly: boolean;
}>();

const estimatedHeight = { draft: 78, queued: 60, submitted: 28 } as const;
const flashMs = 1_400;
const selectionSettleMs = 300;
// Keeps the button clear of the selection handles on touch screens.
const touchButtonOffset = 24;
// A round icon button and the gap after it; the height matches .comment-button.
const actionButtonWidth = { mouse: 38, touch: 50 };
const actionButtonHeight = { mouse: 32, touch: 44 };

const route = useRoute();
const coarsePointer = useMediaQuery('(pointer: coarse)');
const router = useRouter();
const layer = ref<HTMLElement | null>(null);
const layerWidth = ref(0);
const railLeft = computed(() => railLeftOf(layerWidth.value));
const anchors = shallowRef(new Map<string, Range>());
const anchorBoxes = shallowRef(new Map<string, { top: number; left: number }>());
// The messages on the page, top to bottom, for putting comments in the order of their text.
const messageOrder = shallowRef<string[]>([]);
const heights = reactive(new Map<string, number>());
const trayIds = shallowRef(new Set<string>());
interface ActionsPlacement {
  messageId: string;
  anchor: TextAnchor;
  buttonTop: number;
  buttonLeft: number;
  lineTop: number;
  lineLeft: number;
}

const selection = ref<ActionsPlacement | null>(null);
// A block picked with a tap: commented on as a whole, or read aloud from.
const picked = ref<(ActionsPlacement & { blockIndex: number; speakable: boolean }) | null>(null);
let pickedElement: HTMLElement | null = null;
const { copied, copy } = useCopied();
const actions = computed(() => picked.value ?? selection.value);
const commentable = computed(() => actions.value !== null && !props.readOnly);
const playable = computed(() => picked.value?.speakable === true);
const pickedPlaying = computed(
  () =>
    speech.playing &&
    speech.playback?.id === picked.value?.messageId &&
    speech.playback?.index === picked.value?.blockIndex,
);
const editor = ref<{
  messageId: string;
  anchor: TextAnchor;
  top: number;
  left: number;
  commentId: string | null;
} | null>(null);
// The comment open in the editor shows there, not also as a card.
const shownComments = computed(() =>
  props.comments.filter((comment) => comment.id !== editor.value?.commentId),
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
  messageOrder.value = [...root.querySelectorAll<HTMLElement>('[data-anchor-root]')].flatMap(
    (element) => element.dataset.anchorRoot ?? [],
  );
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
  if (props.compact) {
    if (trayIds.value.size > 0) trayIds.value = new Set();
    return;
  }
  const header = document.querySelector('[data-sticky-header]');
  const limit = header ? header.getBoundingClientRect().bottom : 0;
  const inTray = new Set<string>();
  // A chip has no editor, so a comment being edited keeps its card. A fork group keeps its card
  // too, so it stays whole.
  for (const comment of props.comments) {
    const range = anchors.value.get(comment.id);
    const beingEdited = comment.editBody !== null;
    if (
      comment.status === 'draft' &&
      !beingEdited &&
      !comment.forkGroupId &&
      range &&
      firstLineRect(range).bottom < limit
    ) {
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
    'comment-note': [],
    'comment-submitted': [],
  };
  for (const comment of props.comments) {
    const range = anchors.value.get(comment.id);
    // A general comment marks no text. Safari paints its empty range across the whole line.
    if (!range || range.collapsed) continue;
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
  if (!range.collapsed) flash(range);
  return true;
}

// A comment on its own, or the comments of a fork group in text order. A group shows as one card
// at the place of its first comment.
const cardEntries = computed(() => {
  const entries = new Map<string, Comment[]>();
  for (const comment of inTextOrder(shownComments.value, messageOrder.value)) {
    const key = comment.forkGroupId ?? comment.id;
    entries.set(key, [...(entries.get(key) ?? []), comment]);
  }
  return [...entries.values()].map((comments) => ({ first: comments[0]!, comments }));
});

const floatingCards = computed(() => {
  if (props.compact) return [];
  const requests = cardEntries.value.flatMap(({ first, comments }) => {
    const box = anchorBoxes.value.get(first.id);
    if (!box || trayIds.value.has(first.id)) return [];
    return [
      {
        id: first.id,
        anchorTop: box.top,
        anchorLeft: box.left,
        width: first.status === 'submitted' ? submittedCardWidth : draftCardWidth,
        height: heights.get(first.id) ?? estimatedHeight[first.status] * comments.length,
      },
    ];
  });
  const byFirstId = new Map(cardEntries.value.map((entry) => [entry.first.id, entry]));
  return layoutCards(requests, railLeft.value).map((placement) => ({
    ...placement,
    ...byFirstId.get(placement.id)!,
  }));
});

const trayComments = computed(() =>
  props.comments.filter((comment) => trayIds.value.has(comment.id)),
);

const listedComments = computed(() => {
  if (!props.compact) return [];
  const byMessage = new Map<string, (typeof cardEntries.value)[number][]>();
  for (const entry of cardEntries.value) {
    const { messageId } = entry.first;
    byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), entry]);
  }
  return [...byMessage].map(([messageId, entries]) => ({ messageId, entries }));
});

let mouseButtonDown = false;
let selectionAtPointerDown = false;
let selectionTimer: ReturnType<typeof setTimeout> | undefined;

function onPointerDown(event: PointerEvent) {
  if (event.pointerType === 'mouse') mouseButtonDown = true;
  selectionAtPointerDown = window.getSelection()?.isCollapsed === false;
  if (event.target instanceof Node && !container()?.contains(event.target)) unpick();
}

function onMouseUp() {
  mouseButtonDown = false;
  setTimeout(showCommentButton);
}

function placeActions(
  root: HTMLElement,
  range: Range,
  width: number,
  clearHandles: boolean,
): ActionsPlacement | null {
  const anchor = anchorOfRange(root, range);
  if (!anchor) return null;
  const rects = range.getClientRects();
  const lastLine = relative(rects[rects.length - 1] ?? range.getBoundingClientRect());
  const firstLine = relative(firstLineRect(range));
  const height = coarsePointer.value ? actionButtonHeight.touch : actionButtonHeight.mouse;
  const below = lastLine.bottom + 4 + (clearHandles && coarsePointer.value ? touchButtonOffset : 0);
  // The reply box covers what is below it, so at the end of the page the buttons go above the text.
  const dockTop = document.querySelector('[data-dock]')?.getBoundingClientRect().top ?? Infinity;
  const layerTop = layer.value!.getBoundingClientRect().top;
  const underDock = layerTop + below + height > dockTop;
  return {
    messageId: root.dataset.anchorRoot!,
    anchor,
    buttonTop: underDock ? firstLine.top - 4 - height : below,
    buttonLeft: Math.max(0, Math.min(lastLine.right + 6, layerWidth.value - width)),
    lineTop: firstLine.top,
    lineLeft: firstLine.left,
  };
}

function showCommentButton() {
  if (editor.value) return;
  const current = window.getSelection();
  if (!current || current.isCollapsed || current.rangeCount === 0) {
    selection.value = null;
    return;
  }
  const selected = current.getRangeAt(0);
  const root = anchorRootOf(selected.startContainer) ?? anchorRootOf(selected.endContainer);
  if (!root || !container()?.contains(root)) {
    selection.value = null;
    return;
  }
  const width = coarsePointer.value ? actionButtonWidth.touch : actionButtonWidth.mouse;
  selection.value = placeActions(root, clampToRoot(root, selected), width, true);
  if (selection.value) unpick();
}

function highlightPicked(element: HTMLElement | null) {
  pickedElement?.classList.remove('picked');
  pickedElement = element;
  element?.classList.add('picked');
}

function unpick() {
  picked.value = null;
  if (!editor.value) highlightPicked(null);
}

function pick(root: HTMLElement, element: HTMLElement, blockIndex: number) {
  const speakable = root.dataset.speakable !== undefined;
  const buttonCount = 1 + (props.readOnly ? 0 : 1) + (speakable ? 1 : 0);
  const width =
    buttonCount * (coarsePointer.value ? actionButtonWidth.touch : actionButtonWidth.mouse);
  const placement = placeActions(root, blockTextRange(element), width, false);
  if (!placement) return;
  picked.value = { ...placement, blockIndex, speakable };
  copied.value = false;
  highlightPicked(element);
}

// A tap on a block picks it; a tap on the picked block or anywhere else lets it go. A tap that
// only clears a text selection picks nothing.
function onClick(event: MouseEvent) {
  const target = event.target;
  if (!(target instanceof Element) || editor.value) return;
  if (target.closest('button, a, input, textarea, select, label')) return;
  if (selectionAtPointerDown || !window.getSelection()?.isCollapsed) {
    unpick();
    return;
  }
  const root = target.closest<HTMLElement>('[data-anchor-root]');
  const blocks = root && container()?.contains(root) ? speechBlocks(root) : [];
  const block = blocks[blockIndexAt(blocks, target)];
  const element = block && pickableElementAt(block.element, target);
  const alreadyPicked = element === pickedElement;
  unpick();
  if (root && block && element && !alreadyPicked) pick(root, element, blocks.indexOf(block));
}

function playPicked() {
  if (!picked.value) return;
  const { messageId, blockIndex } = picked.value;
  const root = container()?.querySelector<HTMLElement>(`[data-anchor-root="${messageId}"]`);
  if (!root) return;
  playBlock(
    { messageId },
    speechBlocks(root).map(({ block }) => block),
    blockIndex,
  );
  unpick();
}

const copyPicked = () => pickedElement && copy(blockClipboardText(pickedElement));

// Touch and keyboard selections have no mouseup, so the button follows a selection that settled.
function onSelectionChange() {
  if (!editor.value && window.getSelection()?.isCollapsed) selection.value = null;
  if (mouseButtonDown) return;
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(showCommentButton, selectionSettleMs);
}

function openEditor() {
  if (!actions.value) return;
  const { messageId, anchor, lineTop, lineLeft } = actions.value;
  editor.value = {
    messageId,
    anchor,
    top: lineTop,
    left: props.compact
      ? Math.max(0, Math.min(lineLeft, layerWidth.value - draftCardWidth))
      : railLeft.value,
    commentId: null,
  };
  selection.value = null;
  picked.value = null;
}

function closeEditor() {
  editor.value = null;
  highlightPicked(null);
  window.getSelection()?.removeAllRanges();
}

function openSubmitted(comment: Comment) {
  if (comment.createdForkId) {
    void router.push(`/e/${props.explorationId}/f/${comment.createdForkId}`);
  } else if (comment.createdNoteId) {
    void router.push(`/e/${props.explorationId}/notes#n-${comment.createdNoteId}`);
  } else if (comment.replyMessageId) {
    void router.push({ hash: `#m-${comment.replyMessageId}` });
  }
}

let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
  const root = container();
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('mouseup', onMouseUp);
  // On the conversation, not the document: iOS sends taps on plain text only to listeners
  // between the text and the document.
  root?.addEventListener('click', onClick);
  document.addEventListener('selectionchange', onSelectionChange);
  resizeObserver = new ResizeObserver(() => measure());
  if (root) resizeObserver.observe(root);
  reanchor();
});

onBeforeUnmount(() => {
  stopJoining();
  clearTimeout(selectionTimer);
  document.removeEventListener('pointerdown', onPointerDown);
  document.removeEventListener('mouseup', onMouseUp);
  container()?.removeEventListener('click', onClick);
  highlightPicked(null);
  document.removeEventListener('selectionchange', onSelectionChange);
  resizeObserver?.disconnect();
  if ('highlights' in CSS) CSS.highlights.clear();
});

watch(() => [props.comments, props.layoutKey, props.compact], reanchor, { flush: 'post' });
watch(() => pointer.frame, updateTray);

let handledHash = '';
watch(
  [() => route.hash, anchors],
  ([hash]) => {
    if (!hash.startsWith('#c-') || hash === handledHash) return;
    if (!scrollToComment(hash.slice(3))) return;
    handledHash = hash;
    // So the same link scrolls there again the next time.
    void router.replace({ hash: '' }).then(() => (handledHash = ''));
  },
  { flush: 'post' },
);
</script>

<template>
  <div ref="layer" class="comment-layer">
    <Teleport to="#comment-tray" defer>
      <CommentTray :comments="trayComments" @jump="scrollToComment" />
    </Teleport>

    <template v-for="card in floatingCards" :key="card.id">
      <ForkGroupCard
        v-if="card.first.forkGroupId"
        :comments="card.comments"
        :placement="card"
        @measure="(height) => heights.set(card.id, height)"
        @open="openSubmitted"
        @jump="(comment) => scrollToComment(comment.id)"
      />
      <CommentCard
        v-else
        :comment="card.first"
        :placement="card"
        @measure="(height) => heights.set(card.id, height)"
        @open="openSubmitted"
      />
    </template>

    <Teleport
      v-for="group in listedComments"
      :key="group.messageId"
      :to="`#comments-${group.messageId}`"
      defer
    >
      <template v-for="entry in group.entries" :key="entry.first.id">
        <ForkGroupCard
          v-if="entry.first.forkGroupId"
          :comments="entry.comments"
          @open="openSubmitted"
          @jump="(comment) => scrollToComment(comment.id)"
        />
        <CommentCard
          v-else
          :comment="entry.first"
          @open="openSubmitted"
          @jump="scrollToComment(entry.first.id)"
        />
      </template>
    </Teleport>

    <div
      v-if="actions && (commentable || playable)"
      class="selection-actions"
      :style="{ top: `${actions.buttonTop}px`, left: `${actions.buttonLeft}px` }"
    >
      <button
        v-if="commentable"
        type="button"
        class="comment-button"
        :title="picked ? 'Comment on this block' : 'Comment on the selection'"
        @pointerdown.prevent
        @mousedown.prevent
        @touchstart.prevent
        aria-label="Comment"
        @pointerup="openEditor"
        @click="openEditor"
      >
        <MediaIcon name="comment" />
      </button>
      <button
        v-if="playable"
        type="button"
        class="comment-button play-button"
        :aria-label="pickedPlaying ? 'Pause' : 'Read aloud from here'"
        :title="pickedPlaying ? 'Pause' : 'Read aloud from here'"
        @pointerdown.prevent
        @mousedown.prevent
        @click="playPicked"
      >
        <MediaIcon :name="pickedPlaying ? 'pause' : 'play'" />
      </button>
      <button
        v-if="picked"
        type="button"
        class="comment-button"
        :aria-label="copied ? 'Copied' : 'Copy this block'"
        :title="copied ? 'Copied' : 'Copy this block'"
        @pointerdown.prevent
        @mousedown.prevent
        @click="copyPicked"
      >
        <MediaIcon :name="copied ? 'check' : 'copy'" />
      </button>
    </div>

    <CommentEditor
      v-if="editor"
      :exploration-id="explorationId"
      :view-fork-id="forkId"
      :message-id="editor.messageId"
      :anchor="editor.anchor"
      :top="editor.top"
      :left="editor.left"
      :width="draftCardWidth"
      :in-rail="!compact"
      @created="(commentId) => editor && (editor.commentId = commentId)"
      @close="closeEditor"
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

.selection-actions {
  position: absolute;
  z-index: 4;
  display: flex;
  gap: 0.4rem;
}

.comment-button {
  display: inline-grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
  border-radius: 999px;
  border-color: var(--text);
  background: var(--text);
  color: var(--background);
  box-shadow: var(--shadow);
}

@media (pointer: coarse) {
  .comment-button {
    width: 2.75rem;
    height: 2.75rem;
  }

  .comment-button :deep(.media-icon) {
    width: 1.25rem;
    height: 1.25rem;
  }
}
</style>
