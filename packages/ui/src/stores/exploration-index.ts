import type { Activity, Comment, Fork, Message, MessageFile } from '@shared/types';
import { computed, effectScope } from 'vue';
import { taggedIds } from '@shared/answer-tags';
import { forkAttention, type Attention } from '../lib/read-state';
import { groupBy, keepSameGroups, keepSameMap } from '../lib/stable';
import type { ExplorationState } from './exploration';

const byCreation = (left: { createdAt: number }, right: { createdAt: number }) =>
  left.createdAt - right.createdAt;

const groupedBy = <Item>(items: () => Iterable<Item>, keyOf: (item: Item) => string | null) =>
  computed<Map<string, Item[]>>((previous) => keepSameGroups(previous, groupBy(items(), keyOf)));

const sortedGroupedBy = <Item extends { createdAt: number }>(
  items: () => Iterable<Item>,
  keyOf: (item: Item) => string | null,
) =>
  computed<Map<string, Item[]>>((previous) => {
    const groups = groupBy(items(), keyOf);
    for (const group of groups.values()) group.sort(byCreation);
    return keepSameGroups(previous, groups);
  });

// Lookups by key, built once per change of the chat instead of by each component that needs
// them, and keeping unchanged groups as they were.
function buildIndex(state: ExplorationState) {
  const comments = () => state.comments.values();
  const files = () => state.files.values();
  return {
    commentsByViewFork: groupedBy<Comment>(comments, (comment) => comment.viewForkId),
    commentsBySubmission: groupedBy<Comment>(comments, (comment) => comment.submissionId),
    quotedCommentsByMessage: sortedGroupedBy<Comment>(
      comments,
      (comment) => comment.replyMessageId,
    ),
    filesByMessage: groupedBy<MessageFile>(files, (file) => file.messageId),
    filesBySubmission: groupedBy<MessageFile>(files, (file) => file.submissionId),
    activitiesByFork: sortedGroupedBy<Activity>(
      () => state.activities.values(),
      (activity) => activity.forkId,
    ),
    attentionByFork: computed<Map<string, Attention>>((previous) =>
      keepSameMap(previous, forkAttention(state)),
    ),
    // Claude's answer to a sent comment, or to a message's reply-box text: the first answer with
    // its tag.
    answersByComment: computed(() => {
      const answers = new Map<string, Message>();
      for (const message of state.messages.values()) {
        if (message.role !== 'assistant') continue;
        for (const id of taggedIds(message.content)) {
          if (!answers.has(id)) answers.set(id, message);
        }
      }
      return answers;
    }),
    childForksByBaseMessage: groupedBy<Fork>(
      () => state.forks.values(),
      (fork) => (fork.parentForkId === null ? null : fork.baseMessageId),
    ),
  };
}

const indexes = new WeakMap<ExplorationState, ReturnType<typeof buildIndex>>();

export function explorationIndex(state: ExplorationState) {
  const existing = indexes.get(state);
  if (existing) return existing;
  const index = effectScope(true).run(() => buildIndex(state))!;
  indexes.set(state, index);
  return index;
}
