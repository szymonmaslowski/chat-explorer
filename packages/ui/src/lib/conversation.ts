import type { Comment, Fork, Message } from '@shared/types';

export function pathTo(messageId: string | null, messages: Map<string, Message>) {
  const path: Message[] = [];
  let current = messageId ? messages.get(messageId) : undefined;
  while (current) {
    path.push(current);
    current = current.parentId ? messages.get(current.parentId) : undefined;
  }
  return path.reverse();
}

export function forkPath(fork: Fork, messages: Map<string, Message>) {
  return pathTo(fork.tipMessageId ?? fork.baseMessageId, messages);
}

export function mainFork(forks: Map<string, Fork>) {
  return [...forks.values()].find((fork) => fork.parentForkId === null) ?? null;
}

// Archiving a fork covers the forks below it, so this finds the fork itself or the nearest
// archived one above it.
export function archivingFork(fork: Fork, forks: Map<string, Fork>) {
  let current: Fork | undefined = fork;
  while (current) {
    if (current.archivedAt !== null) return current;
    current = current.parentForkId ? forks.get(current.parentForkId) : undefined;
  }
  return null;
}

export function quotedCommentsOf(messageId: string, comments: Map<string, Comment>) {
  return [...comments.values()]
    .filter((comment) => comment.replyMessageId === messageId)
    .sort((left, right) => left.createdAt - right.createdAt);
}

export function forkTitle(fork: Fork) {
  if (fork.summary) return fork.summary;
  return fork.parentForkId === null ? 'Main' : 'Untitled fork';
}
