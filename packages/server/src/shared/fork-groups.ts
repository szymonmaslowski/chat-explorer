// Shared by the daemon, which stores fork groups, and the page, which shows them before the
// daemon confirms. Joined fork comments start one fork together on Submit. A group needs two
// comments: one left alone is a plain fork comment again.

export interface GroupableComment {
  id: string;
  forkGroupId: string | null;
}

export interface OrderableComment {
  messageId: string;
  quote: string;
  startOffset: number;
}

type GroupChanges = Map<string, string | null>;

function changesFrom(comments: GroupableComment[], next: GroupChanges) {
  const counts = new Map<string, number>();
  for (const groupId of next.values()) {
    if (groupId) counts.set(groupId, (counts.get(groupId) ?? 0) + 1);
  }
  const changes: GroupChanges = new Map();
  for (const comment of comments) {
    const groupId = next.get(comment.id) ?? null;
    const kept = groupId && (counts.get(groupId) ?? 0) > 1 ? groupId : null;
    if (kept !== comment.forkGroupId) changes.set(comment.id, kept);
  }
  return changes;
}

// The starting comment's group becomes exactly the starting comment and the picked ones. A picked
// comment leaves the group it was in.
export function joinForkGroup(
  comments: GroupableComment[],
  startId: string,
  memberIds: string[],
  newGroupId: string,
) {
  const groupId = comments.find((comment) => comment.id === startId)?.forkGroupId ?? newGroupId;
  const next: GroupChanges = new Map(
    comments.map((comment) => [
      comment.id,
      comment.forkGroupId === groupId ? null : comment.forkGroupId,
    ]),
  );
  for (const id of [startId, ...memberIds]) next.set(id, groupId);
  return changesFrom(comments, next);
}

// Also what happens to a group when one of its comments is deleted or stops being a fork comment.
export function leaveForkGroup(comments: GroupableComment[], commentId: string) {
  const next: GroupChanges = new Map(comments.map((comment) => [comment.id, comment.forkGroupId]));
  next.set(commentId, null);
  return changesFrom(comments, next);
}

// The order of the text they comment on: earlier messages first, then by place in the message.
// A general comment quotes nothing and follows the others on its message.
export function inTextOrder<Comment extends OrderableComment>(
  comments: Comment[],
  messageOrder: string[],
) {
  const messagePosition = (comment: Comment) => {
    const position = messageOrder.indexOf(comment.messageId);
    return position === -1 ? Infinity : position;
  };
  const placeInMessage = (comment: Comment) => (comment.quote ? comment.startOffset : Infinity);
  return comments.toSorted(
    (left, right) =>
      messagePosition(left) - messagePosition(right) ||
      placeInMessage(left) - placeInMessage(right) ||
      0,
  );
}
