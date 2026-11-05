import type { Comment } from '@shared/types';
import { reactive } from 'vue';
import { newId, outbox } from './outbox';

// Joining mode, started on one fork comment: the reader picks the fork comments that start one
// fork together with it. Its current group mates start out picked.
export const forkJoining = reactive({ startId: null as string | null, picked: new Set<string>() });

export function startJoining(start: Comment, groupMateIds: string[]) {
  forkJoining.startId = start.id;
  forkJoining.picked = new Set(groupMateIds);
}

export function togglePicked(commentId: string) {
  if (!forkJoining.picked.delete(commentId)) forkJoining.picked.add(commentId);
}

export function stopJoining() {
  forkJoining.startId = null;
  forkJoining.picked = new Set();
}

export function confirmJoining(start: Comment) {
  outbox.add({
    type: 'comment.join-fork-group',
    explorationId: start.explorationId,
    commentId: start.id,
    memberIds: [...forkJoining.picked],
    groupId: newId(),
  });
  stopJoining();
}
