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

1. Run `chat-explorer start`. If the command is not found, skip this step: the chat-explorer MCP server starts the daemon itself.
2. Without an argument: call `start_exploration` with `sessionId: "${CLAUDE_SESSION_ID}"`. It imports this conversation so far and opens it in the browser.
   With an argument: call `attach_exploration` with that id and the same `sessionId`. If it fails because another session is attached, ask the user whether to take it over, and if yes call it again with `takeover: true`.
3. Tell the user in one line that the exploration is open, with its URL.

## Loop

Repeat until the user interrupts you in the terminal:

1. Call `await_feedback`.
   - `timeout`: call it again.
   - `detached` (another session took over) or `deleted`: tell the user in one line and stop.
   - `feedback`: answer every fork in `forks`, as below.
2. For each fork in `forks`:
   - `userMessages` is what the user wrote. A quoted block (`> ...`) is text the user selected, and the line after it is their comment on that text. Answer all comments and messages of the fork in one reply.
   - Answer only from that fork's own conversation, never from what was said in other forks. If you are not sure what the fork contains (a new fork, after compaction, after attaching), call `read_fork` first.
   - Call `add_message` with the fork's `forkId`, its `inReplyTo`, and your answer in markdown.
   - For a new fork (`isNewFork: true`), call `update_fork` with a summary under 60 characters of what the fork is about. For an existing fork, update the summary only when its topic changed.
3. After your first answer, and whenever the topic shifts, call `update_exploration` with a short title and a one-sentence summary.
4. Print one short status line in the terminal, such as "Answered main and 1 new fork." Do not repeat the answers in the terminal.
