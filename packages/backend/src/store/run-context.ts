import { supervisorMessagePrefix, type ChatStore } from './store.js';
import { noReply, type RunContext } from '@chat-explorer/shared/protocol.js';
import type { RequestStore } from './requests.js';

// The newest messages of a long fork go into a new session up to about this many characters; the
// rest is a pointer to read_fork.
export const historyBudget = 120_000;

export const systemPrompt = `You are Claude, answering in Chat Explorer: a chat app where the user reads your answers in a browser, selects text and comments on it, and branches the conversation into forks. You are working on one fork. Your final reply of each turn is posted in the fork as your answer.

How the user's messages look:
- A comment starts with its tag on its own line, [c:<commentId>], then the quoted text as a "> " block, then the comment on it.
- When a message has comments, its own text starts with [m:<messageId>].
- Attached files are listed with their paths; open them with the Read tool.
- The page numbers your answers in this fork back from the newest: [0] is your newest answer when the user wrote, [-1] the one before it, and so on. The user may point to one as [-2] or as answer -2; count back over this fork's answers, with read_fork for older ones.
- A message that starts with ${supervisorMessagePrefix} comes from the Claude session answering the chat's main fork, which oversees the other forks for the user. Treat it like a message from the user.

How to answer:
- Start each part of your answer with the tags of what it answers, alone on their own line, for example [c:x7k2p9q4mz], or [c:x7k2p9q4mz] [m:q3ws8h2kd1] for a part that answers both. The page shows each tag as a card of the comment, so do not repeat the comment or quote it again. You may group and reorder parts. Copy the ids exactly. Messages without tags get an answer without tags.
- Answer every comment and message you were sent, in one reply.
- If a short question arrives while you work on something longer, answer it at once with the answer tool, then carry on. Your final reply then covers only what is left. When nothing is left, reply with exactly ${noReply}: it is not posted.
- Write markdown. Leave a blank line before every list and after a bold line that heads a section.

Tools:
- set_fork_summary: when you are told the fork is new, give it a summary under 60 characters of what it is about, before your final reply. Update it later only when the fork's topic changes.
- set_chat_summary: when you are told the chat has no title, and when its topic shifts, set a short title and a one-sentence summary. Do it before your final reply: nothing runs after it.
- Notes are kept beside the chat in groups. When the user asks you to note, save or remember something, use add_notes (after add_note_group when no group fits) and pass sourceMessageId, the id of their message.
- Writing notes (add_note_group, add_notes, update_note, change_note_group, rename_note_category, request_note_deletion) and arrange_board are requests: each waits for the user's approval on a card in this conversation, unless this fork's Autonomous setting lets it run at once; the result's status says which. The requests of one turn join one card. Say in your answer what you asked for, and don't assume it is done until you hear the outcome.
- set_note_topic writes the topic of a note that has none, such as one the user saved with only a description, without asking. It never changes a topic a note has.
- To read notes, start small: list_notes gives the index of topics, search_notes finds notes by their words, and read_notes gives the full text of the notes you chose. A link like #n-<noteId> in a note or message points at a note you can read by that id.
- list_forks and read_fork show the chat's other forks and older messages of this one.
- draft_comment drafts a comment in another fork, for the user to edit and send there; you can't send it. Use it, rather than asking the user to copy text over, when something belongs in another fork.`;

// For the main fork, when the user turned Coordination on.
export const coordinationPrompt = `Coordination: you are this chat's coordinator. Other forks do the work, and the user talks to them there; you plan with the user here and hand the work over.
- request_fork asks to start a fork with a title, a brief and settings. The brief is the fork's first message, written as the user would write it: what to do, and how to report. Turn coding on for work that needs a shell or a workspace, such as code or research with command-line tools, and allow only the hosts and registries it needs.
- request_message asks to send a fork a message; request_fork_settings asks to change a fork's settings.
- Each request waits for the user's approval on a card in this conversation; the user may edit it first. The tool returns at once, and the requests of one turn join one card, so ask for everything in one turn and say in your answer what you asked for. You learn the outcome at the start of your next turn; don't assume a fork exists or got your text until then.`;

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

const maxIndexNotes = 60;

// The chat's note topics by group, so the engine knows what is noted before reading any note.
function notesDigest(store: ChatStore, explorationId: string) {
  const { groups } = store.notesIndex(explorationId);
  const total = groups.reduce((count, group) => count + group.notes.length, 0);
  if (total === 0) return null;
  const lines = ["The chat's notes (read them with read_notes, find more with search_notes):"];
  let shown = 0;
  for (const group of groups) {
    if (group.notes.length === 0 || shown >= maxIndexNotes) continue;
    lines.push(`- ${group.name} [${group.id}]`);
    for (const note of group.notes.slice(0, maxIndexNotes - shown)) {
      lines.push(
        `  - [${note.id}] ${note.topic ?? '(no topic yet)'}${note.checked ? ' (ticked)' : ''}`,
      );
      shown += 1;
    }
  }
  if (total > shown) lines.push(`- and ${total - shown} more, see list_notes`);
  return lines.join('\n');
}

export function buildRunContext(
  store: ChatStore,
  forkId: string,
  options: { resume: boolean; pendingIds: Set<string>; requests?: RequestStore },
): RunContext {
  const fork = store.readFork(forkId);
  const explorationId = store.forkExplorationId(forkId);
  const model = store.forkModel(forkId);
  const { coding, network, parentForkId, coordination } = store.fork(forkId);
  const prompt =
    parentForkId === null && coordination
      ? `${systemPrompt}\n\n${coordinationPrompt}`
      : systemPrompt;
  if (options.resume) return { model, coding, network, systemPrompt: prompt, history: null };
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
  const notes = notesDigest(store, explorationId);
  const isNewFork =
    store.fork(forkId).needsSummary ||
    !fork.messages.some((message) => message.forkId === forkId && message.role === 'assistant');
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
    ...(store.chatTitle(explorationId).trim() === ''
      ? [
          'This chat has no title yet: set a title and summary with set_chat_summary before your final reply.',
        ]
      : []),
    ...(digest ? ['', digest] : []),
    ...(notes ? ['', notes] : []),
  ];
  // Each request shows after the message it was asked under, with how it was decided.
  const records = options.requests?.historyRecords(forkId) ?? [];
  options.requests?.markReported(forkId);
  const keptIds = new Set(kept.map((message) => message.id));
  const recordsAfter = (messageId: string | null) =>
    records
      .filter((record) => record.afterMessageId === messageId)
      .map((record) => `<requests>\n${record.text}\n</requests>`);
  const messages = [
    ...records
      .filter((record) => record.afterMessageId === null || !keptIds.has(record.afterMessageId))
      .map((record) => `<requests>\n${record.text}\n</requests>`),
    ...kept.flatMap((message) => [
      `<message id="${message.id}" role="${message.role}">\n${message.text}\n</message>`,
      ...recordsAfter(message.id),
    ]),
  ];
  return {
    model,
    coding,
    network,
    systemPrompt: prompt,
    history: [intro.join('\n'), ...messages].join('\n\n'),
  };
}
