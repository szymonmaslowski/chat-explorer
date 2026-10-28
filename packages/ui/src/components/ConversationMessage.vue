<script setup lang="ts">
import type { Comment, Message } from '@shared/types';
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { renderMarkdown } from '../lib/markdown';
import { bringToReadingLine } from '../lib/reading-line';
import { speechBlocks, type SpokenElement } from '../lib/speech-blocks';
import { checkSpeechAvailable, playFrom, speech, togglePause } from '../stores/speech';
import MediaIcon from './MediaIcon.vue';

const props = defineProps<{
  message: Message;
  quotedComments: Comment[];
  shared: boolean;
}>();

const html = computed(() => (props.message.content ? renderMarkdown(props.message.content) : ''));

const article = ref<HTMLElement | null>(null);
const content = ref<HTMLElement | null>(null);
const blocks = shallowRef<SpokenElement[]>([]);
const blockCentres = ref<number[]>([]);
const speakable = computed(
  () => speech.available && props.message.role === 'assistant' && blocks.value.length > 0,
);
const currentIndex = computed(() =>
  speech.playback?.messageId === props.message.id ? speech.playback.index : -1,
);

void checkSpeechAvailable();

// Each block's button sits in the margin, level with the middle of the block's first line.
function measure() {
  if (!article.value) return;
  const articleTop = article.value.getBoundingClientRect().top;
  blockCentres.value = blocks.value.map(({ element }) => {
    const style = getComputedStyle(element);
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
    const top = element.getBoundingClientRect().top - articleTop;
    return top + parseFloat(style.paddingTop) + lineHeight / 2;
  });
}

function findBlocks() {
  blocks.value =
    content.value && props.message.role === 'assistant' ? speechBlocks(content.value) : [];
  measure();
}

function play(index: number) {
  if (index === currentIndex.value) {
    togglePause();
    return;
  }
  playFrom(
    props.message.id,
    blocks.value.map(({ block }) => block),
    index,
  );
}

function playMessage() {
  if (currentIndex.value === -1) play(0);
  else togglePause();
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

let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
  findBlocks();
  resizeObserver = new ResizeObserver(measure);
  if (article.value) resizeObserver.observe(article.value);
});
onBeforeUnmount(() => resizeObserver?.disconnect());
</script>

<template>
  <article
    :id="`m-${message.id}`"
    ref="article"
    class="message"
    :class="[message.role, { shared, speakable }]"
    :data-message-id="message.id"
  >
    <header class="role">
      {{ message.role === 'user' ? 'You' : 'Claude' }}
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
    <div v-if="html" ref="content" class="content" :data-anchor-root="message.id" v-html="html" />
    <template v-if="speakable">
      <button
        v-for="(centre, index) in blockCentres"
        :key="index"
        type="button"
        class="block-play"
        :class="{ current: index === currentIndex }"
        :style="{ top: `${centre}px` }"
        :aria-label="
          index === currentIndex && speech.playing ? 'Pause' : `Read aloud from block ${index + 1}`
        "
        @click="play(index)"
      >
        <MediaIcon :name="index === currentIndex && speech.playing ? 'pause' : 'play'" />
      </button>
    </template>
  </article>
</template>

<style scoped>
.message {
  padding: 0.25rem 0 1rem;
}

.message.speakable {
  position: relative;
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

.block-play {
  position: absolute;
  left: -2.1rem;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  width: 1.5rem;
  height: 1.5rem;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-muted);
  opacity: 0.55;
}

.block-play:hover,
.block-play.current {
  opacity: 1;
  color: var(--accent);
}

.block-play.current {
  background: var(--accent-soft);
}

.block-play :deep(svg) {
  width: 0.85rem;
  height: 0.85rem;
}

/* No margin outside the column on a narrow screen, so the buttons get one inside it. */
@media (max-width: 860px) {
  .message.speakable {
    padding-left: 1.9rem;
  }

  .block-play {
    left: 0;
  }
}

@media (pointer: coarse) {
  .block-play {
    width: 1.75rem;
    height: 1.75rem;
    min-width: 0;
    min-height: 0;
  }

  .block-play :deep(svg) {
    width: 1rem;
    height: 1rem;
  }
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

.content :deep(p:first-child) {
  margin-top: 0.25rem;
}

.content :deep(p:last-child) {
  margin-bottom: 0;
}
</style>
