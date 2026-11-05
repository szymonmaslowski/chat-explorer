<script setup lang="ts">
import type { Comment, Message, MessageFile } from '@shared/types';
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import { renderMarkdown } from '@shared/markdown';
import { useCopied } from '../composables/useCopied';
import { formatDateTime } from '../lib/date-time';
import { bringToReadingLine } from '../lib/reading-line';
import { speechBlocks, type SpokenElement } from '../lib/speech-blocks';
import { checkSpeechAvailable, playFrom, speech, togglePause } from '../stores/speech';
import FileIcon from './FileIcon.vue';
import MediaIcon from './MediaIcon.vue';

const props = defineProps<{
  message: Message;
  quotedComments: Comment[];
  files: MessageFile[];
  shared: boolean;
}>();

const html = computed(() => (props.message.content ? renderMarkdown(props.message.content) : ''));

const content = ref<HTMLElement | null>(null);
const blocks = shallowRef<SpokenElement[]>([]);
const speakable = computed(
  () => speech.available && props.message.role === 'assistant' && blocks.value.length > 0,
);
const currentIndex = computed(() =>
  speech.playback?.id === props.message.id ? speech.playback.index : -1,
);

void checkSpeechAvailable();

const { copied, copy } = useCopied();
const copyMessage = () => copy({ plain: props.message.content, html: html.value });

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
    :id="`m-${message.id}`"
    class="message"
    :class="[message.role, { shared }]"
    :data-message-id="message.id"
  >
    <header class="role">
      {{ message.role === 'user' ? 'You' : 'Claude' }}
      <time class="time" :datetime="new Date(message.createdAt).toISOString()">
        {{ formatDateTime(message.createdAt) }}
      </time>
      <button
        v-if="speakable"
        type="button"
        class="listen"
        :aria-label="currentIndex === -1 ? 'Read aloud' : speech.playing ? 'Pause' : 'Resume'"
        @click="playMessage"
      >
        <MediaIcon :name="currentIndex !== -1 && speech.playing ? 'pause' : 'play'" />
        Listen
      </button>
      <button
        v-if="message.role === 'assistant' && message.content"
        type="button"
        class="listen"
        :aria-label="copied ? 'Copied' : 'Copy the answer'"
        title="Copy the whole answer"
        @click="copyMessage"
      >
        <MediaIcon :name="copied ? 'check' : 'copy'" />
        {{ copied ? 'Copied' : 'Copy' }}
      </button>
    </header>
    <div v-for="comment in quotedComments" :key="comment.id" class="quoted-comment">
      <RouterLink
        :to="`/e/${message.explorationId}/f/${comment.viewForkId}#c-${comment.id}`"
        class="quote-link"
        title="Show where this was commented"
      >
        <blockquote>{{ comment.quote }}</blockquote>
      </RouterLink>
      <p>{{ comment.body }}</p>
    </div>
    <div v-if="files.length" class="files">
      <a
        v-for="file in files"
        :key="file.id"
        :href="`/api/files/${file.id}`"
        target="_blank"
        rel="noopener"
        :class="file.kind"
        :title="file.name"
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
      v-html="html"
    />
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

.listen {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.1rem 0.5rem;
  font-size: 0.75rem;
  font-weight: 500;
  text-transform: none;
  letter-spacing: normal;
  color: var(--text-muted);
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

/* An image in an answer stands apart from the text, with room on both sides. */
.content :deep(img) {
  display: block;
  max-width: calc(100% - 2rem);
  margin: 0.75rem 1rem;
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.content :deep(p:first-child) {
  margin-top: 0.25rem;
}

.content :deep(p:last-child) {
  margin-bottom: 0;
}
</style>
