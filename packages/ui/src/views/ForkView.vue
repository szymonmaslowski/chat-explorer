<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import CommentLayer from '../components/CommentLayer.vue';
import ExplorationHeader from '../components/ExplorationHeader.vue';
import ForkArchiveControl from '../components/ForkArchiveControl.vue';
import NoteDeletionNotice from '../components/NoteDeletionNotice.vue';
import ConversationMessage from '../components/ConversationMessage.vue';
import QueuedSubmissionCard from '../components/QueuedSubmissionCard.vue';
import ReplyBar from '../components/ReplyBar.vue';
import SessionError from '../components/SessionError.vue';
import SpeechPlayer from '../components/SpeechPlayer.vue';
import { useMediaQuery } from '../composables/useMediaQuery';
import {
  archivingFork,
  forkPath,
  forkTitle,
  mainFork,
  quotedCommentsOf,
} from '../lib/conversation';
import { openExploration } from '../stores/exploration';
import { stopSpeech } from '../stores/speech';

const props = defineProps<{ explorationId: string; forkId?: string }>();

const nearBottomPx = 200;
const flashMs = 1_400;

const route = useRoute();
const compact = useMediaQuery('(max-width: 700px), (hover: none)');
const state = computed(() => openExploration(props.explorationId));
const chatArchived = computed(() => Boolean(state.value.exploration?.archivedAt));
const fork = computed(() =>
  props.forkId ? (state.value.forks.get(props.forkId) ?? null) : mainFork(state.value.forks),
);
const archivedBy = computed(() =>
  fork.value ? archivingFork(fork.value, state.value.forks) : null,
);
const archived = computed(() => chatArchived.value || archivedBy.value !== null);
const parentFork = computed(() =>
  fork.value?.parentForkId ? (state.value.forks.get(fork.value.parentForkId) ?? null) : null,
);
const path = computed(() => (fork.value ? forkPath(fork.value, state.value.messages) : []));
const pathIds = computed(() => new Set(path.value.map((message) => message.id)));
const ownStart = computed(() =>
  path.value.findIndex((message) => message.forkId === fork.value?.id),
);
const awaitingAnswer = computed(() => path.value.at(-1)?.role === 'user');
const viewComments = computed(() =>
  [...state.value.comments.values()].filter(
    (comment) => comment.viewForkId === fork.value?.id && pathIds.value.has(comment.messageId),
  ),
);
const drafts = computed(() => viewComments.value.filter((comment) => comment.status === 'draft'));
const queuedSubmissions = computed(() =>
  [...state.value.queuedSubmissions.values()].filter(
    (submission) => submission.forkId === fork.value?.id,
  ),
);
// Forks started from a reply, unless archived; forks from comments are reached through their
// comment.
const replyForksAt = (messageId: string) =>
  [...state.value.forks.values()].filter(
    (child) =>
      child.baseMessageId === messageId &&
      child.originCommentId === null &&
      child.parentForkId !== null &&
      child.archivedAt === null &&
      child.id !== fork.value?.id,
  );
const filesOfMessage = (messageId: string) =>
  [...state.value.files.values()].filter((file) => file.messageId === messageId);
const filesOfSubmission = (submissionId: string) =>
  [...state.value.files.values()].filter((file) => file.submissionId === submissionId);
const commentCountOf = (submissionId: string) =>
  [...state.value.comments.values()].filter((comment) => comment.submissionId === submissionId)
    .length;

let nearBottom = true;
const trackScroll = () => {
  const { scrollHeight } = document.documentElement;
  nearBottom = window.scrollY + window.innerHeight >= scrollHeight - nearBottomPx;
};
onMounted(() => window.addEventListener('scroll', trackScroll, { passive: true }));
onBeforeUnmount(() => window.removeEventListener('scroll', trackScroll));
onBeforeUnmount(stopSpeech);

const scrollToBottom = () =>
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });

async function onSubmitted() {
  await nextTick();
  scrollToBottom();
}

// Follow new messages only when the reader is already at the end of the fork.
watch(
  () => [fork.value?.id, path.value.at(-1)] as const,
  ([forkId, last], [previousForkId, previousLast]) => {
    if (!last || !previousLast || forkId !== previousForkId || last.id === previousLast.id) return;
    if (!nearBottom) return;
    if (last.role === 'assistant') {
      document
        .getElementById(`m-${last.id}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      scrollToBottom();
    }
  },
  { flush: 'post' },
);

let handledHash = '';
watch(
  () => [route.hash, path.value.length] as const,
  ([hash]) => {
    if (!hash.startsWith('#m-') || hash === handledHash) return;
    const target = document.getElementById(hash.slice(1));
    if (!target) return;
    handledHash = hash;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('flash');
    setTimeout(() => target.classList.remove('flash'), flashMs);
  },
  { flush: 'post', immediate: true },
);
</script>

<template>
  <div class="page fork-view">
    <ExplorationHeader :state="state" class="top" data-sticky-header>
      <template v-if="fork" #links>
        · <RouterLink :to="`/e/${explorationId}/map?from=${fork.id}`">Map</RouterLink> ·
        <RouterLink :to="`/e/${explorationId}/notes`">Notes</RouterLink>
      </template>
      <div id="comment-tray" />
    </ExplorationHeader>

    <NoteDeletionNotice :exploration-id="explorationId" :notes="state.notes" />
    <SessionError
      v-if="state.sessionError"
      :exploration-id="explorationId"
      :message="state.sessionError"
    />

    <p v-if="state.status === 'loading'" class="muted">Loading…</p>
    <p v-else-if="state.status === 'missing'" class="muted">This chat does not exist.</p>
    <p v-else-if="state.status === 'deleted'" class="muted">This chat was deleted.</p>
    <p v-else-if="state.status === 'error'" class="muted">Could not load this chat.</p>
    <p v-else-if="!fork" class="muted">This fork does not exist.</p>

    <template v-else>
      <h1 class="fork-title">{{ forkTitle(fork) }}</h1>
      <ForkArchiveControl
        v-if="fork.parentForkId && !chatArchived"
        :exploration-id="explorationId"
        :fork="fork"
        :archived-by="archivedBy"
      />
      <p v-if="path.length === 0" class="muted">
        No messages yet.<template v-if="!archived"> Write the first one below.</template>
      </p>

      <div class="conversation">
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
            :files="filesOfMessage(message.id)"
            :shared="ownStart !== -1 && index < ownStart"
          />
          <div :id="`comments-${message.id}`" class="message-comments" />
          <RouterLink
            v-for="child in replyForksAt(message.id)"
            :key="child.id"
            :to="`/e/${explorationId}/f/${child.id}`"
            class="reply-fork"
          >
            ↳ Fork: {{ forkTitle(child) }}
          </RouterLink>
        </template>
        <CommentLayer
          :key="fork.id"
          :exploration-id="explorationId"
          :fork-id="fork.id"
          :comments="viewComments"
          :layout-key="[...pathIds].join()"
          :compact="compact"
          :read-only="archived"
        />
      </div>

      <p v-if="awaitingAnswer" class="answering muted">Claude is answering…</p>

      <QueuedSubmissionCard
        v-for="submission in queuedSubmissions"
        :key="submission.id"
        :submission="submission"
        :comment-count="commentCountOf(submission.id)"
        :files="filesOfSubmission(submission.id)"
      />

      <div class="dock" data-dock>
        <SpeechPlayer />
        <ReplyBar
          v-if="!archived"
          :exploration-id="explorationId"
          :fork-id="fork.id"
          :drafts="drafts"
          :saved-draft="state.replyDrafts.get(fork.id) ?? null"
          :hint="state.exploration?.title ?? ''"
          @submitted="onSubmitted"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.top {
  position: sticky;
  top: 0;
  z-index: 6;
  background: var(--background);
}

.fork-title {
  font-size: 1.35rem;
  margin: 1.25rem 0 0.5rem;
}

.conversation {
  position: relative;
  -webkit-tap-highlight-color: transparent;
}

.conversation :deep(.message) {
  scroll-margin-top: 6rem;
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

.reply-fork {
  display: block;
  margin: 0 0 0.75rem;
  font-size: 0.85rem;
  color: var(--fork);
}

.dock {
  position: sticky;
  bottom: 0;
  z-index: 5;
  background: var(--background);
}
</style>
