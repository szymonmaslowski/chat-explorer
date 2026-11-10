---
name: explore-chat
description: Explore this conversation as a tree of forks in the browser with chat-explorer. The user comments on answers there and Claude answers there.
argument-hint: '[exploration id]'
disable-model-invocation: true
allowed-tools: Bash(chat-explorer start), mcp__plugin_chat-explorer_chat-explorer__*
---

# Explore chat

You are running chat-explorer for this Claude Code session (session id `${CLAUDE_SESSION_ID}`). The user reads the conversation in a browser, selects text, and comments on it. Each comment either continues the current fork or starts a new fork. You answer in the browser through the chat-explorer tools, not in the terminal.

Argument: `$ARGUMENTS` (an exploration id, or empty).

## Start

1. Run `chat-explorer start`. If the command is not found or you cannot run shell commands, skip this step: the chat-explorer MCP server starts the daemon itself.
2. Without an argument: call `start_exploration` with `sessionId: "${CLAUDE_SESSION_ID}"`. It imports this conversation so far and opens it in the browser.
   With an argument: call `attach_exploration` with that id and the same `sessionId`. If it fails because another session is attached, ask the user whether to take it over, and if yes call it again with `takeover: true`. In a non-interactive session (`claude -p`), where nobody can answer, stop instead.
3. Tell the user in one line that the exploration is open, with its URL.

## Loop

Repeat until the user interrupts you in the terminal:

1. Call `await_feedback`.
   - `timeout`: call it again at once. Never end your turn on a timeout: the user may write at any moment, and their messages wait until you call it.
   - `detached` (another session took over) or `deleted`: tell the user in one line and stop.
   - `feedback`: answer every fork in `forks`, as below, and write a topic for every note in `notesNeedingTopic` (see Notes). Either list may be empty.
2. For each fork in `forks`:
   - `userMessages` is what the user wrote. A quoted block (`> ...`) is text the user selected, and the line after it is their comment on that text. Answer all comments and messages of the fork in one reply.
   - Each comment starts with a tag on its own line, `[c:<commentId>]`. When a message has comments, its own text starts with `[m:<messageId>]`. Start each part of your answer with the tags of what it answers, alone on their own line, for example `[c:x7k2p9q4mz]`, or `[c:x7k2p9q4mz] [m:q3ws8h2kd1]` for a part that answers both. The page shows each tag as a card of the comment, so do not repeat the comment or quote it again. You may group and reorder parts. Copy the ids exactly. Messages without tags get an answer without tags.
   - Answer only from that fork's own conversation, never from what was said in other forks. The newest message in your context may belong to another fork: `repliesTo` gives the start of the message the user answered, so read their words against that message.
   - Call `read_fork` first when the fork is not the one you answered last, when it is new, or after compaction or attaching. Skip it only when you answered this same fork last.
   - Each fork you get is held for you until you answer it; the app's own runner leaves it alone meanwhile. A fork you did not answer comes back in the next `await_feedback`.
   - Call `add_message` with the fork's `forkId`, its `inReplyTo`, and your answer in markdown. Leave a blank line before every list and after a bold line that heads a section; the daemon adds missing ones, but only for the common cases.
   - For a new fork (`isNewFork: true`), call `update_fork` with a summary under 60 characters of what the fork is about. For an existing fork, update the summary only when its topic changed.
3. After your first answer, and whenever the topic shifts, call `update_exploration` with a short title and a one-sentence summary.
4. Print one short status line in the terminal, such as "Answered main and 1 new fork." Do not repeat the answers in the terminal.

## While you work

A plugin hook runs after each of your tool calls. It shows the call, and the short lines you write in the terminal between steps, as steps under the fork you are answering, so the user sees progress. Before a long stretch of work, write one such line saying what you are about to do.

The same hook hands you messages the user sends meanwhile, as context after a tool call. Take them into account at once: answer them with the rest, using the fork's newest `inReplyTo` from that context, or answer right away with `add_message` if they are quick or change your work, then carry on.

## Other forks

While the app's runner is online, you answer only the chat's main fork, and the runner answers every other fork in its own Docker session. Without a runner you get all forks. You oversee the forks the runner answers:

- `get_map` shows each fork's `run`: whether you hold it (`heldByTerminal`), its status (`idle`, `answering`, `waiting_limit`, `failed`), model and context use. Read a fork with `read_fork`.
- `stop_fork` stops a runner's turn, `retry_fork` lets the runner try a failed fork again.
- `message_fork` sends a fork a message marked as coming from the main fork; its runner reads it like a message from the user, also mid-turn.

Use them when the user asks about or for the other forks. Forks the runner answers cannot touch the code or this machine, so code changes happen in the main fork.

## Notes

Each exploration keeps notes beside the chat, on its Notes page: groups of notes, each with a short topic and a markdown description. In a checklist group the user ticks notes off, as on a shopping list. `await_feedback` returns `notes`, the group names and note topics; call `list_notes` for the descriptions.

- When the user asks you to note, save or remember something ("add it to notes", "make a shopping list group from this image"), call `add_notes`, after `add_note_group` when no group fits. Pass the fork's `inReplyTo` as `sourceMessageId`, so each note links back to the request. Then answer in the fork as usual and say what you added.
- When a note you write mentions another note or relates to one, link it in the description with a markdown link to the note's id: `[Its topic](#n-<noteId>)`. The Notes page opens that note's group and selects it. Notes added in one `add_notes` call get their ids only from its result, so link them to each other afterwards with `update_note`. In a chat answer, link a note as `[Its topic](/e/<explorationId>/notes#n-<noteId>)`.
- The user may mention a note by its id (ten characters, copied from the Notes page). Find it with `list_notes`.
- `notesNeedingTopic` lists notes the user saved without a topic. For each, call `update_note` with a topic under 60 characters drawn from its description. Do it even when `forks` is empty, then call `await_feedback` again.
- Edit, tick, reorder or move notes with `update_note`, `reorder_note` and `change_note_group` when the user asks.
- You cannot delete a note. `request_note_deletion` asks the user, who deletes or keeps it on the Notes page. Say in your answer that you asked.
