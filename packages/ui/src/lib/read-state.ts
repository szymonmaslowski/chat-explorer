import type { Fork, ForkRun, Message } from '@shared/types';

export type Attention = 'unread' | 'failed';

export const isUnread = (message: Message) =>
  message.role === 'assistant' && message.readAt === null;

// A stopped turn handled the fork's last message without answering it.
export function awaitsAnswer(fork: Fork, messages: Map<string, Message>, run: ForkRun | undefined) {
  const lastId = fork.tipMessageId ?? fork.baseMessageId;
  const last = lastId ? messages.get(lastId) : undefined;
  return last?.role === 'user' && last.id !== run?.handledUpTo;
}

// A fork needs the reader when Claude answered there unseen, or when Claude could not be
// started while the fork waits for an answer.
export function forkAttention(input: {
  forks: Map<string, Fork>;
  messages: Map<string, Message>;
  forkRuns: Map<string, ForkRun>;
  sessionError: string | null;
}) {
  const attention = new Map<string, Attention>();
  if (input.sessionError) {
    for (const fork of input.forks.values()) {
      if (awaitsAnswer(fork, input.messages, input.forkRuns.get(fork.id)))
        attention.set(fork.id, 'failed');
    }
  }
  for (const message of input.messages.values()) {
    if (isUnread(message) && !attention.has(message.forkId)) {
      attention.set(message.forkId, 'unread');
    }
  }
  return attention;
}
