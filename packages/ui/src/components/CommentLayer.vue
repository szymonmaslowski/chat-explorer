<script setup lang="ts">
import { inTextOrder } from '@shared/fork-groups';
import { insertedAttribute } from '@shared/speech-blocks';
import type { Bookmark, Comment } from '@shared/types';
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  shallowRef,
  watch,
} from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { anchorOfRange, clampToRoot, locateAnchor, type TextAnchor } from '../lib/anchoring';
import { draftCardWidth, layoutCards, railLeftOf, submittedCardWidth } from '../lib/card-layout';
import { lineBoxes, nestingLevels, outlinePath } from '../lib/outlines';
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
import { newId, outbox } from '../stores/outbox';
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
  bookmarks: Bookmark[];
  layoutKey: string;
  compact: boolean;
  readOnly: boolean;
}>();

const estimatedHeight = { draft: 78, queued: 60, submitted: 28 } as const;
const flashMs = 1_400;
// Each comment around another sits this much further out, up to the room between lines.
const outlineOutset = { base: 1, step: 2, maxLevel: 3 };
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
const bookmarkRanges = shallowRef(new Map<string, Range>());
const anchorBoxes = shallowRef(new Map<string, { top: number; left: number }>());
// The messages on the page, top to bottom, for putting comments in the order of their text.
const messageOrder = shallowRef<string[]>([]);
const heights = reactive(new Map<string, number>());
const trayIds = shallowRef(new Set<string>());
const outlines = shallowRef<{ comment: Comment; path: string }[]>([]);
// The comments of a card the mouse is over, outlined more strongly.
const hoveredIds = ref(new Set<string>());
// On a phone, comments open in the text right after what they quote, with a tap on it or when
// written, and stay open until closed.
interface OpenedPlace {
  key: string;
  messageId: string;
  anchor: TextAnchor;
  ids: Set<string>;
  mount: HTMLElement;
  actionsMount: HTMLElement;
  editorMount: HTMLElement;
  cardsMount: HTMLElement;
}
const openedPlaces = shallowRef<OpenedPlace[]>([]);
// The opened place a picked block's buttons sit in, between its text and the cards.
const actionsPlaceKey = ref<string | null>(null);
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
// A selection or block that overlaps a bookmark offers to remove it instead of adding another.
const overlappedBookmark = computed(() => {
  const current = actions.value;
  if (!current) return null;
  const { startOffset, endOffset } = current.anchor;
  return (
    props.bookmarks.find(
      (bookmark) =>
        bookmark.messageId === current.messageId &&
        bookmark.startOffset < endOffset &&
        startOffset < bookmark.endOffset,
    ) ?? null
  );
});
const playable = computed(() => picked.value?.speakable === true);
const actionsPlace = computed(() =>
  picked.value
    ? openedPlaces.value.find((place) => place.key === actionsPlaceKey.value)
    : undefined,
);
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
  placeKey: string | null;
} | null>(null);
const editorPlace = computed(() =>
  openedPlaces.value.find((place) => place.key === editor.value?.placeKey),
);
// Sent comments a link from Claude's answer showed, until closed.
const revealedIds = ref(new Set<string>());
// The comment open in the editor shows there, not also as a card. A sent comment shows in the
// reply it went with, and its fork as a link under the message, so it needs no card; a saved note
// keeps its card, which is the way to the note.
const shownComments = computed(() =>
  props.comments.filter(
    (comment) =>
      comment.id !== editor.value?.commentId &&
      (comment.status !== 'submitted' ||
        comment.type === 'note' ||
        revealedIds.value.has(comment.id)),
  ),
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

function locateAll(root: HTMLElement, items: (TextAnchor & { id: string; messageId: string })[]) {
  const ranges = new Map<string, Range>();
  for (const item of items) {
    const anchorRoot = root.querySelector<HTMLElement>(`[data-anchor-root="${item.messageId}"]`);
    const range = anchorRoot && locateAnchor(anchorRoot, item);
    if (range) ranges.set(item.id, range);
  }
  return ranges;
}

function reanchor() {
  const root = container();
  if (!root) return;
  if (props.compact) restorePlaces(root);
  else closeAllPlaces();
  anchors.value = locateAll(root, props.comments);
  bookmarkRanges.value = locateAll(root, props.bookmarks);
  messageOrder.value = [...root.querySelectorAll<HTMLElement>('[data-anchor-root]')].flatMap(
    (element) => element.dataset.anchorRoot ?? [],
  );
  paintHighlights();
  measure();
}

function measure() {
  if (!layer.value) return;
  layerWidth.value = layer.value.clientWidth;
  for (const place of openedPlaces.value) fitToMessageWidth(place.mount);
  const boxes = new Map<string, { top: number; left: number }>();
  for (const [id, range] of anchors.value) boxes.set(id, relative(firstLineRect(range)));
  anchorBoxes.value = boxes;
  measureOutlines();
  updateTray();
}

function measureOutlines() {
  const quoted = props.comments.filter((comment) => {
    const range = anchors.value.get(comment.id);
    return range && !range.collapsed;
  });
  const levels = nestingLevels(quoted);
  const openedBoxes = openedPlaces.value.map((place) => place.mount.getBoundingClientRect());
  const insideOpened = (rect: DOMRect) =>
    openedBoxes.some((box) => rect.top >= box.top && rect.bottom <= box.bottom);
  outlines.value = quoted.map((comment) => {
    const rects = [...anchors.value.get(comment.id)!.getClientRects()];
    const level = Math.min(levels.get(comment.id)!, outlineOutset.maxLevel);
    return {
      comment,
      path: outlinePath(
        lineBoxes(rects.filter((rect) => !insideOpened(rect)).map(relative)),
        outlineOutset.base + outlineOutset.step * level,
      ),
    };
  });
}

const outlineKind = (comment: Comment) => (comment.forkGroupId ? 'fork' : comment.type);
const hover = (comments: Comment[]) =>
  (hoveredIds.value = new Set(comments.map((comment) => comment.id)));

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
  CSS.highlights.set('bookmark', new Highlight(...bookmarkRanges.value.values()));
}

function flash(range: Range) {
  if (!('highlights' in CSS)) return;
  CSS.highlights.set('comment-flash', new Highlight(range));
  setTimeout(() => CSS.highlights.delete('comment-flash'), flashMs);
}

function scrollToComment(commentId: string) {
  const range = anchors.value.get(commentId);
  return range ? scrollToRange(range) : false;
}

function scrollToRange(range: Range) {
  const header = document.querySelector('[data-sticky-header]');
  const headerHeight = header ? header.getBoundingClientRect().height : 0;
  const top = firstLineRect(range).top + window.scrollY - headerHeight - 140;
  window.scrollTo({ top, behavior: 'smooth' });
  if (!range.collapsed) flash(range);
  return true;
}

// A comment on its own, or the comments of a fork group in text order. A group shows as one card
// at the place of its first comment.
function cardEntriesOf(comments: Comment[]) {
  const entries = new Map<string, Comment[]>();
  for (const comment of inTextOrder(comments, messageOrder.value)) {
    const key = comment.forkGroupId ?? comment.id;
    entries.set(key, [...(entries.get(key) ?? []), comment]);
  }
  return [...entries.values()].map((group) => ({ first: group[0]!, comments: group }));
}

const cardEntries = computed(() => cardEntriesOf(shownComments.value));

// Sent comments open too, as the way from the text to what was asked. A fork group opens whole.
function placeEntries(place: OpenedPlace) {
  const groups = new Set(
    props.comments.flatMap((comment) =>
      place.ids.has(comment.id) && comment.forkGroupId ? [comment.forkGroupId] : [],
    ),
  );
  return cardEntriesOf(
    props.comments.filter(
      (comment) =>
        comment.id !== editor.value?.commentId &&
        (place.ids.has(comment.id) ||
          (comment.forkGroupId !== null && groups.has(comment.forkGroupId))),
    ),
  );
}

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

// On a phone only general comments are listed under their message; the others open with a tap on
// the text they quote.
const listedComments = computed(() => {
  if (!props.compact) return [];
  const byMessage = new Map<string, (typeof cardEntries.value)[number][]>();
  for (const entry of cardEntries.value.filter(({ first }) => !first.quote)) {
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
  const buttonCount = props.readOnly ? 1 : 2;
  const width =
    buttonCount * (coarsePointer.value ? actionButtonWidth.touch : actionButtonWidth.mouse);
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
  const buttonCount = 1 + (props.readOnly ? 0 : 2) + (speakable ? 1 : 0);
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
// On a phone the same tap also opens the comments on the tapped text.
async function onClick(event: MouseEvent) {
  const target = event.target;
  if (!(target instanceof Element) || editor.value) return;
  const ignored = `[${insertedAttribute}], .answer-tags, button, a, input, textarea, select, label`;
  if (target.closest(ignored)) return;
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
  if (!root || !block || !element || alreadyPicked) return;
  if (props.compact) {
    actionsPlaceKey.value = openCommentsAt(event.clientX, event.clientY)?.key ?? null;
    await nextTick();
  }
  pick(root, element, blocks.indexOf(block));
}

function caretAt(x: number, y: number) {
  const position = document.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = document.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

function openCommentsAt(x: number, y: number) {
  const caret = caretAt(x, y);
  if (!caret) return null;
  const hits = props.comments.flatMap((comment) => {
    const range = anchors.value.get(comment.id);
    return range && !range.collapsed && range.isPointInRange(caret.node, caret.offset)
      ? [{ comment, range }]
      : [];
  });
  const smallest = hits.sort(
    (first, second) => first.range.toString().length - second.range.toString().length,
  )[0];
  if (!smallest) return null;
  const shown = (id: string) => openedPlaces.value.some((place) => place.ids.has(id));
  if (shown(smallest.comment.id)) {
    return openedPlaces.value.find((place) => place.ids.has(smallest.comment.id)) ?? null;
  }
  const ids = hits.flatMap(({ comment }) => (shown(comment.id) ? [] : [comment.id]));
  return openPlace(smallest.comment.messageId, smallest.comment, smallest.range, ids);
}

function openPlace(messageId: string, anchor: TextAnchor, range: Range, ids: string[]) {
  const mount = document.createElement('span');
  mount.setAttribute(insertedAttribute, '');
  mount.className = 'opened-comments';
  const [actionsMount, editorMount, cardsMount] = [0, 1, 2].map(() =>
    document.createElement('span'),
  ) as [HTMLElement, HTMLElement, HTMLElement];
  mount.append(actionsMount, editorMount, cardsMount);
  insertAfterRange(range, mount);
  fitToMessageWidth(mount);
  const { quote, startOffset, endOffset } = anchor;
  const place: OpenedPlace = {
    key: newId(),
    messageId,
    anchor: { quote, startOffset, endOffset },
    ids: new Set(ids),
    mount,
    actionsMount,
    editorMount,
    cardsMount,
  };
  openedPlaces.value = [...openedPlaces.value, place];
  return place;
}

// A message that renders again drops what was inserted into it, so open places go back in.
function restorePlaces(root: HTMLElement) {
  const lost = openedPlaces.value.filter((place) => {
    if (place.mount.isConnected) return false;
    const anchorRoot = root.querySelector<HTMLElement>(`[data-anchor-root="${place.messageId}"]`);
    const range = anchorRoot && locateAnchor(anchorRoot, place.anchor);
    if (!range) return true;
    insertAfterRange(range, place.mount);
    return false;
  });
  for (const place of lost) closePlace(place);
}

// Cards inside a list item or a quote span the whole message, not only the indented text.
function fitToMessageWidth(mount: HTMLElement) {
  const root = mount.closest<HTMLElement>('[data-anchor-root]');
  if (!root) return;
  mount.style.marginLeft = '';
  mount.style.width = '';
  const indent = mount.getBoundingClientRect().left - root.getBoundingClientRect().left;
  mount.style.marginLeft = `${-indent}px`;
  mount.style.width = `${root.clientWidth}px`;
}

// After the quote, outside any link or bold text around its end; after a code block or table
// as a whole, since a card cannot sit inside them.
function insertAfterRange(range: Range, mount: HTMLElement) {
  const end = range.endContainer;
  const element = end instanceof Element ? end : end.parentElement!;
  const root = element.closest('[data-anchor-root]')!;
  const whole = element.closest('pre, table');
  if (whole && root.contains(whole)) return whole.after(mount);
  const block =
    element.closest('p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, th, td') ?? root;
  let outermostInline: Element | null = null;
  for (
    let inline: Element | null = element;
    inline && inline !== block;
    inline = inline.parentElement
  ) {
    outermostInline = inline;
  }
  if (outermostInline) return outermostInline.after(mount);
  const point = document.createRange();
  point.setStart(end, range.endOffset);
  point.insertNode(mount);
}

function closePlace(place: OpenedPlace) {
  if (actionsPlaceKey.value === place.key) {
    unpick();
    actionsPlaceKey.value = null;
  }
  if (editor.value?.placeKey === place.key) editor.value.placeKey = null;
  openedPlaces.value = openedPlaces.value.filter((opened) => opened !== place);
  place.mount.remove();
}

function closeAllPlaces() {
  for (const place of openedPlaces.value) closePlace(place);
}

function setPlaceIds(place: OpenedPlace, ids: Set<string>) {
  if (ids.size === 0 && editor.value?.placeKey !== place.key) {
    closePlace(place);
    return;
  }
  openedPlaces.value = openedPlaces.value.map((opened) =>
    opened === place ? { ...place, ids } : opened,
  );
}

// A link to a comment shows it: on a phone opened in the text, elsewhere as its card even when
// sent.
function reveal(commentId: string, range: Range) {
  const comment = props.comments.find(({ id }) => id === commentId);
  if (!comment || range.collapsed) return;
  if (!props.compact) {
    if (!shownComments.value.includes(comment)) {
      revealedIds.value = new Set([...revealedIds.value, commentId]);
    }
    return;
  }
  if (openedPlaces.value.some((place) => place.ids.has(commentId))) return;
  openPlace(comment.messageId, comment, range, [commentId]);
}

function hideRevealed(comments: Comment[]) {
  const hidden = new Set(comments.map((comment) => comment.id));
  revealedIds.value = new Set([...revealedIds.value].filter((id) => !hidden.has(id)));
}

function closeCards(place: OpenedPlace, comments: Comment[]) {
  const closed = new Set(comments.map((comment) => comment.id));
  setPlaceIds(place, new Set([...place.ids].filter((id) => !closed.has(id))));
  measure();
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

// On a phone the editor opens in the text after the quote, where the saved comment then shows.
function openEditor() {
  if (!actions.value) return;
  const { messageId, anchor, lineTop } = actions.value;
  const anchorRoot = container()?.querySelector<HTMLElement>(`[data-anchor-root="${messageId}"]`);
  const range = props.compact && anchorRoot ? locateAnchor(anchorRoot, anchor) : null;
  const place = range ? openPlace(messageId, anchor, range, []) : null;
  editor.value = {
    messageId,
    anchor,
    top: lineTop,
    left: railLeft.value,
    commentId: null,
    placeKey: place?.key ?? null,
  };
  selection.value = null;
  picked.value = null;
}

function toggleBookmark() {
  const current = actions.value;
  if (!current) return;
  const bookmark = overlappedBookmark.value;
  if (bookmark) {
    outbox.add({
      type: 'bookmark.delete',
      explorationId: props.explorationId,
      bookmarkId: bookmark.id,
    });
  } else {
    outbox.add({
      type: 'bookmark.create',
      explorationId: props.explorationId,
      bookmark: {
        id: newId(),
        forkId: props.forkId,
        messageId: current.messageId,
        ...current.anchor,
      },
    });
  }
  selection.value = null;
  unpick();
  window.getSelection()?.removeAllRanges();
}

function closeEditor(savedCommentId: string | null) {
  const place = editorPlace.value;
  editor.value = null;
  highlightPicked(null);
  window.getSelection()?.removeAllRanges();
  if (place)
    setPlaceIds(place, new Set([...place.ids, ...(savedCommentId ? [savedCommentId] : [])]));
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
  closeAllPlaces();
  resizeObserver?.disconnect();
  if ('highlights' in CSS) CSS.highlights.clear();
});

watch(() => [props.comments, props.bookmarks, props.layoutKey, props.compact], reanchor, {
  flush: 'post',
});
watch(() => pointer.frame, updateTray);

let handledHash = '';
watch(
  [() => route.hash, anchors, bookmarkRanges],
  ([hash]) => {
    if (hash === handledHash) return;
    const ranges = hash.startsWith('#c-')
      ? anchors.value
      : hash.startsWith('#b-')
        ? bookmarkRanges.value
        : null;
    const range = ranges?.get(hash.slice(3));
    if (!range) return;
    if (hash.startsWith('#c-')) reveal(hash.slice(3), range);
    scrollToRange(range);
    handledHash = hash;
    // So the same link scrolls there again the next time.
    void router.replace({ hash: '' }).then(() => (handledHash = ''));
  },
  { flush: 'post' },
);
</script>

<template>
  <div ref="layer" class="comment-layer">
    <svg class="comment-outlines" aria-hidden="true">
      <path
        v-for="outline in outlines"
        :key="outline.comment.id"
        :d="outline.path"
        :class="[
          outlineKind(outline.comment),
          outline.comment.status,
          { hovered: hoveredIds.has(outline.comment.id) },
        ]"
      />
    </svg>

    <Teleport to="#comment-tray" defer>
      <CommentTray :comments="trayComments" @jump="scrollToComment" />
    </Teleport>

    <template v-for="card in floatingCards" :key="card.id">
      <ForkGroupCard
        v-if="card.first.forkGroupId"
        :comments="card.comments"
        :placement="card"
        :closable="card.comments.some(({ id }) => revealedIds.has(id))"
        @measure="(height) => heights.set(card.id, height)"
        @open="openSubmitted"
        @close="hideRevealed(card.comments)"
        @jump="(comment) => scrollToComment(comment.id)"
        @mouseenter="hover(card.comments)"
        @mouseleave="hover([])"
      />
      <CommentCard
        v-else
        :comment="card.first"
        :placement="card"
        :closable="revealedIds.has(card.first.id)"
        @measure="(height) => heights.set(card.id, height)"
        @open="openSubmitted"
        @close="hideRevealed(card.comments)"
        @mouseenter="hover(card.comments)"
        @mouseleave="hover([])"
      />
    </template>

    <Teleport v-for="place in openedPlaces" :key="place.key" :to="place.cardsMount">
      <template v-for="entry in placeEntries(place)" :key="entry.first.id">
        <ForkGroupCard
          v-if="entry.first.forkGroupId"
          :comments="entry.comments"
          closable
          @open="openSubmitted"
          @close="closeCards(place, entry.comments)"
        />
        <CommentCard
          v-else
          :comment="entry.first"
          closable
          @open="openSubmitted"
          @close="closeCards(place, entry.comments)"
        />
      </template>
    </Teleport>

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

    <Teleport :to="actionsPlace?.actionsMount" :disabled="!actionsPlace">
      <div
        v-if="actions && (commentable || playable)"
        class="selection-actions"
        :class="{ 'in-opened': actionsPlace }"
        :style="
          actionsPlace
            ? undefined
            : { top: `${actions.buttonTop}px`, left: `${actions.buttonLeft}px` }
        "
      >
        <button
          v-if="commentable"
          type="button"
          class="comment-button"
          :aria-label="overlappedBookmark ? 'Remove bookmark' : 'Bookmark'"
          :title="overlappedBookmark ? 'Remove bookmark' : 'Bookmark this'"
          @pointerdown.prevent
          @mousedown.prevent
          @touchstart.prevent
          @pointerup="toggleBookmark"
          @click="toggleBookmark"
        >
          <MediaIcon :name="overlappedBookmark ? 'bookmarked' : 'bookmark'" />
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
      </div>
    </Teleport>

    <Teleport :to="editorPlace?.editorMount" :disabled="!editorPlace">
      <CommentEditor
        v-if="editor"
        :exploration-id="explorationId"
        :view-fork-id="forkId"
        :message-id="editor.messageId"
        :anchor="editor.anchor"
        :top="editor.top"
        :left="editor.left"
        :width="draftCardWidth"
        :in-rail="!editorPlace"
        @created="(commentId) => editor && (editor.commentId = commentId)"
        @close="closeEditor"
      />
    </Teleport>
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

.comment-layer > .comment-outlines {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}

.comment-outlines path {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.5;
  stroke-linejoin: round;
}

.comment-outlines .fork {
  stroke: var(--fork);
}

.comment-outlines .note {
  stroke: var(--note);
}

.comment-outlines .inline {
  stroke-dasharray: 4 3;
}

.comment-outlines .submitted {
  stroke: var(--text-muted);
  stroke-width: 1;
}

.comment-outlines .hovered {
  stroke-width: 2.5;
}

.selection-actions {
  position: absolute;
  z-index: 4;
  display: flex;
  gap: 0.4rem;
}

.selection-actions.in-opened {
  position: static;
  justify-content: flex-end;
  margin-bottom: 0.5rem;
}

.comment-button {
  display: inline-grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
}

.selection-actions:not(.in-opened) .comment-button {
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
