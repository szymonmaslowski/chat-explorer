<script setup lang="ts">
import type { Comment, Message } from '@shared/types';
import { computed } from 'vue';
import { renderMarkdown } from '../lib/markdown';

const props = defineProps<{
  message: Message;
  quotedComments: Comment[];
  shared: boolean;
}>();

const html = computed(() => (props.message.content ? renderMarkdown(props.message.content) : ''));
</script>

<template>
  <article
    :id="`m-${message.id}`"
    class="message"
    :class="[message.role, { shared }]"
    :data-message-id="message.id"
  >
    <header class="role">{{ message.role === 'user' ? 'You' : 'Claude' }}</header>
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
    <div v-if="html" class="content" :data-anchor-root="message.id" v-html="html" />
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
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
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
