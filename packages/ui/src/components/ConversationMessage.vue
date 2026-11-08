<script setup lang="ts">
import type { AnsweredPartLookup } from '@shared/answer-tags';
import type { Comment, Message, MessageFile } from '@shared/types';
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import { useRouter } from 'vue-router';
import { withoutTagLines } from '@shared/answer-tags';
import { renderMarkdown } from '@shared/markdown';
import { useCopied } from '../composables/useCopied';
import { fileIdOfImage, useImageViewer } from '../composables/useImageViewer';
import { commentLink } from '../lib/conversation';
import { formatDateTime } from '../lib/date-time';
import { isUnread } from '../lib/read-state';
import { bringToReadingLine, scrollToEdge } from '../lib/reading-line';
import { speechBlocks, type SpokenElement } from '../lib/speech-blocks';
import { checkSpeechAvailable, playFrom, speech, togglePause } from '../stores/speech';
import FileIcon from './FileIcon.vue';
import MediaIcon from './MediaIcon.vue';

const props = defineProps<{
  message: Message;
  quotedComments: Comment[];
  files: MessageFile[];
  shared: boolean;
  isNew: boolean;
  answeredPart: AnsweredPartLookup;
  forkable: boolean;
}>();
const emit = defineEmits<{ markUnread: []; fork: [] }>();

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

function openImage(event: MouseEvent, file: MessageFile) {
  if (file.kind !== 'image') return;
  event.preventDefault();
  imageViewer.open(file.id);
}

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

function onContentClick(event: MouseEvent) {
  openContentImage(event);
  openAnsweredComment(event);
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

watch(html, findBlocks, { flush: 'post' });

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
      <time class="time" :datetime="new Date(message.createdAt).toISOString()">
        {{ formatDateTime(message.createdAt) }}
      </time>
      <span v-if="isNew" class="new-label">New</span>
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
        type="button"
        class="icon-button"
        aria-label="Go to the end of the answer"
        title="Go to the end of the answer"
        @click="jumpTo('end')"
      >
        <MediaIcon name="to-end" />
      </button>
    </div>
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
    <div v-if="listedFiles.length" class="files">
      <a
        v-for="file in listedFiles"
        :key="file.id"
        :href="`/api/files/${file.id}`"
        target="_blank"
        rel="noopener"
        :class="file.kind"
        :title="file.name"
        @click="openImage($event, file)"
      >
        <img v-if="file.kind === 'image'" :src="`/api/files/${file.id}`" :alt="file.name" />
        <template v-else>
          <FileIcon />
          <span class="name">{{ file.name }}</span>
        </template>
      </a>
    </div>
    <div
      v-if="html"
      ref="content"
      class="content"
      :data-anchor-root="message.id"
      :data-speakable="speakable || undefined"
      @click="onContentClick"
      v-html="html"
    />
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

.files {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 0.4rem 0;
}

.files a {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  max-width: 100%;
  color: inherit;
  text-decoration: none;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.files a:not(.image) {
  padding: 0.3rem 0.6rem 0.3rem 0.45rem;
  font-size: 0.85rem;
}

.files img {
  display: block;
  max-width: 10rem;
  max-height: 8rem;
  border-radius: var(--radius);
}

.files .name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  border-left: 3px solid var(--accent);
  border-radius: 0 var(--radius) var(--radius) 0;
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
.content :deep(.answer-jump) {
  order: 1;
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.9rem;
  min-height: 1.6rem;
  margin-top: 0.3rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
}

.content :deep(.answer-jump::before) {
  content: '';
  width: 1rem;
  height: 1rem;
  background: currentColor;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M7 17L17 7M9 7h8v8'/%3E%3C/svg%3E")
    center / contain no-repeat;
}

@media (pointer: coarse) {
  .content :deep(.answer-jump) {
    min-width: 2.5rem;
    min-height: 2.5rem;
  }
}

.content :deep(.answer-card.unknown) {
  background: none;
  border-left-color: var(--border);
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
