# Working in this repo

This file is for coding agents: Claude Code (through `CLAUDE.md`), Codex, and any other agent, including the coding forks the app runs in Docker. The README explains what the app is and how to set it up. Its Development section has the commands and the package layout.

## Before you report work as done

- **Commit everything you finish.**
  - Never leave uncommitted changes, even at the end of a turn.
  - Use small commits, one per step.
  - Don't push unless you are asked to.
- **Run the checks:**
  - `pnpm build`
  - `pnpm typecheck`
  - `pnpm test`: the import and offline-write checks, unit tests, and the runner's container checks
  - the e2e suite: `pnpm --filter ui test:e2e`
- **Report the test counts,** and name every failing test. In a coding fork's container, the 13 read-aloud e2e tests fail because there is no macOS speech, and `CHAT_EXPLORER_DOCKER_TESTS=0` skips the container checks.
- **Make each new test fail without its change.** Check that by reverting the change and running the test, and say that you did.
- **Format the files you change** with `npx prettier --write`. `pnpm format:check` may flag files you didn't touch. Leave those alone.

## Rules the checks enforce

- **Package boundaries.** The packages reach each other only along the lines in the README's table. Run `pnpm check:imports`.
- **Writes from the web UI go through the outbox,** so they survive going offline. Read [docs/offline-writes.md](docs/offline-writes.md) before adding or changing anything the page saves. Run `pnpm check:offline-writes`.

## Rules no check enforces yet

- **Push only branches named `fork/<fork id>/<topic>`.**
  - Never push `main` or another fork's branch, and never force-push a branch you didn't create.
  - Merging into `main` is the main fork's job, after review.
  - Pushing needs the GitHub credential: see [docs/runner-github-credential.md](docs/runner-github-credential.md).

- **Every delete button asks to confirm.** Use `ConfirmButton`.
- **Database changes are migrations** in `packages/backend/src/db/schema.ts`. Add them; never edit an old one. Whoever merges backs up the database before the daemon runs a new migration.
- **Never print or commit a token or key.** That includes the Claude token in `~/.chat-explorer/runner/` and anything under `~/.ssh`.
- **Don't override the machine's own settings** for npm, Docker, git or the shell to get past a block. Report the block instead.

## Code style

- Match the style of the file you're in.
- Touch only what the task needs: no drive-by refactors.
- Use full, descriptive names. Avoid abbreviations, including in type parameters.
- Before writing a helper, look for one that already does the job, in this package and the ones next to it.
- Write comments only for the reason behind something the code can't show, never for what the code does.
- Avoid loose types (`any`, `unknown`, `Record<string, unknown>`) unless they're required. Don't annotate return types that inference already gets right.
- Write prose, comments and docs in British English, unless the file already uses another spelling.
