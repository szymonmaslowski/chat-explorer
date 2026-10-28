<script setup lang="ts">
import type { Comment } from '@shared/types';
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { anchorOfRange, clampToRoot, locateAnchor, type TextAnchor } from '../lib/anchoring';
import { layoutCards } from '../lib/card-layout';
import { pointer } from '../lib/pointer';
import { blockIndexAt, blockTextRange, speechBlocks } from '../lib/speech-blocks';
import { playBlock, speech } from '../stores/speech';
import { useMediaQuery } from '../composables/useMediaQuery';
import CommentCard from './CommentCard.vue';
import CommentEditor from './CommentEditor.vue';
import CommentTray from './CommentTray.vue';
import MediaIcon from './MediaIcon.vue';

const props = defineProps<{
  explorationId: string;
  forkId: string;
  comments: Comment[];
  layoutKey: string;
  compact: boolean;
  readOnly: boolean;
}>();

const draftWidth = 280;
const submittedWidth = 220;
const estimatedHeight = { draft: 78, queued: 60, submitted: 28 } as const;
const flashMs = 1_400;
const selectionSettleMs = 300;
// Keeps the button clear of the selection handles on touch screens.
const touchButtonOffset = 24;
const buttonWidth = { mouse: 84, touch: 124 };
const playButtonWidth = { mouse: 72, touch: 110 };

const route = useRoute();
const coarsePointer = useMediaQuery('(pointer: coarse)');
const router = useRouter();
const layer = ref<HTMLElement | null>(null);
const layerWidth = ref(0);
const anchors = shallowRef(new Map<string, Range>());
const anchorBoxes = shallowRef(new Map<string, { top: number; left: number }>());
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
const actions = computed(() => picked.value ?? selection.value);
const commentable = computed(() => actions.value !== null && !props.readOnly);
const playable = computed(() => picked.value?.speakable === true);
const pickedPlaying = computed(
  () =>
    speech.playing &&
    speech.playback?.messageId === picked.value?.messageId &&
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
  if (props.compact) return [];
  const requests = shownComments.value.flatMap((comment) => {
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

const listedComments = computed(() => {
  if (!props.compact) return [];
  const byMessage = new Map<string, Comment[]>();
  for (const comment of shownComments.value.toSorted(
    (left, right) => left.startOffset - right.startOffset,
  )) {
    byMessage.set(comment.messageId, [...(byMessage.get(comment.messageId) ?? []), comment]);
  }
  return [...byMessage].map(([messageId, comments]) => ({ messageId, comments }));
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
  return {
    messageId: root.dataset.anchorRoot!,
    anchor,
    buttonTop: lastLine.bottom + 4 + (clearHandles && coarsePointer.value ? touchButtonOffset : 0),
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
  const width = coarsePointer.value ? buttonWidth.touch : buttonWidth.mouse;
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
  if (props.readOnly && !speakable) return;
  const width =
    (props.readOnly ? 0 : coarsePointer.value ? buttonWidth.touch : buttonWidth.mouse) +
    (speakable ? (coarsePointer.value ? playButtonWidth.touch : playButtonWidth.mouse) : 0);
  const placement = placeActions(root, blockTextRange(element), width, false);
  if (!placement) return;
  picked.value = { ...placement, blockIndex, speakable };
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
  const alreadyPicked = block?.element === pickedElement;
  unpick();
  if (root && block && !alreadyPicked) pick(root, block.element, blocks.indexOf(block));
}

function playPicked() {
  if (!picked.value) return;
  const { messageId, blockIndex } = picked.value;
  const root = container()?.querySelector<HTMLElement>(`[data-anchor-root="${messageId}"]`);
  if (!root) return;
  playBlock(
    messageId,
    speechBlocks(root).map(({ block }) => block),
    blockIndex,
  );
  unpick();
}

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
    left: Math.max(0, Math.min(lineLeft, layerWidth.value - draftWidth)),
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
      :placement="card"
      @measure="(height) => heights.set(card.id, height)"
      @open="openSubmitted"
    />

    <Teleport
      v-for="group in listedComments"
      :key="group.messageId"
      :to="`#comments-${group.messageId}`"
      defer
    >
      <CommentCard
        v-for="comment in group.comments"
        :key="comment.id"
        :comment="comment"
        @open="openSubmitted"
        @jump="scrollToComment(comment.id)"
      />
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
        @pointerup="openEditor"
        @click="openEditor"
      >
        Comment
      </button>
      <button
        v-if="playable"
        type="button"
        class="comment-button play-button"
        :aria-label="pickedPlaying ? 'Pause' : 'Read aloud from here'"
        @pointerdown.prevent
        @mousedown.prevent
        @click="playPicked"
      >
        <MediaIcon :name="pickedPlaying ? 'pause' : 'play'" />
        {{ pickedPlaying ? 'Pause' : 'Play' }}
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
      :width="draftWidth"
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
  border-radius: 999px;
  border-color: var(--text);
  background: var(--text);
  color: var(--background);
  box-shadow: var(--shadow);
  font-size: 0.8rem;
  padding: 0.15rem 0.7rem;
}

.play-button {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}

@media (pointer: coarse) {
  .comment-button {
    font-size: 1rem;
    font-weight: 600;
    padding: 0.6rem 1.3rem;
  }
}
</style>
