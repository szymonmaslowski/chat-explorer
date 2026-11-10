import type { Comment, MessageFile } from '@shared/types';
import { computed, effectScope } from 'vue';
import { groupBy, keepSameGroups } from '../lib/stable';
import type { ExplorationState } from './exploration';

// Lookups by key, built once per change of the chat instead of by each component that needs
// them, and keeping unchanged groups as they were.
function buildIndex(state: ExplorationState) {
  const byCreation = (left: Comment, right: Comment) => left.createdAt - right.createdAt;
  return {
    quotedCommentsByMessage: computed<Map<string, Comment[]>>((previous) => {
      const groups = groupBy(state.comments.values(), (comment) => comment.replyMessageId);
      for (const group of groups.values()) group.sort(byCreation);
      return keepSameGroups(previous, groups);
    }),
    filesByMessage: computed<Map<string, MessageFile[]>>((previous) =>
      keepSameGroups(
        previous,
        groupBy(state.files.values(), (file) => file.messageId),
      ),
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
