# Let coding forks push branches to GitHub

A coding fork can clone a public repository without any credential. To push, it needs one. Once it can push, one fork can push a branch and another can fetch it, without anyone copying branches between workspaces by hand.

This guide sets up an **SSH deploy key** for one repository, plus a rule on GitHub so that forks can push branches but never `main`. Everything here is done by you, the owner. The key and the runner config are yours to create and edit; Claude doesn't create them for you.

## Why a deploy key

- **It's limited to one repository.** A deploy key opens nothing else in your account. A fine-grained token can be limited the same way.
- **It's a key of its own, not your personal SSH key.** Claude can read any credential it's given, so it should hold one that can do little, and that you can revoke on its own.
- **A ruleset can keep it off `main`.** A deploy key isn't a user, so GitHub only lets it past a ruleset if you add it to the ruleset's bypass list. A token acts as you, so a rule that you can bypass, the token can bypass too.

## 1. Make the key

Run this in your own terminal:

```sh
mkdir -p ~/.chat-explorer/runner/secrets
chmod 700 ~/.chat-explorer/runner/secrets
ssh-keygen -t ed25519 -N '' -C 'chat-explorer forks' -f ~/.chat-explorer/runner/secrets/github-deploy-key
chmod 600 ~/.chat-explorer/runner/secrets/github-deploy-key
```

The key has no passphrase. Nobody would be there to type one when a container starts. The folder and the file are readable by you only.

## 2. Add it to the repository

1. On GitHub, open the repository, then **Settings → Deploy keys → Add deploy key**.
2. Fill it in:
   - **Title:** `chat-explorer forks`.
   - **Key:** the output of `cat ~/.chat-explorer/runner/secrets/github-deploy-key.pub`. That's the `.pub` file, never the private one.
   - **Allow write access:** ticked.
3. Save.

## 3. Keep `main` for yourself

1. **Settings → Rules → Rulesets → New ruleset → New branch ruleset**.
2. Fill it in:
   - **Name:** `main`.
   - **Enforcement status:** Active.
   - **Target branches:** Add target → **Include default branch**.
   - **Rules:** tick **Restrict updates**, **Restrict deletions** and **Block force pushes**.
   - **Bypass list:** add **Repository admin**, so your own pushes to `main` still work. Don't add the deploy key.
3. Save.

If GitHub doesn't offer you a bypass list for this repository, the ruleset would block your own pushes to `main` too. In that case leave **Restrict updates** off and keep the other two rules. Forks are then kept off `main` only by the branch rule in `AGENTS.md`, not by GitHub.

## 4. Give the key to the runner

Add the key to `coding.credentials` in `~/.chat-explorer/runner/config.json`. Keep what's already there:

```json
{
  "coding": {
    "enabled": true,
    "credentials": [
      {
        "name": "GitHub deploy key",
        "type": "ssh-key",
        "file": "~/.chat-explorer/runner/secrets/github-deploy-key",
        "hosts": ["github.com:22"]
      }
    ]
  }
}
```

- **Host keys:** GitHub's are built into the runner, so this entry needs no `knownHosts`.
- **The config file must be writable by you only.** The runner refuses a config that other users could change.

Then restart the daemon, so the runner reads the config again. Wait until no fork is answering first:

```sh
launchctl kickstart -k gui/$(id -u)/local.chat-explorer.daemon
```

## 5. Give the key to a fork

1. In the fork, open **Chat settings → This fork**. Coding must be on.
2. Under **Credentials**, tick **GitHub deploy key**. That also lets the fork reach `github.com:22`.
3. Press **Restart container**. A credential reaches a container only when the container starts. The next message starts a fresh one, and the conversation continues.

Give it only to forks that need to push.

## 6. Check it

Ask the fork to run these checks and report the output:

1. **The key works.** Run:

   ```sh
   ssh -F /credentials/ssh_config -T git@github.com
   ```

   GitHub answers that it authenticated the key and doesn't provide shell access.
2. **A branch push works.** Run:

   ```sh
   git push git@github.com:<owner>/<repo>.git HEAD:refs/heads/fork/<fork id>/check
   ```

   It creates the branch. Delete it afterwards on GitHub, or with `git push … --delete fork/<fork id>/check`.
3. **A push to `main` is refused.** Run:

   ```sh
   git push git@github.com:<owner>/<repo>.git HEAD:refs/heads/main
   ```

   With the ruleset from step 3, GitHub refuses it. If it goes through, the ruleset isn't active or the deploy key is on its bypass list: fix that first, and put `main` back where it was.

## How forks use it

These rules are also in `AGENTS.md`:

- **Push only branches named `fork/<fork id>/<topic>`.** Never push `main` or another fork's branch, and never force-push a branch you didn't create.
- **Push over SSH.** The clone fetches over HTTPS, so point only pushes at SSH, once:

  ```sh
  git remote set-url --push origin git@github.com:<owner>/<repo>.git
  ```

  After that, `git push -u origin HEAD:fork/<fork id>/<topic>` works.
- **Another fork picks a branch up** with `git fetch origin`, then works on `origin/fork/<fork id>/<topic>`. Fetching a public repository needs no credential.
- **Merging into `main` stays with the main fork,** after review.

## Revoking it

Delete the key under **Settings → Deploy keys**. Forks lose push access at once, and nothing else in your account changes. Then remove the entry from the runner config, delete the two key files, and restart the daemon.
