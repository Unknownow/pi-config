# pi-config

Your whole Pi setup, synced between machines: settings, every extension and its config, global
skills, prompts, themes, and local extensions. A Pi extension does it automatically, and two scripts
do it by hand when you'd rather drive.

Credentials are **not** in this repo and never should be — `auth.json` is denied by name in the sync
rules and gitignored in three patterns on top of that. Log in separately on each machine.

## New machine, three steps

```bat
git clone git@github.com:Unknownow/pi-config.git
cd pi-config
pi-config setup          :: install Node LTS and Pi if missing, import the config, npm install the extensions, install the VS Code bridge
```

Restart Pi and log in. That's it — the sync extension registers itself as part of the import, so
from then on this machine keeps itself in step.

`setup` asks before installing Node (latest LTS) or Pi; add `--yes` to skip the questions. Run `pi-config` with no arguments for an interactive menu.

On macOS or Linux use `./pi-config.sh setup` (Node comes from nvm; the script also has a menu when run with no arguments), or call the scripts directly:

```bash
node bin/import.js --dry-run   # see what would change
node bin/import.js             # apply
cd ~/.pi/agent/npm && npm install
node bin/vscode-bridge.js      # optional: VS Code terminal bridge for /wt new
```

## Day to day

Nothing, ideally. The extension imports at session start, commits your changes a few seconds after
you make them, and once more at session exit.
When you want to drive it yourself:

| In Pi | In a terminal | Does |
|---|---|---|
| `/pi-config status` | `pi-config status` | what differs, in both directions, plus uncommitted files |
| `/pi-config preview` | `pi-config preview` | what an import would change, writes nothing |
| `/pi-config import` | `pi-config import` | repo → this machine |
| `/pi-config export` | `pi-config export` | this machine → repo |
| `/pi-config sync` | `pi-config sync` | export, commit, push (also pushes earlier unpushed commits) |
| `/pi-config push` | `pi-config sync` | same as `sync` |
| `/pi-config pull` | `git pull --ff-only` | fetch the other machine's changes (else the guarded rebase) |
| — | `pi-config node` | install the latest Node LTS (nvm on macOS/Linux, winget on Windows) |
| — | `pi-config pi` | install Pi with its official installer, or run `pi update` when it is already installed |
| — | `pi-config install` | `npm install` the extensions |
| — | `pi-config vscode` | build and install the VS Code terminal bridge used by `/wt new` (skipped by `setup` when `code` is not on PATH) |

## What's synced

The repo mirrors `~/.pi/agent` under `pi/agent`. That single rule covers everything below, including
config for extensions you install later — no list to maintain.

| Mirrored | Holds |
|---|---|
| `pi/agent/settings.json` | theme, provider, default model, TUI prefs, **the extension list**, resource paths |
| `pi/agent/*.json` | one config file per extension (`claude-bridge.json`, and whatever you add) |
| `pi/agent/AGENTS.md`, `APPEND_SYSTEM.md`, `SYSTEM.md`, `CLAUDE.md`, `AGENTS.override.md` | global instructions Pi adds to every session |
| `pi/agent/npm/package.json` | extension version pins |
| `pi/agent/skills/` | global skills |
| `pi/agent/prompts/` | global prompt templates (`/name` commands) |
| `pi/agent/themes/` | custom themes |
| `pi/agent/extensions/` | your own global extensions (`workflow`; `agents`: `explore`, `advisor` and `test_run`, models set with `/agents model`; `shared`: code the extensions share, not loaded as an extension; `quiet-tools`: `alt+o` / `/quiet` hides finished tool rows; `markdown-view`: `/view` opens a reply or `.md` file in the browser with mermaid diagrams; `workspace`: the session's folders (`/folders`, `--add-dir`) and worktree sets (`/wt new NAME` opens a parallel pi session on git worktrees and `/wt open NAME` reopens one), in VS Code as a new VS Code terminal via the bundled `pi-terminal-bridge` extension, see its README) |

Extensions are declared in two places that must agree: `settings.json` lists `packages`, and
`npm/package.json` pins the versions. Both are mirrored; `npm install` reconciles them.

Outside the mirror:

| File | Holds |
|---|---|
| `config/sync.json` | how the sync extension behaves (below) |
| `extension/index.ts` | the sync extension itself |
| `bin/*.js` | the export/import scripts and their shared rules |
| `local/` | per-machine overrides and the sync log, gitignored |

## What's deliberately not synced

| Not synced | Why |
|---|---|
| `auth.json` | OAuth access + refresh tokens. Re-login on each machine instead. |
| `trust.json` | Per-machine trusted project paths. |
| `models-store.json` | Regenerates from the model catalogs. |
| `~/.pi/agent/bin/` | `fd` / `rg` platform binaries — Pi fetches these itself. |
| `~/.pi/agent/sessions/` | Conversation history, per-machine. |
| `npm/node_modules/` | Rebuilt by `npm install`. |
| `*.db`, `*.sqlite`, `*-shm`, `*-wal` | Live SQLite. Git or cloud sync corrupts it, and two machines writing to it diverge with no sane merge. |

**Deletions follow the sync record.** `local/sync-state.json` remembers the hash of every file that moved between this machine and the repo. Export deletes a repo file when it is gone from this machine and the repo copy is unchanged; it stops at 20 files or 25% of the recorded files unless you pass `--allow-deletes` (exit code 2). Import deletes a machine file when it has a record, is not in the committed `HEAD`, and the working tree holds no copy of it that matches its record (a committed deletion, not an uncommitted new export). Import has **no deletion cap**. An edited machine copy gets a `<name>.bak-<timestamp>` backup first, then goes too. A file with no record is never deleted, so a machine that never had an extension cannot wipe it elsewhere. `--dry-run` prints `WOULD delete <path>`.

## Automatic sync

The committed `master` of this repo is the only truth. `~/.pi/agent` mirrors it, and config that Pi
changes on the machine is committed and pushed at once. `extension/index.ts` runs the scripts at the
right moments:

| When | What |
|---|---|
| session start | once per window, under the lock: (1) repo-state guard, (2) export machine changes not yet synced, commit and push them, (3) with `pullOnStart`: `git pull --ff-only`, (4) with `autoImportOnStart`: import, (5) the restart notice when the import wrote anything |
| setup changes mid-session | export, commit, optionally push — after `syncDebounceMs` of quiet |
| session shutdown | export, then commit what changed under `pi/` (waits at most 10 s for the lock) |

Register it once per machine, in `~/.pi/agent/settings.json`:

```json
{ "extensions": ["D:\\works\\pi-config\\extension"] }
```

`import.js` adds that entry on every import if it's missing, so on a cloned machine it happens for you.
`export.js` rewrites the path to `__PI_CONFIG_REPO__/extension` before committing and `import.js`
resolves it back to wherever the clone lives — the same treatment is applied to any `skills`,
`prompts` or `themes` paths in `settings.json` that point into this repo. If the clone ends up
somewhere the extension can't work out, set `PI_CONFIG_REPO` to its path.

Behaviour lives in `config/sync.json` (shared) and `local/sync.json` (this machine only, gitignored —
see `local/sync.json.example`). The branch is not a setting: it is `master`.

| Key | Default | Meaning |
|---|---|---|
| `autoImportOnStart` | `true` | import the committed repo config at session start when it differs |
| `pullOnStart` | `true` | `git pull --ff-only` first (never `--rebase`, never `--autostash`); when it cannot fast-forward, the same guarded fetch + rebase as a rejected push, and when that is not allowed the import is skipped |
| `autoExportOnShutdown` | `true` | capture this machine's config when the session ends |
| `autoCommit` | `true` | commit what the export changed |
| `autoPush` | `true` | push that commit; if the other machine pushed first, rebase and retry once |
| `autoSyncOnChange` | `true` | watch `~/.pi/agent` and export/commit when synced files change |
| `syncDebounceMs` | `5000` | quiet period after the last change before that sync runs |
| `notify` | `true` | show TUI notifications |
| `timeoutMs` | `20000` | per-command timeout for git and the scripts |

### The rules

- **Repo-state guard.** Every automatic operation (startup pull, import, export, commit, push; the
  watcher and shutdown too) runs only when the checkout is on branch `master` and no rebase, merge,
  cherry-pick or revert is in progress (`.git/rebase-merge`, `rebase-apply`, `MERGE_HEAD`,
  `CHERRY_PICK_HEAD`, `REVERT_HEAD`). Otherwise the window does no automatic sync, logs the reason once
  in `local/sync.log`, and `/pi-config status` shows it. Work on feature branches in a separate
  worktree, or just expect the sync to stand still while you are off `master`.
- **Import mirrors the committed `HEAD`**, not the working tree: an uncommitted edit under `pi/agent/`
  never reaches the machine. Files are read in working-copy form (`.gitattributes` makes `*.bat` CRLF).
  Changed files are overwritten with a `.bak-<timestamp>` backup, placeholders are resolved as before.
- **A pending machine export is left alone.** A file whose working-tree copy differs from `HEAD` but
  matches its sync record (export wrote it, the commit has not happened yet, e.g. a failed commit or
  `autoCommit=false`) keeps its machine copy and is never deleted by import. The commit step agrees: such
  a file is ready to commit.
- **Export never overwrites or deletes an uncommitted repo edit.** A repo edit is a file under `pi/agent/`
  whose content differs from its sync record (with no record: from `HEAD`). When the machine copy also
  changed, export skips the file and logs `conflict <path>`; `/pi-config status` lists the conflicts. To
  keep your edit, commit it and run import; to take this machine's copy, run `node bin/export.js --force`.
  A file pulled from the other PC but not imported yet counts as a repo edit until import runs.
- **Commits and pushes.** Auto-commits touch `pi/` only (your edits to the extension, the scripts,
  `config/sync.json` or this README are yours to commit) and read `chore(config): sync from <host>`. A rejected
  push does `git fetch`, then `git rebase origin/master` (no autostash; a conflict is aborted), pushes once
  more, then imports. The rebase runs only when no tracked file differs from `HEAD` and every commit in
  `origin/master..HEAD` is a sync commit. Otherwise it is skipped and logged, the commit stays for the next
  sync, and `/pi-config status` lists the blocking files, the number of unpushed sync commits and the hint
  "commit or discard your edits to resume sync".
- **Several windows share one lock.** `local/sync.lock` guards every git and sync step of the extension
  across processes. It holds the pid and a token, and its mtime is a heartbeat refreshed every 15 s. A lock
  whose pid is dead or whose heartbeat is older than 2 minutes is taken over under a short mutex
  (`local/sync.lock.takeover`, stale after 30 s) that re-checks the token before it replaces the lock. A
  window that loses the lock stops before its next git step and logs "lock lost". A waiting window polls for
  up to 60 s, then skips the run and logs it; the shutdown path waits 10 s ("skipped, lock busy"), and what
  export already left on disk is picked up by the next window's startup export. Every window keeps its own
  watcher; a window that finds nothing to do reports "already up to date" and makes no commit. The manual
  `bin/*.js` scripts do not take the lock.
- **A session that imported skips its shutdown export.** Pi keeps settings in memory, so exporting after
  an import could push a stale copy back over what was just pulled in. Restart Pi to pick up an import;
  the notification says so. This rule is per window and stays even though the check below found no
  rewrite of `settings.json`.
- **A stale `ctx` never fails the sync.** After a session replacement or reload Pi's `ctx` throws on use.
  UI calls are wrapped and only logged; the export, commit and push still run.
- **Everything is logged** to `local/sync.log` (gitignored), including failures. The extension never
  throws into your session.

#### Does Pi rewrite `settings.json` on exit?

Checked in the Pi package (`@earendil-works/pi-coding-agent` 1.5.2, `dist/core/settings-manager.js`) and its
docs (`docs/settings.md`). No: Pi writes `settings.json` only when a setting changes (`setX()` →
`save()`), and then it re-reads the file under a lock and merges only the fields it modified into the
file's current content (`persistScopedSettings`). There is no write of the whole in-memory copy at exit
(`flush()` only waits for the pending write queue). A stale window therefore cannot revert an import
wholesale, so no `last-import.json` / `--session-start` guard was added. The per-window
"imported this session" rule above stays.

`/pi-config status` shows the repo-state guard result, the lock holder (pid, heartbeat age), the conflicts
and the files an import would delete.

Tests: `node bin/test-all.js` runs every suite (on demand only, a few minutes; `--json` for machine output). Single suites: `node --test bin/sync.test.js bin/vscode-bridge.test.js` and `node --experimental-strip-types --test extension/*.test.ts`; each extension's README has its own command.


### Secret guard

The deny list only names a few files, so two more layers keep credentials out of commits:

- **Export skips them.** A file whose name looks like a credential (`*oauth*`, `*credentials*`, `*secret*`,
  `*.pem`, `*.key`, `id_rsa`, ...) or whose content holds a key (private keys, `sk-`, GitHub, Slack, AWS,
  Google, npm and GitLab tokens, JWTs, a literal `apiKey`/`token`/`password` value) is not copied. The
  export prints `SKIPPED <file> (why)` and the extension warns once. Placeholders (`__X__`,
  `${VAR}`, `Bearer ${TOKEN}`) are fine. Source and docs (`.js`, `.ts`, `.md`, ...) are exempt from the name rule
  but not from the content scan.
- **The pre-commit hook refuses them.** `.githooks/pre-commit` runs `bin/check-secrets.js --staged` on every
  commit in this repo, including hand commits and the sync's own. `import` and the extension set
  `core.hooksPath` to `.githooks`; on a checkout that never ran either, run `git config core.hooksPath .githooks`.
  A false positive: unstage the file, or adjust `secretsIn` in `bin/lib.js`.

`import.js` backs up any file it overwrites to `<name>.bak-<timestamp>` next to the original, and
compares JSON by meaning rather than bytes — re-running it when nothing changed writes nothing.

## Machine-specific values

`claude-bridge.json` stores an absolute path to the Claude Code executable. `export.js` replaces it
with `__CLAUDE_EXECUTABLE__`; `import.js` resolves it by checking the usual install locations and
then `PATH`.

If auto-detection fails, create `local/machine.json` (gitignored):

```json
{ "pathToClaudeCodeExecutable": "/full/path/to/claude" }
```

If it can't be resolved at all, `import.js` drops the setting so the bridge falls back to `PATH`, and
tells you it did.

## Cross-platform caveat

Import and export convert relative extension paths in `settings.json` (including those inside
`packages[]`) to forward slashes, so `"+src\\index.ts"` becomes `"+src/index.ts"` and loads on every OS.
Absolute paths are left as they are.
