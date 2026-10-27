# chat-explorer

Explore a Claude Code conversation as a tree in the browser. Select text in an answer and comment on it: an inline comment continues the current branch, and a fork comment starts a new one. Claude answers in the browser, and one Claude Code session serves every branch. Explorations are stored, so you can list them, reopen them, and continue them from a new session.

## Install

Requires Node 22.13 or newer, pnpm and Claude Code.

```sh
git clone <this repo> ai-chat-explorer
cd ai-chat-explorer
pnpm install
pnpm build
cd packages/server && pnpm link --global   # puts `chat-explorer` on your PATH
```

If pnpm reports that its global bin directory is not set up, run `pnpm setup` and open a new shell first.

Then add the plugin to Claude Code, either for one session:

```sh
claude --plugin-dir /path/to/ai-chat-explorer/plugin
```

or permanently, from inside Claude Code:

```
/plugin marketplace add /path/to/ai-chat-explorer
/plugin install chat-explorer@chat-explorer
```

## Use

In a Claude Code session, run `/explore-chat`. It imports the conversation so far and opens it in the browser. Claude then waits for you there.

- **Comment:** select text in a message and click **Comment**. Tick **Fork** to start a new branch from it, or leave it unticked to continue the current one.
- **Reply:** write in the box at the bottom. **Submit** sends your comments and message together: each fork comment becomes a new fork, and the inline comments and message become one reply in the current fork.
- **Queue:** if Claude is still answering, or no session is attached, your submission waits in a queue and you can cancel it.
- **Map:** the **Map** link shows the tree of forks. `[` and `]` go back and forward.
- **Continue later:** run `/explore-chat <id>` in any session. The id is in the status bar and in `chat-explorer list`.

Press Esc in the terminal to stop Claude waiting for feedback.

## CLI

```
chat-explorer start                         start the daemon if it is not running
chat-explorer stop
chat-explorer status                        version, port and attached sessions
chat-explorer list [--json]                 explorations, newest first
chat-explorer open [id] [--fork <forkId>]   open the UI in the browser
chat-explorer delete <id>
```

`chat-explorer mcp` and `chat-explorer hook <name>` are used by the plugin.

## Configuration

| Variable                   | Default            |                                                       |
| -------------------------- | ------------------ | ----------------------------------------------------- |
| `CHAT_EXPLORER_PORT`       | `4517`             | Port of the local daemon                              |
| `CHAT_EXPLORER_HOME`       | `~/.chat-explorer` | Database (`chat-explorer.db`) and `daemon.log`        |
| `CHAT_EXPLORER_NO_BROWSER` | unset              | When set, `/explore-chat` does not open a browser tab |
| `CLAUDE_CONFIG_DIR`        | `~/.claude`        | Where Claude Code transcripts are found               |

The daemon listens on `127.0.0.1` only and rejects requests from other websites.

## How it works

```
Claude Code session ── plugin: /explore-chat skill, post-compact hook
        │
        └─ MCP server (stdio, `chat-explorer mcp`) ── HTTP ──┐
                                                             ▼
                          daemon (127.0.0.1:4517) ── SQLite ~/.chat-explorer/chat-explorer.db
                                 │
                                 └─ Vue UI ◀── browser (SSE for updates, POST for actions)
```

- The daemon owns the data. Claude sends only new answers and summaries through MCP tools.
- `await_feedback` blocks until you submit. The plugin raises the MCP tool timeout to 24 hours, so the wait does not time out early.
- Submissions are queued and turned into messages and forks only when Claude picks them up, so an answer always lands right after the message it answers.
- After a compaction, a hook reminds Claude which exploration it is attached to.

The design and its decisions are in [docs/plan.md](docs/plan.md).

## Limits

- Forks share one Claude context. Claude is told to answer each fork only from its own messages, but what it read in other forks can still influence it. Forks answered by separate subagents are planned.
- Claude Code only (CLI and the Desktop Code tab), not regular Claude Desktop chat.

## Development

```sh
pnpm build                         # UI, then server with the UI inside
pnpm test                          # unit tests
pnpm typecheck
pnpm --filter ui test:e2e          # Playwright, runs in the installed Chrome against a seeded daemon
pnpm --filter ui dev               # Vite dev server, proxies /api to the daemon
pnpm --filter chat-explorer seed   # sample exploration in CHAT_EXPLORER_HOME
```
