import type { Fork, ForkRun, MessageHead } from '@shared/types';

export type Attention = 'unread';

export const isUnread = (message: Pick<MessageHead, 'role' | 'readAt'>) =>
  message.role === 'assistant' && message.readAt === null;

// A stopped turn handled the fork's last message without answering it.
export function awaitsAnswer(
  fork: Fork,
  messages: Map<string, MessageHead>,
  run: ForkRun | undefined,
) {
  const lastId = fork.tipMessageId ?? fork.baseMessageId;
  const last = lastId ? messages.get(lastId) : undefined;
  return last?.role === 'user' && last.id !== run?.handledUpTo;
}

// A fork needs the reader when Claude answered there unseen.
export function forkAttention(input: {
  forks: Map<string, Fork>;
  messages: Map<string, MessageHead>;
  forkRuns: Map<string, ForkRun>;
}) {
  const attention = new Map<string, Attention>();
  for (const message of input.messages.values()) {
    if (isUnread(message) && !attention.has(message.forkId)) {
      attention.set(message.forkId, 'unread');
    }
  }
  return attention;
}
