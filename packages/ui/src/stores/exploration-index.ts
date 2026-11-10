import type { Activity, Comment, Fork, MessageFile } from '@shared/types';
import { computed, effectScope } from 'vue';
import { groupBy, keepSameGroups } from '../lib/stable';
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
