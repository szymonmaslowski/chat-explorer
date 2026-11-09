import type { ClaudeModel } from '../shared/models.js';
import { supervisorMessagePrefix, type ChatStore } from './store.js';

// What a runner needs to start an engine for a fork: the model, the standing instructions, and for
// a fork without an engine session yet, the conversation it continues.
export interface RunContext {
  model: ClaudeModel;
  systemPrompt: string;
  // Put before the first messages of a new session; null when the session is resumed.
  history: string | null;
}

// The newest messages of a long fork go into a new session up to about this many characters; the
// rest is a pointer to read_fork.
export const historyBudget = 120_000;

// A final reply of only this is not posted: everything went out with the answer tool already.
export const noReply = '[no reply]';

export const systemPrompt = `You are Claude, answering in Chat Explorer: a chat app where the user reads your answers in a browser, selects text and comments on it, and branches the conversation into forks. You are working on one fork. Your final reply of each turn is posted in the fork as your answer.

How the user's messages look:
- A comment starts with its tag on its own line, [c:<commentId>], then the quoted text as a "> " block, then the comment on it.
- When a message has comments, its own text starts with [m:<messageId>].
- Attached files are listed with their paths; open them with the Read tool.
- A message that starts with ${supervisorMessagePrefix} comes from the Claude session answering the chat's main fork, which oversees the other forks for the user. Treat it like a message from the user.

How to answer:
- Start each part of your answer with the tags of what it answers, alone on their own line, for example [c:x7k2p9q4mz], or [c:x7k2p9q4mz] [m:q3ws8h2kd1] for a part that answers both. The page shows each tag as a card of the comment, so do not repeat the comment or quote it again. You may group and reorder parts. Copy the ids exactly. Messages without tags get an answer without tags.
- Answer every comment and message you were sent, in one reply.
- If a short question arrives while you work on something longer, answer it at once with the answer tool, then carry on. Your final reply then covers only what is left. When nothing is left, reply with exactly ${noReply}: it is not posted.
- Write markdown. Leave a blank line before every list and after a bold line that heads a section.

Tools:
- set_fork_summary: when you are told the fork is new, give it a summary under 60 characters of what it is about, before your final reply. Update it later only when the fork's topic changes.
- update_chat: in your first turn in a chat, and when its topic shifts, set a short title and a one-sentence summary. Do it before your final reply: nothing runs after it.
- Notes are kept beside the chat in groups. When the user asks you to note, save or remember something, use add_notes (after add_note_group when no group fits) and pass sourceMessageId, the id of their message. You cannot delete notes; request_note_deletion asks the user.
- list_forks and read_fork show the chat's other forks and older messages of this one.`;

const maxDigestLines = 30;

// What the chat's other forks are about, for an aware fork's new session. Each line has the fork's
// id, so the engine can read more with read_fork.
function othersDigest(store: ChatStore, forkId: string) {
  if (store.fork(forkId).awareness === 'separate') return null;
  const others = store.otherForks(forkId);
  if (others.length === 0) return null;
  const shown = others.slice(0, maxDigestLines);
  return [
    "The chat's other forks, for context only (answer from this fork; read one with read_fork if it matters):",
    ...shown.map(
      (fork) =>
        `- [${fork.forkId}] ${fork.summary}${fork.latestAnswer ? `. Latest answer: ${fork.latestAnswer}` : ''}`,
    ),
    ...(others.length > shown.length
      ? [`- and ${others.length - shown.length} more, see list_forks`]
      : []),
  ].join('\n');
}

export function buildRunContext(
  store: ChatStore,
  forkId: string,
  options: { resume: boolean; pendingIds: Set<string> },
): RunContext {
  const fork = store.readFork(forkId);
  const explorationId = store.forkExplorationId(forkId);
  const { model } = store.backgroundSession(explorationId);
  if (options.resume) return { model, systemPrompt, history: null };
  const answered = fork.messages.filter((message) => !options.pendingIds.has(message.id));
  const kept: typeof answered = [];
  let length = 0;
  for (const message of answered.toReversed()) {
    length += message.text.length;
    if (length > historyBudget && kept.length > 0) break;
    kept.unshift(message);
  }
  const omitted = answered.length - kept.length;
  const digest = othersDigest(store, forkId);
  const isNewFork = !fork.messages.some(
    (message) => message.forkId === forkId && message.role === 'assistant',
  );
  const intro = [
    `This is fork ${forkId} of chat ${explorationId}. Its conversation so far follows; the messages after it are new.`,
    ...(omitted > 0
      ? [
          `${omitted} earlier messages are left out; read them with read_fork (forkId ${forkId}, before ${kept[0]!.id}).`,
        ]
      : []),
    ...(isNewFork
      ? ['This fork is new: give it a summary with set_fork_summary once you know its topic.']
      : []),
    ...(digest ? ['', digest] : []),
  ];
  const messages = kept.map(
    (message) => `<message id="${message.id}" role="${message.role}">\n${message.text}\n</message>`,
  );
  return { model, systemPrompt, history: [intro.join('\n'), ...messages].join('\n\n') };
}
