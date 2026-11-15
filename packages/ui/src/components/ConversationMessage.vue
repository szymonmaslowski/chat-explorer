<script setup lang="ts">
import type { AnsweredPartLookup } from '@shared/answer-tags';
import type { Comment, Message, MessageFile } from '@shared/types';
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { withoutTagLines } from '@shared/answer-tags';
import { renderMarkdown } from '@shared/markdown';
import { useCopied } from '../composables/useCopied';
import { fileIdOfImage, useImageViewer } from '../composables/useImageViewer';
import { commentLink } from '../lib/conversation';
import { formatDateTime } from '../lib/date-time';
import { isUnread } from '../lib/read-state';
import { bringToReadingLine, scrollToEdge } from '../lib/reading-line';
import { speechBlocks, type SpokenElement } from '../lib/speech-blocks';
import { checkSpeechAvailable, playBlock, playFrom, speech, togglePause } from '../stores/speech';
import ConfirmButton from './ConfirmButton.vue';
import FileLinks from './FileLinks.vue';
import MediaIcon from './MediaIcon.vue';

const props = defineProps<{
  message: Message;
  quotedComments: readonly Comment[];
  files: readonly MessageFile[];
  shared: boolean;
  isNew: boolean;
  answeredPart: AnsweredPartLookup;
  forkable: boolean;
  splittable: boolean;
  // Counted back from the fork's newest answer, which is 0; null for the user's messages.
  answerIndex: number | null;
}>();
const emit = defineEmits<{
  markUnread: [];
  markRead: [];
  fork: [];
  split: [];
  rendered: [];
}>();

const html = computed(() =>
  props.message.content ? renderMarkdown(props.message.content, props.answeredPart) : '',
);
// A file the text already shows, such as a screenshot in an answer, is not listed again below.
const listedFiles = computed(() =>
  props.files.filter((file) => !props.message.content.includes(`/api/files/${file.id}`)),
);

const content = ref<HTMLElement | null>(null);
const article = ref<HTMLElement | null>(null);
const jumpable = computed(() => props.message.role === 'assistant' && props.message.content !== '');
const jumpTo = (edge: 'start' | 'end') => article.value && scrollToEdge(article.value, edge);
const blocks = shallowRef<SpokenElement[]>([]);
const speakable = computed(
  () => speech.available && props.message.role === 'assistant' && blocks.value.length > 0,
);
const currentIndex = computed(() =>
  speech.playback?.id === props.message.id ? speech.playback.index : -1,
);
const listenLabel = computed(() =>
  currentIndex.value === -1 ? 'Read aloud' : speech.playing ? 'Pause' : 'Resume',
);

void checkSpeechAvailable();

const { copied, copy } = useCopied();
// The cards of what an answer part answers are left out: they only make sense beside the chat.
const copyMessage = () => {
  const content = withoutTagLines(props.message.content);
  return copy({ plain: content, html: renderMarkdown(content) });
};

const imageViewer = useImageViewer();
const router = useRouter();
const route = useRoute();

// The user's messages start collapsed: what they sent shows as comments in the chat, and the
// message is there to see what went to Claude as a whole.
const collapsible = computed(() => props.message.role === 'user');
const expanded = ref(false);
const opened = computed(() => !collapsible.value || expanded.value);
watch(
  () => route.hash,
  (hash) => {
    if (hash === `#m-${props.message.id}`) expanded.value = true;
  },
  { immediate: true },
);

const { copied: linkCopied, copy: copyText } = useCopied();
const copyLink = () => copyText({ plain: `${location.origin}${route.path}#m-${props.message.id}` });

function openContentImage(event: MouseEvent) {
  if (!(event.target instanceof HTMLImageElement)) return;
  const fileId = fileIdOfImage(event.target.src);
  if (fileId) imageViewer.open(fileId);
}

function openAnsweredComment(event: MouseEvent) {
  if (!(event.target instanceof HTMLAnchorElement) || !event.target.matches('.answer-jump')) return;
  event.preventDefault();
  void router.push(event.target.getAttribute('href')!);
}

const { copied: cardCopied, copy: copyCardText } = useCopied();
let copiedCardButton: HTMLElement | null = null;
watch(cardCopied, (copied) => copiedCardButton?.classList.toggle('copied', copied));

function copyCard(button: HTMLElement, card: HTMLElement) {
  copiedCardButton?.classList.remove('copied');
  copiedCardButton = button;
  void copyCardText({ plain: card.dataset.text ?? '' });
}

function playCard(card: HTMLElement) {
  const index = blocks.value.findIndex(({ element }) => element === card);
  if (index === -1) return;
  playBlock(
    { messageId: props.message.id },
    blocks.value.map(({ block }) => block),
    index,
  );
}

function onCardAction(event: MouseEvent) {
  if (!(event.target instanceof HTMLButtonElement)) return;
  const card = event.target.closest<HTMLElement>('.answer-card');
  if (!card) return;
  if (event.target.matches('.answer-copy')) copyCard(event.target, card);
  else if (event.target.matches('.answer-play')) playCard(card);
}

function onContentClick(event: MouseEvent) {
  openContentImage(event);
  openAnsweredComment(event);
  onCardAction(event);
}

function findBlocks() {
  blocks.value =
    content.value && props.message.role === 'assistant' ? speechBlocks(content.value) : [];
}

function playMessage() {
  if (currentIndex.value !== -1) {
    togglePause();
    return;
  }
  playFrom(
    { messageId: props.message.id },
    blocks.value.map(({ block }) => block),
    0,
  );
}

// New text drops the comments opened inside the old one, so the comment layer places them again.
watch(
  html,
  () => {
    findBlocks();
    emit('rendered');
  },
  { flush: 'post' },
);

watch(
  [currentIndex, blocks],
  ([index], [previousIndex]) => {
    for (const [position, { element }] of blocks.value.entries()) {
      element.classList.toggle('speaking', position === index);
    }
    const current = blocks.value[index];
    if (current && index !== previousIndex) bringToReadingLine(current.element);
  },
  { flush: 'post' },
);

onMounted(findBlocks);
</script>

<template>
  <article
    ref="article"
    :id="`m-${message.id}`"
    class="message"
    :class="[message.role, { shared, new: isNew }]"
    :data-message-id="message.id"
    :data-unread="isUnread(message) || undefined"
  >
    <header class="role">
      {{ message.role === 'user' ? 'You' : 'Claude' }}
      <span v-if="answerIndex !== null" class="answer-index">[{{ answerIndex }}]</span>
      <time class="time" :datetime="new Date(message.createdAt).toISOString()">
        {{ formatDateTime(message.createdAt) }}
      </time>
      <span v-if="isNew" class="new-label">New</span>
      <span class="header-actions">
        <button
          v-if="collapsible"
          type="button"
          class="icon-button header-button collapse-toggle"
          :aria-expanded="expanded"
          :aria-label="expanded ? 'Hide the message' : 'Show the message'"
          :title="expanded ? 'Hide the message' : 'Show the whole message sent to Claude'"
          @click="expanded = !expanded"
        >
          <MediaIcon name="chevron-up" />
        </button>
        <ConfirmButton
          v-if="splittable"
          label="Move from here into a new fork"
          class="icon-button header-button"
          title="Move this message and the ones after it into a new fork"
          @confirm="emit('split')"
        >
          <MediaIcon name="split" /><span class="visually-hidden"
            >Move from here into a new fork</span
          >
        </ConfirmButton>
        <button
          v-if="!jumpable"
          type="button"
          class="icon-button header-button"
          :aria-label="linkCopied ? 'Link copied' : 'Copy a link to this message'"
          title="Copy a link that opens this fork at this message"
          @click="copyLink"
        >
          <MediaIcon :name="linkCopied ? 'check' : 'chain'" />
        </button>
      </span>
    </header>
    <div v-if="jumpable" class="message-actions">
      <button
        v-if="forkable"
        type="button"
        class="icon-button"
        aria-label="Fork from here"
        title="Start a fork that goes on from this answer"
        @click="emit('fork')"
      >
        <MediaIcon name="fork" />
      </button>
      <button
        type="button"
        class="icon-button"
        :aria-label="copied ? 'Copied' : 'Copy the answer'"
        title="Copy the whole answer"
        @click="copyMessage"
      >
        <MediaIcon :name="copied ? 'check' : 'copy'" />
      </button>
      <button
        type="button"
        class="icon-button"
        aria-label="Go to the end of the answer"
        title="Go to the end of the answer"
        @click="jumpTo('end')"
      >
        <MediaIcon name="to-end" />
      </button>
      <button
        type="button"
        class="icon-button"
        :aria-label="linkCopied ? 'Link copied' : 'Copy a link to this message'"
        title="Copy a link that opens this fork at this message"
        @click="copyLink"
      >
        <MediaIcon :name="linkCopied ? 'check' : 'chain'" />
      </button>
      <button
        v-if="speakable"
        type="button"
        class="icon-button"
        :aria-label="listenLabel"
        :title="listenLabel"
        @click="playMessage"
      >
        <MediaIcon :name="currentIndex !== -1 && speech.playing ? 'pause' : 'play'" />
      </button>
      <button
        v-if="!isUnread(message)"
        type="button"
        class="icon-button"
        aria-label="Mark unread from here"
        title="Mark this answer and the later ones unread"
        @click="emit('markUnread')"
      >
        <MediaIcon name="unread" />
      </button>
      <button
        v-else
        type="button"
        class="icon-button"
        aria-label="Mark read up to here"
        title="Mark this answer and the earlier ones read"
        @click="emit('markRead')"
      >
        <MediaIcon name="read" />
      </button>
    </div>
    <template v-if="opened">
      <div v-for="comment in quotedComments" :key="comment.id" class="quoted-comment">
        <RouterLink
          v-if="comment.quote"
          :to="commentLink(comment)"
          class="quote-link"
          title="Show where this was commented"
        >
          <blockquote>{{ comment.quote }}</blockquote>
        </RouterLink>
        <p>{{ comment.body }}</p>
      </div>
      <FileLinks :files="listedFiles" />
      <div
        v-if="html"
        ref="content"
        class="content"
        :data-anchor-root="message.id"
        :data-speakable="speakable || undefined"
        @click="onContentClick"
        v-html="html"
      />
    </template>
    <footer v-if="jumpable" class="message-end">
      <button
        type="button"
        class="listen"
        aria-label="Go to the start of the answer"
        title="Go to the start of the answer"
        @click="jumpTo('start')"
      >
        <MediaIcon name="to-start" />
      </button>
    </footer>
  </article>
</template>

<style scoped>
.message {
  padding: 0.25rem 0 1rem;
}

.message.user {
  background: var(--surface-muted);
  border-radius: var(--radius);
  padding: 0.6rem 1rem;
  margin: 1rem 0;
}

.message.shared {
  opacity: 0.6;
}

/* Pulled into the gutter so the text does not move when the mark goes. */
.message.new {
  margin-left: -0.75rem;
  padding-left: calc(0.75rem - 3px);
  border-left: 3px solid var(--accent);
}

.new-label {
  color: var(--accent);
}

.role {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}

.header-button {
  color: var(--text-muted);
  font-weight: 400;
  text-transform: none;
  letter-spacing: normal;
}

.collapse-toggle[aria-expanded='false'] :deep(svg) {
  transform: rotate(180deg);
}

.header-actions {
  display: flex;
  gap: 0.4rem;
  margin-left: auto;
}

.answer-index,
.time {
  font-weight: 400;
  text-transform: none;
  letter-spacing: normal;
  font-variant-numeric: tabular-nums;
}

.message-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-top: 0.4rem;
}

.message-end {
  display: flex;
  margin-top: 0.5rem;
}

.quote-link {
  color: inherit;
  text-decoration: none;
}

.quote-link:hover blockquote {
  border-left-color: var(--accent);
}

.quoted-comment p {
  margin: 0.25rem 0 0.75rem;
  white-space: pre-wrap;
}

/* A card's text comes from its attributes, so it is not part of the answer's text: comments
   anchor at the same offsets, and selecting and reading aloud pass it by. */
.content :deep(.answer-tags) {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin: 1.5rem 0 0.6rem;
}

.content :deep(.answer-tags:first-child) {
  margin-top: 0;
}

.content :deep(.answer-card) {
  display: flex;
  flex-direction: column;
  padding: 0.4rem 0.75rem;
  border-top: 3px solid var(--accent);
  border-radius: 0 0 var(--radius) var(--radius);
  background: var(--accent-soft);
  color: var(--text);
  font-size: 0.875rem;
  text-decoration: none;
  user-select: none;
  -webkit-user-select: none;
}

.content :deep(.answer-card[data-quote]::before) {
  content: attr(data-quote);
  display: block;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--text-muted);
  font-style: italic;
}

.content :deep(.answer-card::after) {
  content: attr(data-text);
  display: block;
  white-space: pre-wrap;
}

/* After the card's text, which its ::after shows. */
.content :deep(.answer-card-actions) {
  order: 1;
  display: flex;
  gap: 0.4rem;
  margin-top: 0.3rem;
}

.content :deep(.answer-jump),
.content :deep(.answer-play),
.content :deep(.answer-copy) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.9rem;
  min-height: 1.6rem;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
}

.content :deep(.answer-jump::before),
.content :deep(.answer-play::before),
.content :deep(.answer-copy::before) {
  content: '';
  width: 1rem;
  height: 1rem;
  background: currentColor;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M7 17L17 7M9 7h8v8'/%3E%3C/svg%3E")
    center / contain no-repeat;
}

.content :deep(.answer-play::before) {
  mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M8 5v14l11-7z'/%3E%3C/svg%3E");
}

.content :deep(.answer-card.speaking .answer-play::before) {
  mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M7 5h4v14H7zM13 5h4v14h-4z'/%3E%3C/svg%3E");
}

.content:not([data-speakable]) :deep(.answer-play) {
  display: none;
}

.content :deep(.answer-copy::before) {
  mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1'/%3E%3C/svg%3E");
}

.content :deep(.answer-copy.copied::before) {
  mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 12.5l5 5L20 6.5'/%3E%3C/svg%3E");
}

@media (pointer: coarse) {
  .content :deep(.answer-jump),
  .content :deep(.answer-play),
  .content :deep(.answer-copy) {
    min-width: 2.5rem;
    min-height: 2.5rem;
  }
}

.content :deep(.answer-card.unknown) {
  background: none;
  border-top-color: var(--border);
}

.content :deep(.answer-card.unknown::after) {
  content: attr(data-tag);
  color: var(--text-muted);
}

/* An image in an answer stands apart from the text, with room on both sides. */
.content :deep(img) {
  display: block;
  max-width: calc(100% - 2rem);
  margin: 0.75rem 1rem;
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.content :deep(img[src^='/api/files/']) {
  cursor: zoom-in;
}

.content :deep(p:first-child) {
  margin-top: 0.25rem;
}

.content :deep(p:last-child) {
  margin-bottom: 0;
}
</style>
