<script setup lang="ts">
import type { Comment } from '@shared/types';
import { computed } from 'vue';
import { replyFilesOwner, useFileDrafts } from '../stores/file-drafts';
import { replyDrafts } from '../stores/reply-drafts';
import CommentCard from './CommentCard.vue';
import ForkGroupCard from './ForkGroupCard.vue';

// What Submit would send, in place of the conversation: every draft as its card, with the checkbox
// that includes it, and the reply box's message as the last comment. Confirm sends, Cancel goes back.
const props = defineProps<{
  forkId: string;
  // In the order of the text they are on.
  drafts: Comment[];
  canConfirm: boolean;
}>();
const emit = defineEmits<{
  confirm: [];
  cancel: [];
  jump: [comment: Comment];
}>();

const text = computed(() => replyDrafts.get(props.forkId).trim());
const newFork = computed(() => replyDrafts.newFork(props.forkId));
const files = useFileDrafts(() => replyFilesOwner(props.forkId));
const fileCount = computed(() => files.readyIds.value.length);
const hasMessage = computed(() => text.value !== '' || fileCount.value > 0);

// The comments of one fork group show as one card, at the place of the group's first comment.
const entries = computed(() => {
  const seen = new Set<string>();
  return props.drafts.flatMap((draft) => {
    const groupId = draft.forkGroupId;
    if (groupId === null) return [{ first: draft, comments: [draft] }];
    if (seen.has(groupId)) return [];
    seen.add(groupId);
    const comments = props.drafts.filter((other) => other.forkGroupId === groupId);
    return [{ first: comments[0]!, comments }];
  });
});
const selectedCount = computed(() => props.drafts.filter((draft) => draft.selected).length);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const summary = computed(() =>
  [
    plural(selectedCount.value, 'comment'),
    props.drafts.length > selectedCount.value
      ? `${props.drafts.length - selectedCount.value} left out`
      : '',
    hasMessage.value ? 'and your message' : '',
  ]
    .filter(Boolean)
    .join(', '),
);
</script>

<template>
  <section class="submit-review" aria-label="Review before sending">
    <p class="review-title">
      Review before sending <span class="muted">{{ summary }}</span>
    </p>
    <div class="cards">
      <template v-for="entry in entries" :key="entry.first.id">
        <ForkGroupCard
          v-if="entry.first.forkGroupId"
          :comments="entry.comments"
          @jump="(comment) => emit('jump', comment)"
        />
        <CommentCard v-else :comment="entry.first" show-quote @jump="emit('jump', entry.first)" />
      </template>
      <div v-if="hasMessage" class="message-card" :class="{ 'new-fork': newFork }">
        <div class="label">Message<span v-if="newFork"> · to a new fork</span></div>
        <p v-if="text" class="body">{{ text }}</p>
        <p v-if="fileCount" class="muted">{{ plural(fileCount, 'file') }} attached</p>
      </div>
    </div>
    <div class="review-actions">
      <button type="button" @click="emit('cancel')">Cancel</button>
      <button type="button" class="primary" :disabled="!canConfirm" @click="emit('confirm')">
        Confirm
      </button>
    </div>
  </section>
</template>

<style scoped>
.review-title {
  margin: 0.75rem 0 0.25rem;
  font-weight: 600;
}

.review-title .muted {
  font-weight: 400;
  font-size: 0.85rem;
  margin-left: 0.4rem;
}

.cards {
  padding-bottom: 1rem;
}

/* The message goes as a comment too, so it looks like one. */
.message-card {
  margin-top: 0.4rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius);
  padding: 0.4rem 0.6rem;
  font-size: 0.85rem;
}

.message-card.new-fork {
  border-left-color: var(--fork);
}

.message-card .label {
  font-size: 0.75rem;
  text-transform: uppercase;
  color: var(--text-muted);
}

.message-card .body {
  margin: 0.2rem 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.review-actions {
  position: sticky;
  bottom: 0;
  z-index: 5;
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.75rem 0 1rem;
  border-top: 1px solid var(--border);
  background: var(--background);
}
</style>
