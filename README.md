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
pi-config setup          :: import the config, then npm install the extensions
```

Restart Pi and log in. That's it — the sync extension registers itself as part of the import, so
from then on this machine keeps itself in step.

On macOS or Linux use `./pi-config.sh setup`, or call the scripts directly:

```bash
node bin/import.js --dry-run   # see what would change
node bin/import.js             # apply
cd ~/.pi/agent/npm && npm install
```

## Day to day

Nothing, ideally. The extension imports at session start and commits your changes at session exit.
When you want to drive it yourself:

| In Pi | In a terminal | Does |
|---|---|---|
| `/pi-config status` | `pi-config status` | what differs, in both directions, plus uncommitted files |
| `/pi-config preview` | `pi-config preview` | what an import would change, writes nothing |
| `/pi-config import` | `pi-config import` | repo → this machine |
| `/pi-config export` | `pi-config export` | this machine → repo |
| `/pi-config push` | `pi-config sync` | export, commit, push |
| `/pi-config pull` | `git pull` | fetch the other machine's changes |
| — | `pi-config install` | `npm install` the extensions |

## What's synced

The repo mirrors `~/.pi/agent` under `pi/agent`. That single rule covers everything below, including
config for extensions you install later — no list to maintain.

| Mirrored | Holds |
|---|---|
| `pi/agent/settings.json` | theme, provider, default model, TUI prefs, **the extension list**, resource paths |
| `pi/agent/*.json` | one config file per extension (`claude-bridge.json`, and whatever you add) |
| `pi/agent/npm/package.json` | extension version pins |
| `pi/agent/skills/` | global skills |
| `pi/agent/prompts/` | global prompt templates (`/name` commands) |
| `pi/agent/themes/` | custom themes |
| `pi/agent/extensions/` | your own global extensions |

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
| session start | optional `git pull --ff-only`, then import — only if a dry run says something would change |
| session shutdown | export, then commit what changed under `pi/` |

Register it once per machine, in `~/.pi/agent/settings.json`:

```json
{ "extensions": ["D:\\works\\pi-config\\extension"] }
```

`import.js` writes exactly that during setup, so on a cloned machine it happens for you.
`export.js` rewrites the path to `__PI_CONFIG_REPO__/extension` before committing and `import.js`
resolves it back to wherever the clone lives — the same treatment is applied to any `skills`,
`prompts` or `themes` paths in `settings.json` that point into this repo. If the clone ends up
somewhere the extension can't work out, set `PI_CONFIG_REPO` to its path.

Behaviour lives in `config/sync.json` (shared) and `local/sync.json` (this machine only, gitignored —
see `local/sync.json.example`):

| Key | Default | Meaning |
|---|---|---|
| `autoImportOnStart` | `true` | apply repo config at session start when it differs |
| `pullOnStart` | `false` | `git pull --ff-only` first — off because it touches the network |
| `autoExportOnShutdown` | `true` | capture this machine's config when the session ends |
| `autoCommit` | `true` | commit what the export changed |
| `autoPush` | `false` | push that commit — off because publishing should be deliberate |
| `notify` | `true` | show TUI notifications |
| `timeoutMs` | `20000` | per-command timeout for git and the scripts |

Turn on `pullOnStart` and `autoPush` once you're happy with what the commits look like, and the two
machines converge with no thought at all. Until then, `/pi-config pull` and `/pi-config push` do it
when you ask.

Three behaviours worth knowing:

- **Auto-commits touch `pi/` only.** Your edits to the extension, the scripts, `config/sync.json` or
  this README are yours to commit — the extension never sweeps them into a background commit.
- **A session that imported skips its shutdown export.** Pi keeps settings in memory and rewrites
  them on exit, so exporting after an import would push the stale copy back over what was just
  pulled in. Restart Pi to pick up an import; the notification says so.
- **Everything is logged** to `local/sync.log` (gitignored), including failures. The extension never
  throws into your session.

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
