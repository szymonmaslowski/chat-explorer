<script setup lang="ts">
import type { Comment, Message } from '@shared/types';
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
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

const content = ref<HTMLElement | null>(null);
const blocks = shallowRef<SpokenElement[]>([]);
const speakable = computed(
  () => speech.available && props.message.role === 'assistant' && blocks.value.length > 0,
);
const currentIndex = computed(() =>
  speech.playback?.messageId === props.message.id ? speech.playback.index : -1,
);

void checkSpeechAvailable();

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
    props.message.id,
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
