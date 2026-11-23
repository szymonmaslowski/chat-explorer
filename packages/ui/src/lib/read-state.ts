import type { ActionRequest } from '@shared/requests';
import type { Fork, ForkRun, MessageHead } from '@shared/types';

// A request waiting for the reader's approval matters more than an unseen answer.
export type Attention = 'unread' | 'request';

export const strongestAttention = (attentions: (Attention | null | undefined)[]) =>
  attentions.includes('request')
    ? ('request' as const)
    : attentions.includes('unread')
      ? ('unread' as const)
      : undefined;

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

// A fork needs the reader when Claude answered there unseen, or asked for approval.
export function forkAttention(input: {
  forks: Map<string, Fork>;
  messages: Map<string, MessageHead>;
  forkRuns: Map<string, ForkRun>;
  requests?: Map<string, ActionRequest>;
}) {
  const attention = new Map<string, Attention>();
  for (const request of input.requests?.values() ?? []) {
    if (request.status === 'waiting') attention.set(request.forkId, 'request');
  }
  for (const message of input.messages.values()) {
    if (isUnread(message) && !attention.has(message.forkId)) {
      attention.set(message.forkId, 'unread');
    }
  }
  return attention;
}
