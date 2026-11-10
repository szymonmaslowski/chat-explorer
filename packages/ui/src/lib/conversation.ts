import { commentTag, type AnsweredPartLookup } from '@shared/answer-tags';
import type { Comment, ExplorationListItem, Fork, Message } from '@shared/types';
import type { ExplorationState } from '../stores/exploration';

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

// The forks from Main down to the given fork, both included.
export function forkLineage(fork: Fork, forks: Map<string, Fork>) {
  const lineage: Fork[] = [];
  let current: Fork | undefined = fork;
  while (current) {
    lineage.unshift(current);
    current = current.parentForkId ? forks.get(current.parentForkId) : undefined;
  }
  return lineage;
}

// Archiving a fork covers the forks below it, so this finds the fork itself or the nearest
// archived one above it.
export function archivingFork(fork: Fork, forks: Map<string, Fork>) {
  return forkLineage(fork, forks).findLast((each) => each.archivedAt !== null) ?? null;
}

// Claude's answer to a sent comment: the message with the comment's tag.
export const answerToComment = (commentId: string, messages: Map<string, Message>) =>
  [...messages.values()].find(
    (message) => message.role === 'assistant' && message.content.includes(commentTag(commentId)),
  ) ?? null;

export const commentLink = (comment: Comment) =>
  `/e/${comment.explorationId}/f/${comment.viewForkId}#c-${comment.id}`;

// What the tags in an answer point at: a comment, linking to the text it quotes, or the text of
// a message. It reads the chat when called, so an answer's markdown depends only on what its own
// tags name, and the lookup stays the same function while the chat changes.
export function answeredPartLookup(
  state: Pick<ExplorationState, 'comments' | 'messages'>,
): AnsweredPartLookup {
  return (kind, id) => {
    if (kind === 'message') {
      const message = state.messages.get(id);
      return message ? { quote: '', text: message.content, href: null } : null;
    }
    const comment = state.comments.get(id);
    if (!comment) return null;
    return {
      quote: comment.quote,
      text: comment.body,
      href: comment.quote ? commentLink(comment) : null,
    };
  };
}

export function forkTitle(fork: Fork) {
  if (fork.summary) return fork.summary;
  return fork.parentForkId === null ? 'Main' : 'Untitled fork';
}

// A chat opens on its notes, or on its map, or with a single fork on that fork's conversation.
export function chatHomePath(chat: Pick<ExplorationListItem, 'id' | 'defaultPage' | 'forkCount'>) {
  if (chat.defaultPage === 'notes') return `/e/${chat.id}/notes`;
  return chat.forkCount > 1 ? `/e/${chat.id}/map` : `/e/${chat.id}`;
}
