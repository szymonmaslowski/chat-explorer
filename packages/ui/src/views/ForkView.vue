<script setup lang="ts">
import { computed } from 'vue';
import ConversationMessage from '../components/ConversationMessage.vue';
import QueuedSubmissionCard from '../components/QueuedSubmissionCard.vue';
import ReplyBar from '../components/ReplyBar.vue';
import SessionStatusBar from '../components/SessionStatusBar.vue';
import { forkPath, forkTitle, mainFork, quotedCommentsOf } from '../lib/conversation';
import { openExploration } from '../stores/exploration';

const props = defineProps<{ explorationId: string; forkId?: string }>();

const state = computed(() => openExploration(props.explorationId));
const fork = computed(() =>
  props.forkId ? (state.value.forks.get(props.forkId) ?? null) : mainFork(state.value.forks),
);
const parentFork = computed(() =>
  fork.value?.parentForkId ? (state.value.forks.get(fork.value.parentForkId) ?? null) : null,
);
const path = computed(() => (fork.value ? forkPath(fork.value, state.value.messages) : []));
const ownStart = computed(() =>
  path.value.findIndex((message) => message.forkId === fork.value?.id),
);
const awaitingAnswer = computed(() => path.value.at(-1)?.role === 'user');
const queuedSubmissions = computed(() =>
  [...state.value.queuedSubmissions.values()].filter(
    (submission) => submission.forkId === fork.value?.id,
  ),
);
const commentCountOf = (submissionId: string) =>
  [...state.value.comments.values()].filter((comment) => comment.submissionId === submissionId)
    .length;
</script>

<template>
  <div class="page fork-view">
    <header class="top">
      <nav class="crumbs">
        <RouterLink to="/">Explorations</RouterLink>
        <span v-if="state.exploration">
          / {{ state.exploration.title || 'Untitled exploration' }}
        </span>
      </nav>
      <SessionStatusBar
        :status="state.sessionStatus"
        :connected="state.connected"
        :exploration-id="explorationId"
      />
    </header>

    <p v-if="state.status === 'loading'" class="muted">Loading…</p>
    <p v-else-if="state.status === 'missing'" class="muted">This exploration does not exist.</p>
    <p v-else-if="state.status === 'deleted'" class="muted">This exploration was deleted.</p>
    <p v-else-if="state.status === 'error'" class="muted">Could not load this exploration.</p>
    <p v-else-if="!fork" class="muted">This fork does not exist.</p>

    <template v-else>
      <h1 class="fork-title">{{ forkTitle(fork) }}</h1>
      <p v-if="path.length === 0" class="muted">No messages yet. Write the first one below.</p>

      <template v-for="(message, index) in path" :key="message.id">
        <div v-if="parentFork && index === ownStart" class="fork-point">
          Forked from
          <RouterLink
            :to="
              parentFork.parentForkId
                ? `/e/${explorationId}/f/${parentFork.id}`
                : `/e/${explorationId}`
            "
          >
            {{ forkTitle(parentFork) }}
          </RouterLink>
        </div>
        <ConversationMessage
          :message="message"
          :quoted-comments="quotedCommentsOf(message.id, state.comments)"
          :shared="ownStart !== -1 && index < ownStart"
        />
      </template>

      <p v-if="awaitingAnswer" class="answering muted">Claude is answering…</p>

      <QueuedSubmissionCard
        v-for="submission in queuedSubmissions"
        :key="submission.id"
        :submission="submission"
        :comment-count="commentCountOf(submission.id)"
      />

      <ReplyBar :exploration-id="explorationId" :fork-id="fork.id" />
    </template>
  </div>
</template>

<style scoped>
.top {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem 0;
  background: var(--background);
  border-bottom: 1px solid var(--border);
  font-size: 0.875rem;
}

.crumbs {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fork-title {
  font-size: 1.35rem;
  margin: 1.25rem 0 0.5rem;
}

.fork-point {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin: 1.5rem 0 0.5rem;
  font-size: 0.8rem;
  color: var(--text-muted);
}

.fork-point::before,
.fork-point::after {
  content: '';
  flex: 1;
  border-top: 1px solid var(--border);
}

.answering {
  font-style: italic;
}
</style>
