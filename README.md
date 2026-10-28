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

- **Comment:** select text in a message, or tap a paragraph, and click **Comment**. Tick **Fork** to start a new branch from it, or leave it unticked to continue the current one.
- **Reply:** write in the box at the bottom. **Submit** sends your comments and message together: each fork comment becomes a new fork, and the inline comments and message become one reply in the current fork. Tick **New fork** to send the message and inline comments to a new fork instead, starting from the end of the current one. The current fork stays as it was, and a **↳ Fork** link under its last message leads to the new one.
- **Files:** paste an image, drop files on the reply box or the new-chat box, or pick them with 📎 (on the iPhone: photos, the camera or Files). Images, PDFs and text or code files, up to 10 MB each. They are stored in `~/.chat-explorer/files/`, and Claude gets their paths and opens them with its Read tool. Background sessions may read that folder and nothing else.
- **Queue:** if Claude is still answering, or no session is attached, your submission waits in a queue and you can cancel it.
- **Map:** the **Map** link shows the tree of forks. `[` and `]` go back and forward.
- **Continue later:** run `/explore-chat <id>` in any session. The id is in the status bar and in `chat-explorer list`.
- **Archive:** **Archive** in the list moves an exploration to **Archived**, where it is read only. **Restore** brings it back; **Delete** hides it. A deleted exploration stays in the database until `chat-explorer purge <id>`; `chat-explorer restore <id>` brings it back as archived.

Press Esc in the terminal to stop Claude waiting for feedback.

You don't need a terminal session to continue. When you submit and no session is attached, chat-explorer starts Claude Code in the background to answer (see below).

## From the phone

The daemon can run Claude Code itself, so the phone only needs to reach the daemon.

1. **Run the daemon at login:** `chat-explorer service install` (macOS). It also restarts the daemon after a crash. `chat-explorer service uninstall` removes it.
2. **Reach it through Tailscale.** Install Tailscale on the Mac and the phone, signed in to the same account. On the Mac run `tailscale serve --bg 4517`. It prints an `https://<mac>.<tailnet>.ts.net` address, reachable only from your own devices. If Tailscale asks you to enable HTTPS certificates for the tailnet, do that first.
3. **Tell chat-explorer that address,** so the links Claude prints open on the phone and the daemon accepts requests from it. In `~/.chat-explorer/config.json`:

   ```json
   { "publicUrl": "https://<mac>.<tailnet>.ts.net" }
   ```

   Then restart the daemon: `chat-explorer service install` again, or `chat-explorer stop` followed by `chat-explorer start`.

4. **Keep the Mac awake on the charger:** System Settings → Battery → Options → "Prevent automatic sleeping on power adapter when the display is off". A MacBook with its lid closed still sleeps unless an external display is connected.

On the phone, open the address. Start a new exploration from the explorations page, or continue an existing one. Comments are listed under their message instead of floating over the text.

### Background sessions

When feedback is waiting and no session is attached, the daemon runs:

```
claude -p "/explore-chat <id>" --model <model> --tools WebSearch ...
```

- The session can search the web and use the chat-explorer tools. It cannot read or write files or run commands, and anything that would need a permission prompt is denied.
- It runs in `~/.chat-explorer/sessions/`, logging to `sessions/<id>.log`.
- The model picker in the status bar (Sonnet or Opus) sets the model for these sessions. Changing it restarts a running session, which keeps its conversation.
- After `idleMinutes` with nothing to answer, the session stops. Your next submit resumes it with the same conversation, which takes a few seconds.
- At most `maxSessions` run at once. To start another, chat-explorer stops the one idle longest.
- If Claude cannot start, for example because it is not logged in, the page shows the end of its log and a Retry button.
- Running `/explore-chat <id>` in a terminal takes the exploration over. The background session then exits.

### Dictation

Every text box has a mic button. Tap it, speak, tap it again: the Mac turns the recording into text with [whisper.cpp](https://github.com/ggml-org/whisper.cpp) on its GPU, and the text lands at the cursor. Audio never leaves your devices.

```
brew install whisper-cpp
chat-explorer dictation install
```

- `dictation install` downloads the Whisper model (`large-v3-turbo` quantised to q5_0, 574 MB) from Hugging Face into `~/.chat-explorer/models/`, checks its SHA-256, and runs Whisper once. The first run compiles GPU code, which takes about 15 seconds.
- On an M2 Max a 20-second recording takes about 1.5 seconds. Whisper uses about 800 MB of memory while it runs and nothing in between.
- The language is detected per recording. The exploration title or the quoted text goes to Whisper as a hint, which helps with technical words.
- The mic button appears once the daemon finds `whisper-cli` and the model, with no restart needed. It needs HTTPS or `127.0.0.1`, which the Tailscale address and the local address both are.
- `chat-explorer dictation uninstall` deletes the model.

### Read aloud

**Listen** next to an answer reads it aloud. Tap a paragraph, list item or code block to pick it: **Play** reads from there, **Comment** comments on the whole block. Selecting text still offers **Comment** for the selection. The player above the reply box has play/pause, 5 seconds back and forward, previous and next block, and stop. With the chain button on, the next block starts when one ends; reading stops at the end of the answer. The block being read is highlighted and kept a little above the middle of the screen. On the iPhone the lock screen controls work too.

- The Mac reads with its own voices (`say`), in the language it detects for the answer. For a better voice, download a Premium or Enhanced one in System Settings → Accessibility → Spoken Content → System voice → Manage Voices. The best installed voice for the language is picked, from the next block on.
- Code, diagrams and tables are announced ("Code block, TypeScript, 12 lines") instead of read.
- macOS only.

## CLI

```
chat-explorer start                         start the daemon if it is not running
chat-explorer stop
chat-explorer status                        version, port and attached sessions
chat-explorer list [--archived|--deleted] [--json]
                                            explorations, newest first
chat-explorer open [id] [--fork <forkId>]   open the UI in the browser
chat-explorer archive|unarchive <id>
chat-explorer delete <id>                   hide it; restore <id> brings it back, archived
chat-explorer purge <id>                    delete permanently
chat-explorer service install|uninstall     run the daemon at login (macOS)
chat-explorer dictation install|uninstall   download or delete the Whisper model
```

`chat-explorer mcp` and `chat-explorer hook <name>` are used by the plugin.

## Configuration

| Variable                   | Default            |                                                       |
| -------------------------- | ------------------ | ----------------------------------------------------- |
| `CHAT_EXPLORER_PORT`       | `4517`             | Port of the local daemon                              |
| `CHAT_EXPLORER_HOME`       | `~/.chat-explorer` | Database (`chat-explorer.db`) and `daemon.log`        |
| `CHAT_EXPLORER_NO_BROWSER` | unset              | When set, `/explore-chat` does not open a browser tab |
| `CHAT_EXPLORER_PUBLIC_URL` | unset              | Overrides `publicUrl` from `config.json`              |
| `CLAUDE_CONFIG_DIR`        | `~/.claude`        | Where Claude Code transcripts are found               |

`~/.chat-explorer/config.json` is read when the daemon starts. Every key is optional:

| Key            | Default    |                                                          |
| -------------- | ---------- | -------------------------------------------------------- |
| `publicUrl`    | `null`     | Address the phone uses, e.g. a Tailscale Serve address   |
| `defaultModel` | `"sonnet"` | Model for new explorations (`"sonnet"` or `"opus"`)      |
| `idleMinutes`  | `60`       | Stop a background session after this long with no work   |
| `maxSessions`  | `3`        | Background sessions running at once                      |
| `dictation`    | see below  | `{ "model": "large-v3-turbo-q5_0", "language": "auto" }` |

The daemon listens on `127.0.0.1` only and rejects requests from other websites. Requests through `publicUrl` are accepted too, so anyone who can reach that address can start Claude sessions on your Mac. Keep it inside your tailnet (`tailscale serve`, not `tailscale funnel`).

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
- Background sessions can't touch files or run commands. Sessions in isolated containers with those tools are planned.
- `service install` is macOS only.
- Dictation shows no words while you speak; the text arrives once you stop.

## Development

```sh
pnpm build                         # UI, then server with the UI inside
pnpm test                          # unit tests
pnpm typecheck
pnpm --filter ui test:e2e          # Playwright, runs in the installed Chrome against a seeded daemon
pnpm --filter ui dev               # Vite dev server, proxies /api to the daemon
pnpm --filter chat-explorer seed   # sample exploration in CHAT_EXPLORER_HOME
```
