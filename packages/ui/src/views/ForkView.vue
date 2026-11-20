<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue';
import type {
  Activity,
  ActivitySummary,
  Bookmark,
  Comment,
  Message,
  MessageHead,
} from '@shared/types';
import { useRoute, useRouter } from 'vue-router';
import BookmarkList from '../components/BookmarkList.vue';
import CommentLayer from '../components/CommentLayer.vue';
import ConfirmButton from '../components/ConfirmButton.vue';
import ExplorationHeader from '../components/ExplorationHeader.vue';
import ForkArchiveControl from '../components/ForkArchiveControl.vue';
import NoteDeletionNotice from '../components/NoteDeletionNotice.vue';
import ConversationMessage from '../components/ConversationMessage.vue';
import QueuedSubmissionCard from '../components/QueuedSubmissionCard.vue';
import ReplyBar from '../components/ReplyBar.vue';
import SpeechPlayer from '../components/SpeechPlayer.vue';
import ActivityGroup from '../components/ActivityGroup.vue';
import AttentionDot from '../components/AttentionDot.vue';
import ForkRunStatus from '../components/ForkRunStatus.vue';
import CodingRoomHint from '../components/CodingRoomHint.vue';
import MediaIcon from '../components/MediaIcon.vue';
import { useCommentTyping } from '../composables/useCommentTyping';
import { useLayout } from '../composables/useLayout';
import { useMediaQuery } from '../composables/useMediaQuery';
import { useMessageWindow } from '../composables/useMessageWindow';
import { useReadTracking } from '../composables/useReadTracking';
import { useStickyHeaderHeight } from '../composables/useStickyHeaderHeight';
import {
  answeredPartLookup,
  sentMessageComment,
  archivingFork,
  forkPath,
  forkTitle,
  mainFork,
} from '../lib/conversation';
import { scrollToAndFlash } from '../lib/flash';
import { keepSameList, keepSameMap, noItems } from '../lib/stable';
import { awaitsAnswer, isUnread } from '../lib/read-state';
import {
  applyEvent,
  attemptKey,
  loadAttemptActivities,
  openExploration,
} from '../stores/exploration';
import { explorationIndex } from '../stores/exploration-index';
import { api } from '../api';
import { newId, outbox } from '../stores/outbox';
import { stopSpeech } from '../stores/speech';
import { offline } from '../lib/online';

const props = defineProps<{ explorationId: string; forkId?: string }>();

const nearBottomPx = 200;

const route = useRoute();
const router = useRouter();
const { mapColumn } = useLayout();
const commentLayer = ref<InstanceType<typeof CommentLayer> | null>(null);
// Narrower than the text and the comment rail together, comments list under their messages.
const compact = useMediaQuery('(max-width: 1080px), (hover: none)');
const commentTyping = useCommentTyping();
// On a phone the reply box gives its room to the comment being typed. Without its marker, the
// rest of the page counts on no dock.
const dockHidden = computed(() => compact.value && commentTyping.value);
const state = computed(() => openExploration(props.explorationId));
const fork = computed(() =>
  props.forkId ? (state.value.forks.get(props.forkId) ?? null) : mainFork(state.value.forks),
);
const archivedBy = computed(() =>
  fork.value ? archivingFork(fork.value, state.value.forks) : null,
);
const archived = computed(() => archivedBy.value !== null);
const parentFork = computed(() =>
  fork.value?.parentForkId ? (state.value.forks.get(fork.value.parentForkId) ?? null) : null,
);
const lookups = computed(() => explorationIndex(state.value));
const path = computed<MessageHead[]>((previous) =>
  keepSameList(previous, fork.value ? forkPath(fork.value, state.value.messages) : []),
);
const pathIds = computed(() => new Set(path.value.map((message) => message.id)));
const pathIndex = computed(() => new Map(path.value.map((message, index) => [message.id, index])));
// Only the newest messages, and older ones as the reader scrolls up, are on the page.
const {
  messages: shownMessages,
  ready: windowReady,
  hasOlder,
  reveal,
} = useMessageWindow({ state, fork, path, sentinelRef: 'olderSentinel' });
const shownIds = computed(() => shownMessages.value.map((message) => message.id).join());
// Claude's answers counted back from the newest, [0], so the user can refer to one as [-2].
const answerIndexes = computed(() => {
  const answers = path.value.filter((message) => message.role === 'assistant');
  return new Map(answers.map((message, index) => [message.id, index - (answers.length - 1)]));
});
const ownStart = computed(() =>
  path.value.findIndex((message) => message.forkId === fork.value?.id),
);
const forkRun = computed(() =>
  fork.value ? (state.value.forkRuns.get(fork.value.id) ?? null) : null,
);
const awaitingAnswer = computed(
  () => !!fork.value && awaitsAnswer(fork.value, state.value.messages, forkRun.value ?? undefined),
);
interface AttemptGroup {
  summary: ActivitySummary;
  activities: Activity[];
}
// By the user message a turn answered, each attempt in order, with the steps loaded so far.
const activityGroups = computed<Map<string, AttemptGroup[]>>((previous) => {
  const loaded = new Map<string, Activity[]>();
  for (const activity of (fork.value && lookups.value.activitiesByFork.value.get(fork.value.id)) ??
    []) {
    const key = attemptKey(activity);
    loaded.set(key, [...(loaded.get(key) ?? []), activity]);
  }
  const groups = new Map<string, AttemptGroup[]>();
  const summaries = [...state.value.activitySummaries.values()]
    .filter((summary) => summary.forkId === fork.value?.id)
    .sort((first, second) => first.attempt - second.attempt);
  for (const summary of summaries) {
    const before = previous?.get(summary.afterMessageId);
    const key = attemptKey(summary);
    const kept = before?.find((group) => attemptKey(group.summary) === key);
    const activities = keepSameList(kept?.activities, loaded.get(key) ?? []);
    const group =
      kept && kept.summary === summary && kept.activities === activities
        ? kept
        : { summary, activities };
    groups.set(summary.afterMessageId, [...(groups.get(summary.afterMessageId) ?? []), group]);
  }
  return keepSameMap(
    previous,
    new Map(
      [...groups].map(([messageId, list]) => [
        messageId,
        keepSameList(previous?.get(messageId), list),
      ]),
    ),
  );
});
// A run that posted answers in the middle has a group under each; only the newest is working.
const isWorking = ({ summary }: AttemptGroup) => {
  if (
    forkRun.value?.status !== 'answering' ||
    summary.attempt !== forkRun.value.attempt ||
    summary.interrupted
  ) {
    return false;
  }
  for (const groups of activityGroups.value.values()) {
    for (const other of groups) {
      if (
        other.summary.attempt === summary.attempt &&
        !other.summary.interrupted &&
        other.summary.lastAt > summary.lastAt
      ) {
        return false;
      }
    }
  }
  return true;
};
const loadSteps = (group: AttemptGroup) => void loadAttemptActivities(state.value, group.summary);
const lastAnswer = computed(() => path.value.findLast((message) => message.role === 'assistant'));
const lastUnread = computed(() => path.value.findLast(isUnread));
const attention = computed(() => lookups.value.attentionByFork.value);
const { newIds, markUnread, markReadUpTo } = useReadTracking({ state, fork, path });

// The new fork opens at once, empty, with the answer as the last message of its history.
function forkAtAnswer(message: Message) {
  const forkId = newId('fork');
  outbox.add({
    type: 'fork.create',
    explorationId: props.explorationId,
    forkId,
    parentForkId: message.forkId,
    baseMessageId: message.id,
  });
  void router.push(`/e/${props.explorationId}/f/${forkId}`);
}

// A message of the user's that follows one of Claude's answers in this fork can take the rest of
// the fork into a new one, while Claude is not working on it.
function splittable(message: Message, index: number) {
  const previous = path.value[index - 1];
  return (
    !offline.value &&
    !archived.value &&
    !awaitingAnswer.value &&
    forkRun.value?.status !== 'answering' &&
    message.role === 'user' &&
    message.forkId === fork.value?.id &&
    previous?.role === 'assistant' &&
    previous.forkId === fork.value.id
  );
}

// Counts messages rendered again with new text, which moves the comments in them.
const renderedCount = ref(0);
const splitError = ref<{ messageId: string; text: string } | null>(null);
async function splitAt(message: Message) {
  splitError.value = null;
  try {
    const split = await api.splitFork(message.id, newId('fork'));
    applyEvent(state.value, { type: 'fork.split', ...split });
    void router.push(`/e/${props.explorationId}/f/${split.fork.id}#m-${message.id}`);
  } catch (error) {
    splitError.value = {
      messageId: message.id,
      text: error instanceof Error ? error.message : String(error),
    };
  }
}
const answeredPart = computed(() => answeredPartLookup(state.value));
const viewComments = computed<Comment[]>((previous) => {
  const forkComments =
    (fork.value && lookups.value.commentsByViewFork.value.get(fork.value.id)) ?? [];
  const forkId = fork.value?.id;
  const sentMessages = forkId
    ? shownMessages.value.flatMap((message) => sentMessageComment(message, forkId) ?? [])
    : [];
  return keepSameList(previous, [
    ...forkComments.filter((comment) => pathIds.value.has(comment.messageId)),
    ...sentMessages,
  ]);
});
const viewBookmarks = computed<Bookmark[]>((previous) => {
  const order = new Map(path.value.map((message, index) => [message.id, index]));
  const bookmarks = [...state.value.bookmarks.values()]
    .filter((bookmark) => bookmark.forkId === fork.value?.id && order.has(bookmark.messageId))
    .sort(
      (first, second) =>
        order.get(first.messageId)! - order.get(second.messageId)! ||
        first.startOffset - second.startOffset,
    );
  return keepSameList(previous, bookmarks);
});
const bookmarksOpen = ref(false);
const draftsOnly = ref(false);
watch(
  () => fork.value?.id,
  () => (draftsOnly.value = false),
);
// Every draft shows in drafts-only view, so the messages they are on come first.
watch(draftsOnly, (only) => {
  if (!only) return;
  const first = drafts.value
    .map((draft) => draft.messageId)
    .sort((left, right) => (pathIndex.value.get(left) ?? 0) - (pathIndex.value.get(right) ?? 0))[0];
  if (first) void reveal(first);
});
watch(
  () => [fork.value?.id, viewBookmarks.value.length === 0],
  () => (bookmarksOpen.value = false),
);
const drafts = computed<Comment[]>((previous) =>
  keepSameList(
    previous,
    viewComments.value.filter((comment) => comment.status === 'draft'),
  ),
);
// The layer places only the comments on messages the page shows: a card listed under a message
// needs that message on the page when the card is made.
const shownComments = computed<Comment[]>((previous) => {
  const shown = new Set(shownMessages.value.map((message) => message.id));
  return keepSameList(
    previous,
    viewComments.value.filter((comment) => shown.has(comment.messageId)),
  );
});
const queuedSubmissions = computed(() =>
  [...state.value.queuedSubmissions.values()].filter(
    (submission) => submission.forkId === fork.value?.id,
  ),
);
const forksAt = (messageId: string) =>
  lookups.value.childForksByBaseMessage.value.get(messageId) ?? [];
const filesOfSubmission = (submissionId: string) =>
  lookups.value.filesBySubmission.value.get(submissionId) ?? noItems;
const commentCountOf = (submissionId: string) =>
  lookups.value.commentsBySubmission.value.get(submissionId)?.length ?? 0;

let nearBottom = true;
const trackScroll = () => {
  const { scrollHeight } = document.documentElement;
  nearBottom = window.scrollY + window.innerHeight >= scrollHeight - nearBottomPx;
};
onMounted(() => window.addEventListener('scroll', trackScroll, { passive: true }));
useStickyHeaderHeight(useTemplateRef<HTMLElement>('page'));
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

// A link to a message, a comment or a bookmark further up shows everything down from it first.
function linkedMessageId(hash: string) {
  const id = hash.slice(3);
  if (hash.startsWith('#m-')) return id;
  if (hash.startsWith('#b-')) return state.value.bookmarks.get(id)?.messageId ?? null;
  if (!hash.startsWith('#c-')) return null;
  // A message's reply-box text shows as a sent comment under the message it replied to.
  return state.value.comments.get(id)?.messageId ?? state.value.messages.get(id)?.parentId ?? null;
}
watch(
  () => [route.hash, windowReady.value] as const,
  ([hash, ready]) => {
    const messageId = ready ? linkedMessageId(hash) : null;
    if (messageId) void reveal(messageId);
  },
  { immediate: true },
);

let handledHash = '';
watch(
  () => [route.hash, shownMessages.value.length] as const,
  ([hash]) => {
    if (!hash.startsWith('#m-') || hash === handledHash) return;
    const target = document.getElementById(hash.slice(1));
    if (!target) return;
    handledHash = hash;
    scrollToAndFlash(target);
  },
  { flush: 'post', immediate: true },
);
</script>

<template>
  <div ref="page" class="page fork-view">
    <ExplorationHeader
      :state="state"
      page="fork"
      :fork="fork ?? undefined"
      class="top"
      data-sticky-header
    >
      <template v-if="fork && archivedBy" #title-badge>
        <span class="archived-label">
          <template v-if="archivedBy.id === fork.id">Archived</template>
          <template v-else>
            Archived with
            <RouterLink :to="`/e/${explorationId}/f/${archivedBy.id}`">{{
              forkTitle(archivedBy)
            }}</RouterLink>
          </template>
        </span>
      </template>
      <template v-if="fork" #title-actions>
        <button
          v-if="path.length > 0"
          type="button"
          class="icon-button"
          aria-label="Scroll to the bottom"
          title="Scroll to the bottom of the fork"
          @click="scrollToBottom"
        >
          <MediaIcon name="to-end" />
        </button>
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
        <ConfirmButton
          v-if="lastUnread"
          label="Mark read"
          class="icon-button"
          title="Mark every answer in this fork read"
          @confirm="markReadUpTo(lastUnread.id)"
        >
          <MediaIcon name="read" /><span class="visually-hidden">Mark read</span>
        </ConfirmButton>
        <button
          v-else-if="lastAnswer"
          type="button"
          class="icon-button"
          aria-label="Mark unread"
          title="Mark this fork unread"
          @click="markUnread(lastAnswer.id)"
        >
          <MediaIcon name="unread" />
        </button>
        <ForkArchiveControl
          v-if="fork.parentForkId"
          :exploration-id="explorationId"
          :fork="fork"
          :archived-by="archivedBy"
        />
        <button
          v-if="mapColumn"
          type="button"
          class="icon-button"
          aria-label="Close"
          title="Close this fork, back to the map"
          @click="router.push(`/e/${explorationId}/map`)"
        >
          <MediaIcon name="close" />
        </button>
      </template>
      <BookmarkList
        v-if="bookmarksOpen"
        :bookmarks="viewBookmarks"
        @jump="compact && (bookmarksOpen = false)"
      />
      <SpeechPlayer />
    </ExplorationHeader>

    <NoteDeletionNotice :exploration-id="explorationId" :notes="state.notes" />

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
        <div v-if="hasOlder" ref="olderSentinel" class="older" aria-hidden="true" />
        <p v-if="path.length > 0 && !windowReady" class="muted">Loading…</p>
        <template v-for="message in shownMessages" :key="message.id">
          <div v-if="parentFork && pathIndex.get(message.id) === ownStart" class="fork-point">
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
            :quoted-comments="lookups.quotedCommentsByMessage.value.get(message.id) ?? noItems"
            :files="lookups.filesByMessage.value.get(message.id) ?? noItems"
            :shared="ownStart !== -1 && pathIndex.get(message.id)! < ownStart"
            :is-new="newIds.has(message.id)"
            :answered-part="answeredPart"
            :forkable="!archived"
            :splittable="splittable(message, pathIndex.get(message.id)!)"
            :answer-index="answerIndexes.get(message.id) ?? null"
            @mark-unread="markUnread(message.id)"
            @mark-read="markReadUpTo(message.id)"
            @fork="forkAtAnswer(message)"
            @split="splitAt(message)"
            @rendered="renderedCount++"
          />
          <p v-if="splitError?.messageId === message.id" class="split-error" role="alert">
            {{ splitError.text }}
          </p>
          <ActivityGroup
            v-for="group in activityGroups.get(message.id) ?? []"
            :key="`${message.id}-${group.summary.attempt}`"
            :summary="group.summary"
            :activities="group.activities"
            :working="isWorking(group)"
            @load="loadSteps(group)"
          />
          <div :id="`comments-${message.id}`" class="message-comments" />
          <template v-for="child in forksAt(message.id)" :key="child.id">
            <RouterLink
              v-if="child.archivedAt === null && child.id !== fork.id"
              :to="`/e/${explorationId}/f/${child.id}`"
              class="reply-fork"
            >
              ↳ Fork: {{ forkTitle(child) }}
              <AttentionDot v-if="attention.get(child.id)" :attention="attention.get(child.id)!" />
            </RouterLink>
            <!-- The steps Claude took after the fork was made there. -->
            <ActivityGroup
              v-for="group in activityGroups.get(child.id) ?? []"
              :key="`${child.id}-${group.summary.attempt}`"
              :summary="group.summary"
              :activities="group.activities"
              :working="isWorking(group)"
              @load="loadSteps(group)"
            />
          </template>
        </template>
        <CommentLayer
          :key="fork.id"
          ref="commentLayer"
          :exploration-id="explorationId"
          :fork-id="fork.id"
          :comments="shownComments"
          :bookmarks="viewBookmarks"
          :layout-key="`${shownIds} ${renderedCount}`"
          :read-only="archived"
          :drafts-only="draftsOnly"
          @show-text="draftsOnly = false"
        />
      </div>

      <ForkRunStatus :fork-id="fork.id" :run="forkRun" :awaiting-answer="awaitingAnswer" />
      <CodingRoomHint v-if="!archived" :fork="fork" :run="forkRun" />

      <QueuedSubmissionCard
        v-for="submission in queuedSubmissions"
        :key="submission.id"
        :submission="submission"
        :comment-count="commentCountOf(submission.id)"
        :files="filesOfSubmission(submission.id)"
      />

      <div v-show="!dockHidden" class="dock" :data-dock="dockHidden ? undefined : ''">
        <ReplyBar
          v-if="!archived"
          :exploration-id="explorationId"
          :fork-id="fork.id"
          :drafts="drafts"
          :saved-draft="state.replyDrafts.get(fork.id) ?? null"
          :hint="state.exploration?.title ?? ''"
          :last-message-id="path.at(-1)?.id ?? null"
          @submitted="onSubmitted"
          :drafts-only="draftsOnly"
          @show-drafts="commentLayer?.showDrafts()"
          @hide-drafts="commentLayer?.hideDrafts()"
          @show-only-drafts="draftsOnly = true"
          @show-text="draftsOnly = false"
        />
      </div>
    </template>
  </div>
</template>

<style>
/* The page keeps the reader's place itself when older messages go in above, so the browser's own
   scroll anchoring would move it twice. */
:root:has(.fork-view) {
  overflow-anchor: none;
}
</style>

<style scoped>
.split-error {
  color: var(--danger);
}

.older {
  height: 1px;
}

.top {
  position: sticky;
  top: 0;
  z-index: 6;
  background: var(--background);
}

.conversation {
  position: relative;
  /* Room under the last line for the buttons on a selection, which stay below it on a phone. */
  padding-bottom: 1.5rem;
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

.archived-label {
  font-size: 0.75rem;
  color: var(--warning);
}

.archived-label a {
  color: inherit;
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
