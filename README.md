# pi-config

Portable Pi settings, synced between machines. Four small JSON files and two scripts.

Credentials are **not** in this repo and never should be — `auth.json` is gitignored by name in three
different patterns. Log in separately on each machine.

## Use

```bash
# on a new machine
git clone <your-remote> pi-config
cd pi-config
node bin/import.js --dry-run     # see what would change
node bin/import.js               # apply
cd ~/.pi/agent/npm && npm install
# restart Pi, then log in

# after changing settings on any machine
cd pi-config
node bin/export.js
git add -A && git commit -m "pi: <what changed>"
```

`import.js` backs up any file it overwrites to `<name>.bak-<timestamp>` in `~/.pi/agent/`, and compares
by meaning rather than bytes — re-running it when nothing has changed reports `same` and writes nothing.

## What's synced

| Repo file | Installs to | Holds |
|---|---|---|
| `config/settings.json` | `~/.pi/agent/settings.json` | theme, provider, default model, TUI prefs, **extensions list** |
| `config/npm-package.json` | `~/.pi/agent/npm/package.json` | extension versions |
| `config/claude-bridge.json` | `~/.pi/agent/claude-bridge.json` | askClaude behaviour, plan tier |
| `config/hermes-memory-config.json` | `~/.pi/agent/hermes-memory-config.json` | memory review toggle + why it's off |
| `skills/` | `~/.pi/agent/pi-hermes-memory/skills/` | global skills (empty for now) |

Extensions are declared in two places that must agree: `settings.json` lists `packages`, and
`npm-package.json` pins the versions. Both are synced; `npm install` reconciles them.

## What's deliberately not synced

| Not synced | Why |
|---|---|
| `auth.json` | OAuth access + refresh tokens. Re-login on each machine instead. |
| `~/.pi/agent/bin/` | `fd` / `rg` platform binaries — Pi fetches these itself. |
| `npm/node_modules/` | Rebuilt by `npm install`. |
| `~/.pi/context-mode/` | context-mode's search index (~29 MB). A disposable cache rebuilt from sources. |
| `models-store.json` | Regenerates. |
| `trust.json` | Per-machine trusted paths. |
| `pi-hermes-memory/sessions.db` | See below. |

### Memory does not sync

Memories and session history live in `~/.pi/agent/pi-hermes-memory/sessions.db` — SQLite with an active
write-ahead log. Syncing it through git or a cloud folder corrupts it, and two machines both writing
memories will diverge with no sane merge. Treat memory as per-machine.

If you ever do need to move it: close Pi on both ends, copy `sessions.db`, `sessions.db-shm` and
`sessions.db-wal` together as a set, and accept that the destination's memory is replaced, not merged.

## Machine-specific values

`claude-bridge.json` stores an absolute path to the Claude Code executable. `export.js` replaces it with
`__CLAUDE_EXECUTABLE__`; `import.js` resolves it by checking the usual install locations and then `PATH`.

If auto-detection fails, create `local/machine.json` (gitignored):

```json
{ "pathToClaudeCodeExecutable": "/full/path/to/claude" }
```

If it can't be resolved at all, `import.js` drops the setting so the bridge falls back to `PATH`, and
tells you it did.

## Cross-platform caveat

`settings.json` contains a Windows-style extension path: `"+src\\index.ts"`. If the other machine is
Linux or macOS and the extension fails to load, change it to `"+src/index.ts"` there. Both machines being
Windows means nothing to do.
