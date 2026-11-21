import type { AnsweredPartLookup } from '@shared/answer-tags';
import type { Comment, ExplorationListItem, Fork, Message, MessageHead } from '@shared/types';
import type { ExplorationState } from '../stores/exploration';

export function pathTo(messageId: string | null, messages: Map<string, MessageHead>) {
  const path: MessageHead[] = [];
  let current = messageId ? messages.get(messageId) : undefined;
  while (current) {
    path.push(current);
    current = current.parentId ? messages.get(current.parentId) : undefined;
  }
  return path.reverse();
}

export function forkPath(fork: Fork, messages: Map<string, MessageHead>) {
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

export const commentLink = (comment: Comment) =>
  `/e/${comment.explorationId}/f/${comment.viewForkId}#c-${comment.id}`;

// A message with its text, kept per head and text, so a list holding it stays the same.
const withBodies = new WeakMap<MessageHead, Message>();
export function withBody(head: MessageHead, content: string) {
  const kept = withBodies.get(head);
  if (kept?.content === content) return kept;
  const { answers: _answers, ...fields } = head;
  const message: Message = { ...fields, content };
  withBodies.set(head, message);
  return message;
}

// What the user typed in the reply box shows as a sent comment under the message it replied to,
// like a general comment, so an answer's card of it has a place to go back to. The first message
// of a chat replies to nothing and has none. Kept per message, so a list holding it stays the same.
const sentMessageComments = new WeakMap<Message, Comment>();
// The sent card of a message carries the message's id, so the files sent with it show on it.
export const isSentMessageComment = (comment: Comment) => comment.id === comment.replyMessageId;
export function sentMessageComment(message: Message, viewForkId: string) {
  if (message.role !== 'user' || !message.content || !message.parentId) return null;
  const kept = sentMessageComments.get(message);
  if (kept?.viewForkId === viewForkId) return kept;
  const comment: Comment = {
    id: message.id,
    explorationId: message.explorationId,
    messageId: message.parentId,
    viewForkId,
    quote: '',
    startOffset: 0,
    endOffset: 0,
    body: message.content,
    editBody: null,
    type: 'inline',
    status: 'submitted',
    submissionId: null,
    replyMessageId: message.id,
    createdForkId: null,
    noteGroupId: null,
    createdNoteId: null,
    forkGroupId: null,
    draftedByForkId: null,
    boardColumnChoice: null,
    selected: true,
    createdAt: message.createdAt,
    updatedAt: message.createdAt,
  };
  sentMessageComments.set(message, comment);
  return comment;
}

// What the tags in an answer point at: a comment, linking to the text it quotes or to its card,
// or the text of a message, linking to its sent comment. It reads the chat when called, so an
// answer's markdown depends only on what its own tags name, and the lookup stays the same function
// while the chat changes.
export function answeredPartLookup(
  state: Pick<ExplorationState, 'comments' | 'messages' | 'bodies'>,
): AnsweredPartLookup {
  return (kind, id) => {
    if (kind === 'message') {
      const head = state.messages.get(id);
      if (!head) return null;
      const message = withBody(head, state.bodies.get(id) ?? '');
      const sent = sentMessageComment(message, message.forkId);
      return { quote: '', text: message.content, href: sent && commentLink(sent) };
    }
    const comment = state.comments.get(id);
    if (!comment) return null;
    return { quote: comment.quote, text: comment.body, href: commentLink(comment) };
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
