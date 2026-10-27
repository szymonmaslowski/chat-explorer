# chat-explorer: v1 plan

## Goal

A browser UI for exploring a Claude Code conversation as a tree. You select text in an answer and comment on it. An inline comment continues the current branch. A fork comment starts a new branch. Claude answers in the UI, not in the terminal, and one Claude Code session serves every branch. Explorations are stored, so you can list them, reopen them and continue them from a new session later.

## Settled decisions

- Target: Claude Code only (CLI and the Desktop Code tab). Regular Desktop chat comes later.
- Packaging: a Claude Code plugin (`/explore-chat` skill, MCP server, hooks) plus a global npm package `chat-explorer` that holds the daemon, the CLI and the built UI.
- The server owns the data. Claude sends only new content through MCP tools.
- Claude waits for your input with a blocking `await_feedback` tool call.
- An exploration has its own id, separate from Claude's session id. One session is attached for writing at a time. Any session can read any exploration.
- `/explore-chat` imports the current conversation from the session's JSONL transcript. `/explore-chat <id>` attaches to an existing exploration.
- Mixed submit: each fork comment creates a new fork. Inline comments and the global message become one user reply in the current fork. The global message does not go to new forks.
- Only draft comments can be edited or deleted. Submitted comments stay anchored, are no longer sticky, and link to the reply or fork they produced.
- A comment shows only in the fork view it was made in, even when its anchor is in history that other forks share.
- Forks are soft (one shared context) in v1. Hard forks (one subagent per fork) come later, so `forks.kind` exists from the start.
- Navigation uses real URLs and browser history. `[` and `]` go back and forward.
- Stack: TypeScript everywhere. Server on Node 22.13+ with Hono, `node:sqlite` and SSE. UI on Vue 3 (Composition API, `<script setup>`), Vite and Vue Router, with a plain reactive store.
- UI details: the fade-restore delay is 1.5 s. "Fork all" is a toggle and does not affect comments added later. More than 3 sticky comments collapse into a "+N" pill.

## Changes from the earlier chat

- **One database file, not one per exploration.** `chat-explorer list` and the explorations page then need one query instead of opening every file. Deleting an exploration is a `DELETE ... WHERE exploration_id = ?`.
- **The server creates user messages and forks, when Claude picks up a submission.** It already has every comment and the global message, so it writes the user reply and the new forks itself. Claude only writes answers. The `create_fork` tool goes away and `add_messages` becomes `add_message(forkId, inReplyTo, content)`.
- **`/e/<id>` opens the main branch, and the map moves to `/e/<id>/map`.** With one branch, a map with one box is a wasted click.

## Architecture

```
Claude Code session
  ├─ plugin: /explore-chat skill, hooks
  └─ MCP shim (stdio: `chat-explorer mcp`) ──HTTP──┐
                                                   ▼
             chat-explorer daemon (127.0.0.1:4517)
               ├─ SQLite: ~/.chat-explorer/chat-explorer.db
               ├─ REST + SSE: /api/...
               └─ static Vue UI ◀── browser (SSE in, POST out)
                                                   ▲
CLI: chat-explorer start|stop|status|list|open|delete ──HTTP──┘
```

- **Daemon.** One process per machine, bound to 127.0.0.1 only. It serves the UI, the REST API and SSE streams, and owns the SQLite file.
- **MCP shim.** Claude Code starts it over stdio with each session, so the tools exist from the first turn. Before its first call it ensures the daemon is running (same code as `chat-explorer start`), then turns each tool call into an HTTP request. It lives exactly as long as the Claude session, and sends a heartbeat to the daemon every 15 s.
- **CLI.** Same package. `start` is idempotent.
- **UI.** Static files built by Vite and served by the daemon. It loads a snapshot over REST, then applies SSE events.
- The shim, the CLI and every printed URL use `127.0.0.1`, never `localhost`. Node's `fetch` can resolve `localhost` to `::1` first and get ECONNREFUSED, since the daemon listens on IPv4 only.

## Daemon lifecycle

- Port 4517 by default, overridable with `CHAT_EXPLORER_PORT`.
- Data directory `~/.chat-explorer/` (overridable with `CHAT_EXPLORER_HOME`): `chat-explorer.db`, `daemon.log`.
- `GET /api/health` returns `{ name: "chat-explorer", version, apiVersion, pid }`.
- `start`:
  1. Calls health. If it answers with the same version, print the URL and exit 0.
  2. If the daemon is older (semver compare), call `POST /api/shutdown`, wait for the port to free up, then continue.
  3. If the daemon is newer, use it when `apiVersion` matches. Otherwise fail with "chat-explorer was upgraded: restart this Claude session". This stops a session started before an upgrade from downgrading the daemon, and the next new session from flipping it back.
  4. If something that is not chat-explorer answers on the port, fail with a clear message naming the port and the env var.
  5. Spawn the daemon detached, with output to `daemon.log`, and poll health for up to 5 s.
- Two sessions starting at once: binding the port is the lock. The loser gets `EADDRINUSE`, exits, and its `start` sees a healthy daemon on the next poll. No pidfile needed.
- Requests whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` are rejected, and so are cross-origin POSTs. This stops other websites open in your browser from posting feedback to the daemon.
- `node:sqlite` prints an ExperimentalWarning to stderr. The entry points filter it out so CLI output stays clean.

## Data model

All ids are short random strings (10 characters, nanoid alphabet), so they are easy to type in `/explore-chat <id>`.

```sql
explorations (
  id TEXT PRIMARY KEY,
  title TEXT, summary TEXT,
  created_at, updated_at,
  attached_session_id TEXT,      -- Claude session id currently writing, or NULL
  attached_shim_id TEXT,         -- shim process instance
  attached_seen_at               -- last heartbeat
)

forks (
  id TEXT PRIMARY KEY,
  exploration_id, parent_fork_id, -- NULL for main
  base_message_id,                -- message this fork branches from, NULL for main
  origin_comment_id,              -- the fork comment that created it
  tip_message_id,                 -- newest message, updated in the same transaction as each insert
  kind TEXT DEFAULT 'soft',       -- 'soft' | 'hard'
  summary TEXT,
  created_at, updated_at
)

messages (
  id TEXT PRIMARY KEY,
  exploration_id, fork_id,
  parent_id,                      -- previous message on the path, NULL for the first one
  role TEXT,                      -- 'user' | 'assistant'
  content TEXT,                   -- markdown
  source TEXT,                    -- 'import' | 'live'
  created_at
)

comments (
  id TEXT PRIMARY KEY,
  exploration_id,
  message_id,                     -- message the selected text is in
  view_fork_id,                   -- fork view it was made in, and the only one it shows in
  quote TEXT, start_offset, end_offset,
  body TEXT,
  type TEXT,                      -- 'inline' | 'fork'
  status TEXT,                    -- 'draft' | 'queued' | 'submitted'
  submission_id, reply_message_id, created_fork_id,
  created_at, updated_at
)

submissions (
  id TEXT PRIMARY KEY,
  exploration_id, fork_id,        -- fork the reply box belonged to
  global_message TEXT,
  status TEXT,                    -- 'queued' | 'delivered'
  created_at, delivered_at
)
```

- A message's path is the walk from it up through `parent_id`. A fork's path is the path of `tip_message_id`. The fork view renders that path, so it shows the shared history before the fork and the fork's own messages.
- The first message of a new fork has `parent_id = base_message_id`. Its `parent_fork_id` is the fork that owns the base message, which can be an ancestor of the fork you were viewing.
- A fork is **awaiting an answer** when its tip is a user message: one lookup through `tip_message_id`. If a session dies after receiving feedback but before answering, the next `await_feedback` returns those forks again.
- Import writes many messages in the same millisecond, so the tip is never derived from `created_at`.

## Submission lifecycle

```
draft ──submit──▶ queued ──await_feedback picks it up──▶ submitted
                    │
                    └──cancel──▶ draft (comments) + reply bar (global message)
```

A submit does not create messages or forks. It queues them, and the server turns them into messages and forks when Claude is ready for them. This keeps answers in the right place: while Claude answers user message U1 in fork F, a second submit to F waits in the queue instead of appending U2, so the answer to U1 can't land after U2.

- **Submit** (`POST /api/explorations/:id/submit` with `{ forkId, globalMessage? }`) creates a queued submission and moves every draft in that fork view to `queued`.
- **Delivery** happens when `await_feedback` runs. In one transaction, all queued submissions become:
  - one user message per target fork, merging every queued submission for that fork in submit order: the quoted comments first, then the global messages joined with blank lines. Each comment gets `reply_message_id`;
  - one new fork per fork comment. Its first message is a user message whose `parent_id` is the commented message and whose content is the comment body. The comment gets `created_fork_id`. The fork summary starts as the first 80 characters of the comment until Claude writes one.

  Comments move to `submitted`, submissions to `delivered`, and SSE broadcasts the new messages, forks and comment changes.
- **Cancel** (`DELETE /api/submissions/:id`) works only while the submission is queued, and applies to the whole submission. Its comments go back to `draft`. Its global message goes back into the reply bar, before any text already there, separated by a blank line. The cancel checks the status inside a transaction, so a cancel that races a delivery gets 409 and the UI shows "already sent". To drop one comment: cancel, delete that draft, submit again.
- If Claude is listening, a submit is delivered at once and there is nothing to cancel. The queue matters while Claude is answering or when no session is attached.
- A fork can still be awaiting an answer at delivery (Claude skipped it after an error or interruption). The new submission is delivered anyway, as a second user message in a row. `await_feedback` returns every unanswered user message of that fork, and Claude answers them in one message.

Example: 2 fork comments, 3 inline comments and a global message become 2 new forks plus one reply in the current fork that holds the 3 quoted comments and the message. Claude then answers three times, once per affected fork.

When Claude reads a user message, the server writes the quoted comments as markdown:

```
> quoted text
comment body

> another quote
another comment

global message
```

## MCP tools

| Tool | Input | Returns |
|---|---|---|
| `start_exploration` | `sessionId`, `transcriptPath?`, `title?` | `explorationId`, `mainForkId`, `url`. Imports the transcript, attaches this session and opens the browser. Without `transcriptPath`, the daemon looks for `~/.claude/projects/*/<sessionId>.jsonl`. |
| `attach_exploration` | `explorationId`, `sessionId`, `takeover?` | The map (as `get_map`). Fails if another live session is attached, unless `takeover` is true. |
| `list_explorations` | none | id, title, summary, fork count, updated time. |
| `get_map` | `explorationId?` (defaults to the attached one) | Fork tree: id, parent, summary, kind, message count, `awaitingAnswer`. No message bodies. |
| `read_fork` | `forkId`, `limit?` | Path from root to the fork's tip. With `limit`, the newest `limit` messages plus the summaries of the forks the older part passes through. |
| `add_message` | `forkId`, `inReplyTo`, `content` | `messageId`. Appends an assistant message to the fork's tip. Fails unless `inReplyTo` is the current tip. With the queue this never happens, so a failure points to a bug. Only for the attached exploration. Unknown fork, or one from another exploration, is an error. |
| `update_fork` | `forkId`, `summary` | ok |
| `update_exploration` | `title?`, `summary?` | ok |
| `await_feedback` | `timeoutSeconds?` | Delivers the queued submissions, then returns every fork awaiting an answer with its unanswered user messages (quoted comments, global messages; for a new fork also the base message id, quote and comment). Returns at once if there are any, otherwise waits. Other results: `{ status: "timeout" }` (call again), `{ status: "detached" }` (another session took over), `{ status: "deleted" }`. |

- `await_feedback` timeout: the plugin's `.mcp.json` sets `"timeout": 86400000` (24 h) on the server, and `await_feedback` defaults to 23 h, so it returns before Claude Code cuts it off. Phase 0 confirmed that the per-server `timeout` overrides `MCP_TOOL_TIMEOUT`, and users don't need to set anything. An open call costs nothing. Each timeout costs a new API request that carries the whole conversation, usually after the prompt cache has expired. A 30-minute timeout over 4 idle hours with a 100k-token conversation costs about 1M input tokens; a 24-hour one costs nothing. Node's `fetch` gives up waiting for response headers after 300 s, so the shim long-polls the daemon in 4-minute rounds inside one MCP call.
- Because waiting state lives in the messages, a lost `await_feedback` response does no harm: the next call returns the same forks. The shim still aborts its HTTP request on `notifications/cancelled` (Esc).
- Attachment: one live shim per exploration. A shim is live while its heartbeats arrive (every 15 s, stale after 45 s). A stale attachment is freed on the next attach.
- Takeover and delete: the old session's open `await_feedback` returns `detached` or `deleted`, and its other write tools fail with the same status.
- `sessionId` lets the compaction hook find the exploration attached to a session.

## The `/explore-chat` skill

Lives in the plugin as `skills/explore-chat/SKILL.md`, so `/explore-chat [id]` works as a command.

1. Run `chat-explorer start`. The shim starts the daemon anyway. This step is kept on purpose so the skill also works when its steps are run by hand. The skill's `allowed-tools` frontmatter allows `Bash(chat-explorer start)`, so the step never stops at a permission prompt.
2. Without an id: call `start_exploration` with the session id (see "Getting the session id" below). With an id: call `attach_exploration`. If another session holds it, ask the user whether to take over.
3. Loop:
   1. Call `await_feedback`. On timeout, call it again. On `detached` or `deleted`, tell the user and leave the loop.
   2. For each affected fork, answer from that fork's own path. Do not use what you know from other forks. After compaction, or when attaching to an existing exploration, call `read_fork` first.
   3. Write the answer with `add_message`, passing the fork's last user message as `inReplyTo`. Several unanswered user messages get one answer. Write the answer only there, and print one status line in the terminal ("answered fork 3fk… and main").
   4. Set the summary of each new fork with `update_fork`. Update an existing fork's summary when its direction changes.
   5. Update the exploration title and summary after the first answer and when the topic shifts.
4. Leave the loop when the user interrupts with Esc and types something in the terminal.

### Getting the session id

The skill passes `${CLAUDE_SESSION_ID}`, which Claude Code substitutes in plugin skills (confirmed in phase 0). The daemon finds the transcript from the id. No `UserPromptSubmit` hook is needed.

### After compaction

A plugin `SessionStart` hook with matcher `compact` runs `chat-explorer hook post-compact`. It asks the daemon which exploration is attached to that `session_id` and prints a reminder: "You are attached to exploration X. Call get_map, then read_fork before answering, and continue the await_feedback loop."

## Transcript import

The transcript is `~/.claude/projects/<project>/<sessionId>.jsonl`, one JSON record per line. Records seen in this project's transcript: `user`, `assistant`, `attachment`, `system`, `mode`, `permission-mode`, `last-prompt`, `ai-title`, `file-history-snapshot`, `tools-used` and `api-request*`. `user`, `assistant`, `attachment` and `system` records have `uuid` and `parentUuid` and form one chain. Subagent transcripts live in separate files (`<sessionId>/subagents/`), not in the main file.

Rules:

1. Start at the last record with a `uuid` and walk `parentUuid` back to the root, through records of every type. A rewind appends the new branch at the end of the file, so this keeps the branch you are on and drops abandoned ones. (`last-prompt.leafUuid` points at the last completed turn, so it misses the turn that runs `/explore-chat`.) Everything from the `/explore-chat` invocation onwards is dropped.
2. At a `compact_boundary` system record (`parentUuid: null`), continue through its `logicalParentUuid`, so history before a `/compact` is kept.
3. Skip `isSidechain` records (subagents).
4. Keep user records whose content is text you typed: a string, or `text` blocks (an `image` block becomes `[image]`). Skip records with `tool_result` blocks, `isMeta` records (skill bodies, caveats), `isCompactSummary` records, task notifications (`origin.kind: "task-notification"` or `<task-notification>`), and anything that starts with `<command-name>`, `<command-message>`, `<local-command-stdout>`, `<local-command-caveat>` or `<system-reminder>`. Slash commands, `/explore-chat` included, are dropped this way.
5. Keep `attachment` records of type `queued_command` with `commandMode: "prompt"`. They hold messages you typed while Claude was working.
6. Keep the `text` blocks of assistant records. Skip `thinking` and `tool_use`. Join consecutive assistant text from one turn into one message.
7. Everything lands on the main fork with `source = 'import'`. Use `ai-title` as the starting title if there is one.

The parser is tested against synthetic fixtures with the same record shapes as real transcripts. Real transcripts hold private content, so they stay out of the repo.

## REST and SSE

- `GET /api/health`, `POST /api/shutdown`
- `GET /api/explorations`, `GET /api/explorations/:id` (snapshot: exploration, forks, messages, comments, queued submissions, session status), `DELETE /api/explorations/:id`
- `POST /api/explorations/:id/comments`, `PATCH /api/comments/:id` (body or type, drafts only), `DELETE /api/comments/:id` (drafts only), `POST /api/explorations/:id/comments/fork-all` (`{ forkId }`)
- `POST /api/explorations/:id/submit`, `DELETE /api/submissions/:id` (cancel)
- `GET /api/explorations/:id/events`: SSE with `message.added`, `fork.created`, `fork.updated`, `comment.created`, `comment.updated`, `comment.deleted`, `submission.queued`, `submission.cancelled`, `submission.delivered`, `exploration.updated`, `session.status`
- Internal routes for the shim: attach, heartbeat, add message, update fork or exploration, and a long-poll for feedback

On SSE reconnect the UI loads the snapshot again rather than replaying missed events. The snapshot is small and this avoids an event log.

## UI

### Routes

- `/`: explorations list (title, summary, forks, updated time)
- `/e/:id`: main branch view
- `/e/:id/f/:forkId`: fork view (same component as the branch view)
- `/e/:id/map`: forks map
- `#m-<messageId>`: scroll to a message and flash it

Vue Router's `scrollBehavior` restores the saved position on back and forward, after the snapshot has loaded. Opening a fork any other way, for example from the map, starts at its end. `[` and `]` call `history.back()` and `history.forward()`, and are ignored while focus is in a text field.

### Branch and fork view

- Messages rendered from markdown with markdown-it, raw HTML off. Messages before the fork point are slightly muted, with a divider line: "forked from <parent fork summary>", linking to the parent fork.
- A status bar shows the session state: "Claude is listening", "Claude is answering", "Session attached, not listening" (the loop was left with Esc), or "No session attached: run `/explore-chat <id>`". You can submit with no session attached. The submission waits in the queue.
- A queued submission shows as a card at the end of the view: "Queued, sent when Claude is free", with Cancel.
- Forks awaiting an answer show an "answering…" placeholder at the end.
- Only comments made in this fork view are shown, including ones anchored in shared history.

### Commenting

- Text selection works the way it does on the plan-review page. On mouseup with a selection inside one message, a comment button appears next to it. The selection stays, so you can still copy it. `mousedown` on the button calls `preventDefault` to keep the selection.
- Clicking the button opens an editor above the selected text. Saving creates a draft through the API, so drafts survive reloads.
- Anchor: `message_id`, plus start and end offsets in the message element's text, plus the quote. On render, the offsets are checked against the quote. If they don't match, the UI searches for the quote. Highlights use the CSS Custom Highlight API, which does not change the DOM that Vue manages.
- Comment card: quote snippet, body, fork toggle, edit and delete. Inline comments are indigo and fork comments are amber, on both the card and the text highlight.
- Queued comments keep the draft colours but can't be edited or deleted. Cancel the submission first.

### Fading

- Opacity follows the cursor's distance from the card: 1 beyond 80 px, falling linearly to 0.2 at the card's edge.
- A faded card has `pointer-events: none`, so you can select the text underneath.
- Keeping the cursor inside the card's area for 1.5 s restores full opacity until the cursor leaves. The hold is measured from cursor position, so it works without pointer events.

### Sticky drafts

- When a draft's anchor scrolls above the viewport, its card moves to a tray pinned at the top.
- The tray shows up to 3 cards. The rest collapse into a "+N" pill that expands the tray when clicked.
- Clicking a tray card scrolls to its anchor.

### Reply bar

- Textarea for the global message. Submit with the button or Cmd+Enter.
- Shows what will be sent ("2 forks, 3 comments, message"). Submit is disabled when there are no drafts and the message is empty.
- "Fork all" toggle: if every draft is fork-type, it turns them all inline. Otherwise it turns them all fork-type. Disabled with no drafts. New drafts are always created inline.
- After a submit, the view scrolls to the bottom so the queued card or the new message is visible.
- When an answer arrives in the open fork and you are near the bottom, the view scrolls to the start of the answer. Further up, it stays where you are reading.

### Submitted comments

- Stay anchored in muted colours, never in the tray, and cannot be edited.
- Clicking an inline comment scrolls to the reply message that holds it and flashes it. Clicking a fork comment opens that fork.
- In the reply message, each quoted comment links back to its anchor.

### Map view

- A top-down tree: d3-hierarchy computes the layout and SVG draws the edges. The boxes are Vue components.
- Each box shows the summary, message count and an "awaiting answer" mark. The current fork is highlighted. Clicking a box opens that fork view.

## CLI

```
chat-explorer start            start the daemon if needed, print the URL
chat-explorer stop
chat-explorer status           running or not, version, port, attached sessions
chat-explorer list [--json]    id, title, summary, forks, updated
chat-explorer open [id] [--fork <forkId>]
chat-explorer delete <id>
chat-explorer mcp              stdio MCP shim (used by the plugin)
chat-explorer hook <name>      hook handlers (used by the plugin)
```

`open` and `list` start the daemon if it isn't running.

## Repo layout

```
ai-chat-explorer/
  package.json, pnpm-workspace.yaml, tsconfig.base.json
  packages/
    server/        daemon, CLI, MCP shim, hooks; published as `chat-explorer`
      src/db/      schema, migrations, queries
      src/api/     REST + SSE routes
      src/mcp/     shim and tool definitions
      src/import/  transcript parser
      src/cli/
    ui/            Vue app; its build output is copied into server/dist/ui
  plugin/
    .claude-plugin/plugin.json
    skills/explore-chat/SKILL.md
    hooks/hooks.json
    .mcp.json      runs `chat-explorer mcp`
  .claude-plugin/marketplace.json   lets `/plugin marketplace add <repo path>` install the plugin
  docs/plan.md
```

Development setup: `pnpm link --global` in `packages/server`, then `/plugin marketplace add ~/projects/private/ai-chat-explorer` and `/plugin install chat-explorer`.

## Build phases

### 0. Checks before building

1. A blocking MCP tool call in Claude Code 2.1.x: the real `MCP_TOOL_TIMEOUT` default, whether users need to raise it, and whether Esc cancels the call cleanly. This sets the `await_feedback` timeout.
2. Does `${CLAUDE_SESSION_ID}` work in a plugin skill? If not, does the `UserPromptSubmit` hook see the raw `/explore-chat` prompt, with `session_id` and `transcript_path`?
3. `SessionStart` with matcher `compact`: does its `additionalContext` reach the model?
4. Transcript format on real files, including one with a rewind, one with subagents and one with a `/compact`.

Findings (Claude Code 2.1.311):

1. The per-server `timeout` in the MCP config and `MCP_TOOL_TIMEOUT` are both honoured as hard limits ("timed out after 5s" with a 5 s setting and a 10 s call). The binary also has a 30-minute idle limit for stdio servers, but it never fired in tests, and the per-server `timeout` raises it too. Decision: 24 h server timeout, 23 h `await_feedback` default. The Esc check needs an interactive session and moves to phase 6.
2. `${CLAUDE_SESSION_ID}` is substituted in plugin skills: the skill printed the same id as the session. The `UserPromptSubmit` fallback is dropped.
3. A `SessionStart` hook with matcher `compact` that prints `additionalContext` reaches the model: after `/compact`, the model repeated a codeword that only the hook output contained.
4. Transcripts: 91 local files. `compact_boundary` has `parentUuid: null` and `logicalParentUuid`. Subagents are in separate files, so the main file has no `isSidechain` records (the parser still skips them). Messages typed while Claude works are `attachment` records of type `queued_command`. A slash skill shows up as a `<command-message>`/`<command-name>` user record followed by an `isMeta` record with the skill body. The import rules above include all of this.

### 1. Scaffold

pnpm workspace, strict TypeScript, Vitest, Prettier, build scripts. Done when `pnpm build` produces the server with the UI inside.

### 2. Server core

Schema and migrations, queries, the submission queue (submit, delivery, cancel), REST, SSE, health and shutdown, static serving, host and origin checks. A seed script creates a sample exploration so UI work can start without Claude. Done when unit tests cover queueing and merged delivery, a cancel racing a delivery, the `inReplyTo` check, path building, `awaitingAnswer` and the delete cascade.

### 3. CLI and daemon lifecycle

`start`, `stop`, `status`, `list`, `open`, `delete`, with version handling (replace older, reuse newer with a matching `apiVersion`). Done when two `start` calls fired at the same moment leave one daemon running, an older daemon is replaced and a newer one is left alone.

### 4. MCP shim

The tools, attachment with heartbeats, the long-poll and the `detached` / `deleted` results. Done when a test MCP client runs the loop end to end against a real daemon.

### 5. Transcript import

Parser plus fixtures. Done when the fixtures import with the expected messages, with no tool noise and with history from before a `/compact`.

### 6. Thin end-to-end slice

Minimal plugin (skill and `.mcp.json`), read-only branch view with SSE, and the reply bar with the global message only. Run `/explore-chat` in a real session and go through a few rounds. This catches integration problems before the long UI phase. Import moved before this phase so the slice starts from a real conversation.

### 7. UI

In order: explorations list, selection and drafts, anchoring and highlights, fading, sticky tray and "+N", full reply bar, submit queue and cancel, submitted comments and links, fork view, map view, keyboard and history. Playwright tests for selection, comment, submit, cancel and back/forward, against a seeded daemon.

### 8. Plugin

The post-compact hook and the marketplace file.

### 9. End-to-end in a real session

Run `/explore-chat` in a real conversation, comment, fork, submit, compact, continue from a new session with `/explore-chat <id>`. Fix what breaks. Write the README.

## Later

- Hard forks: each fork's answer written by a subagent that only gets `read_fork` for that fork.
- Message summaries on the map, with each fork's comments listed under its box. Needs: a nullable `messages.summary` column (one `ALTER TABLE`), an optional `summary` on `add_message`, summaries for user messages (built from the comments, or written by Claude), a pass for imported messages, and a map layout for boxes of different heights (`d3-flextree`). About 1–2 days.
- Regular Claude Desktop chat.
- Code highlighting in messages, search, export.
