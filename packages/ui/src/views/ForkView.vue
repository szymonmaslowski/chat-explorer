<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import BookmarkList from '../components/BookmarkList.vue';
import CommentLayer from '../components/CommentLayer.vue';
import ExplorationHeader from '../components/ExplorationHeader.vue';
import ForkArchiveControl from '../components/ForkArchiveControl.vue';
import NoteDeletionNotice from '../components/NoteDeletionNotice.vue';
import ConversationMessage from '../components/ConversationMessage.vue';
import QueuedSubmissionCard from '../components/QueuedSubmissionCard.vue';
import ReplyBar from '../components/ReplyBar.vue';
import SessionError from '../components/SessionError.vue';
import SpeechPlayer from '../components/SpeechPlayer.vue';
import AttentionDot from '../components/AttentionDot.vue';
import MediaIcon from '../components/MediaIcon.vue';
import { useMediaQuery } from '../composables/useMediaQuery';
import { useReadTracking } from '../composables/useReadTracking';
import { commentRailWidth } from '../lib/card-layout';
import {
  answeredPartLookup,
  archivingFork,
  forkPath,
  forkTitle,
  mainFork,
  quotedCommentsOf,
} from '../lib/conversation';
import { forkAttention, isUnread } from '../lib/read-state';
import { openExploration } from '../stores/exploration';
import { stopSpeech } from '../stores/speech';

const props = defineProps<{ explorationId: string; forkId?: string }>();

const nearBottomPx = 200;
const flashMs = 1_400;

const route = useRoute();
// Narrower than the text and the comment rail together, comments list under their messages.
const compact = useMediaQuery('(max-width: 1080px), (hover: none)');
const commentRail = `${commentRailWidth}px`;
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
const lastAnswer = computed(() => path.value.findLast((message) => message.role === 'assistant'));
const attention = computed(() => forkAttention(state.value));
const { newIds, markUnread } = useReadTracking({ state, fork, path });
const answeredPart = computed(() => answeredPartLookup(state.value.comments, state.value.messages));
const viewComments = computed(() =>
  [...state.value.comments.values()].filter(
    (comment) => comment.viewForkId === fork.value?.id && pathIds.value.has(comment.messageId),
  ),
);
const viewBookmarks = computed(() => {
  const order = new Map(path.value.map((message, index) => [message.id, index]));
  return [...state.value.bookmarks.values()]
    .filter((bookmark) => bookmark.forkId === fork.value?.id && order.has(bookmark.messageId))
    .sort(
      (first, second) =>
        order.get(first.messageId)! - order.get(second.messageId)! ||
        first.startOffset - second.startOffset,
    );
});
const bookmarksOpen = ref(false);
watch(
  () => [fork.value?.id, viewBookmarks.value.length === 0],
  () => (bookmarksOpen.value = false),
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
  <div class="page fork-view" :class="{ 'with-rail': !compact }">
    <ExplorationHeader :state="state" :fork="fork ?? undefined" class="top" data-sticky-header>
      <template v-if="fork" #links>
        · <RouterLink :to="`/e/${explorationId}/map?from=${fork.id}`">Map</RouterLink> ·
        <RouterLink :to="`/e/${explorationId}/notes`">Notes</RouterLink>
      </template>
      <template v-if="fork" #title-actions>
        <button
          v-if="viewBookmarks.length > 0"
          type="button"
          class="icon-button bookmarks-button"
          :aria-expanded="bookmarksOpen"
          :aria-label="`Bookmarks (${viewBookmarks.length})`"
          title="Bookmarks of this fork"
          @click="bookmarksOpen = !bookmarksOpen"
        >
          <MediaIcon name="bookmark" />
          {{ viewBookmarks.length }}
        </button>
        <button
          v-if="lastAnswer && !isUnread(lastAnswer)"
          type="button"
          class="icon-button"
          aria-label="Mark unread"
          title="Mark this fork unread"
          @click="markUnread(lastAnswer.id)"
        >
          <MediaIcon name="unread" />
        </button>
        <ForkArchiveControl
          v-if="fork.parentForkId && !chatArchived"
          :exploration-id="explorationId"
          :fork="fork"
          :archived-by="archivedBy"
        />
      </template>
      <BookmarkList
        v-if="bookmarksOpen"
        :bookmarks="viewBookmarks"
        @jump="compact && (bookmarksOpen = false)"
      />
      <div id="comment-tray" />
      <SpeechPlayer />
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
            :is-new="newIds.has(message.id)"
            :answered-part="answeredPart"
            @mark-unread="markUnread(message.id)"
          />
          <div :id="`comments-${message.id}`" class="message-comments" />
          <RouterLink
            v-for="child in replyForksAt(message.id)"
            :key="child.id"
            :to="`/e/${explorationId}/f/${child.id}`"
            class="reply-fork"
          >
            ↳ Fork: {{ forkTitle(child) }}
            <AttentionDot v-if="attention.get(child.id)" :attention="attention.get(child.id)!" />
          </RouterLink>
        </template>
        <CommentLayer
          :key="fork.id"
          :exploration-id="explorationId"
          :fork-id="fork.id"
          :comments="viewComments"
          :bookmarks="viewBookmarks"
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
        <ReplyBar
          v-if="!archived"
          :exploration-id="explorationId"
          :fork-id="fork.id"
          :drafts="drafts"
          :saved-draft="state.replyDrafts.get(fork.id) ?? null"
          :hint="state.exploration?.title ?? ''"
          :last-message-id="path.at(-1)?.id ?? null"
          @submitted="onSubmitted"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.fork-view.with-rail {
  max-width: calc(var(--column) + v-bind(commentRail));
  padding-right: calc(1rem + v-bind(commentRail));
}

.top {
  position: sticky;
  top: 0;
  z-index: 6;
  background: var(--background);
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

.bookmarks-button {
  gap: 0.25rem;
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
