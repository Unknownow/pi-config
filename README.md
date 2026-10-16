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
pi-config setup          :: import the config, npm install the extensions, install the VS Code bridge
```

Restart Pi and log in. That's it — the sync extension registers itself as part of the import, so
from then on this machine keeps itself in step.

On macOS or Linux use `./pi-config.sh setup`, or call the scripts directly:

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
| `/pi-config pull` | `git pull` | fetch the other machine's changes |
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
| `pi/agent/extensions/` | your own global extensions (`workflow`; `worktree`: `/wt new NAME` opens a parallel pi session on git worktrees and `/wt open NAME` reopens one, in VS Code as a new VS Code terminal via the bundled `pi-terminal-bridge` extension, see its README) |

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
| `~/.pi/context-mode/` | A search index (~29 MB). Disposable, rebuilt from sources. |
| `*.db`, `*.sqlite`, `*-shm`, `*-wal` | Live SQLite. Git or cloud sync corrupts it, and two machines writing to it diverge with no sane merge. |

**Neither direction ever deletes.** A file you have and the other machine doesn't is added; a file
you removed stays in the repo until you `git rm` it. Mirroring deletions would let machine A wipe
machine B's config simply by never having installed that extension.

## Automatic sync

`extension/index.ts` runs the scripts at the right moments:

| When | What |
|---|---|
| session start | `git pull --rebase`, then import — only if a dry run says something would change |
| setup changes mid-session | export, commit, optionally push — after `syncDebounceMs` of quiet |
| session shutdown | export, then commit what changed under `pi/` |

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
see `local/sync.json.example`):

| Key | Default | Meaning |
|---|---|---|
| `autoImportOnStart` | `true` | apply repo config at session start when it differs |
| `pullOnStart` | `true` | `git pull --rebase --autostash` first, so you start from the other machine's latest |
| `autoExportOnShutdown` | `true` | capture this machine's config when the session ends |
| `autoCommit` | `true` | commit what the export changed |
| `autoPush` | `true` | push that commit; if the other machine pushed first, rebase and retry once |
| `autoSyncOnChange` | `true` | watch `~/.pi/agent` and export/commit when synced files change |
| `syncDebounceMs` | `5000` | quiet period after the last change before that sync runs |
| `notify` | `true` | show TUI notifications |
| `timeoutMs` | `20000` | per-command timeout for git and the scripts |

With `pullOnStart` and `autoPush` on, the two machines converge with no thought at all: each one
pulls when Pi starts and pushes a few seconds after its setup changes. If a push is rejected because
the other machine got there first, the extension rebases onto it, pushes again, and imports what it
pulled in (restart Pi to apply it). When both machines edited the same file, the rebase is aborted
and logged — resolve it in the repo by hand. To keep a machine from publishing, set
`{ "autoPush": false }` in its `local/sync.json`.

Three behaviours worth knowing:

- **Auto-commits touch `pi/` only.** Your edits to the extension, the scripts, `config/sync.json` or
  this README are yours to commit — the extension never sweeps them into a background commit.
- **A file you edit in the repo is kept, not overwritten.** `export.js` records a hash of every
  mirror file as it last moved (`local/sync-state.json`, gitignored). If a mirror file no longer
  matches that hash, you edited it in the repo: export leaves it alone and says `keep`, and the
  auto-commit leaves it uncommitted (listed in `/pi-config status` under other edits). To keep your
  edit, commit it, then run import so the record matches the commit (an edit that is committed but
  still differs from this machine keeps reporting `keep` until one of the two runs). To take this
  machine's copy instead, run `node bin/export.js --force`. To take the repo's copy, run import.
- **A session that imported skips its shutdown export.** Pi keeps settings in memory and rewrites
  them on exit, so exporting after an import would push the stale copy back over what was just
  pulled in. Restart Pi to pick up an import; the notification says so.
- **Everything is logged** to `local/sync.log` (gitignored), including failures. The extension never
  throws into your session.

Tests: `node --test bin/sync.test.js bin/vscode-bridge.test.js`.

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

`settings.json` can contain Windows-style relative extension paths such as `"+src\\index.ts"`. If the
other machine is Linux or macOS and an extension fails to load, change it to `"+src/index.ts"` there.
Both machines being Windows means nothing to do.
