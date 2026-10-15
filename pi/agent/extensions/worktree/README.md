# worktree

Run several pi sessions on the same repos without copying them. Git worktrees share one object
store, so a set of checkouts costs a few MB (plus whatever you build in them).

## Commands

| Command | What it does |
|---|---|
| `/wt new NAME` | Creates one worktree per git repo of this session (the working folder and every added folder) under `<root>/NAME/<repo>` on branch `wt/NAME`, starting from `origin/<default branch>` with no upstream. Links or copies the gitignored files, then opens a new Windows Terminal window running pi in the working repo's worktree with `--add-dir` set to the other worktrees. Folders that are not git repos are passed through unchanged. The current session is not changed. |
| `/wt list` | Lists every set under `<root>` with, per repo: branch, changed files, ahead/behind (or "not pushed: N commits" against the base branch when there is no upstream), whether `unity/Library` exists, and whether a Unity Editor is open for it (from one `unity status` call; `unknown` if it fails). |
| `/wt remove NAME` | Deletes a set. Refuses if this session uses it, if there is no UI, or if any repo has uncommitted changes or commits not pushed (a squash-merged branch counts as unpushed: delete those by hand). Otherwise asks for confirmation, removes the links first (never their targets), runs `git worktree remove` without `--force`, then `git branch -d` (the branch is kept if git refuses). Deletes the worktree's `Library/` with it. |
| `/wt done` | Runs inside a worktree session and removes the set it runs in. Same checks as `/wt remove`, plus it refuses while a Unity Editor is open in the set (a failing `unity status` only adds a warning). Asks for confirmation, moves pi out of the set, removes the working repo's worktree last (links first, never their targets, no `--force`, then `git branch -d`), shows the report, then asks "Close this pi session?". On refusal or failure the session stays open. |

`NAME`: lowercase letters, digits, `.`, `_`, `-` (max 40, starts with a letter or digit).

Nothing is created unless every check passes (remote and base branch found, target folder free,
branch free, no two repos with the same folder name). If a step fails after worktrees were created,
the ones this run created are removed again (links first, then `git worktree remove --force` and
`git branch -D`, only for what this run made).

## Gitignored files

For every repo, each configured path that exists in the original repo and not yet in the worktree is:

- **linked** (`link`): a junction on Windows, a symlink elsewhere. Needs no extra disk space. Defaults:
  `.pi/git`, `.pi/npm`, `node_modules`. Only folders can be linked.
- **copied** (`copy`, never overwriting): defaults `unity/Assets/IecGenerated` and
  `unity/Assets/IecGenerated.meta`.

Unity's `Library/` is never touched: a worktree session does not get one.

## Config

`~/.pi/agent/worktree.json`, every key optional. No file means the defaults below.

| Key | Default | Meaning |
|---|---|---|
| `root` | `<parent of the working repo>/wt` | Where sets are created. Absolute, no spaces or `;`. |
| `branchPrefix` | `wt/` | Branch is `<branchPrefix><name>`. |
| `launch` | `window` | `window`, `tab` (adds a tab to the newest Windows Terminal window) or `none` (print the command). |
| `piCommand` | `` | Empty: `~/.pi/agent/bin/pi.cmd` on Windows if it exists, otherwise `pi`. |
| `link` | see above | Paths (relative to each repo) to junction-link. |
| `copy` | see above | Paths (relative to each repo) to copy. |
| `unityGuard` | `true` | Turns the Unity guard on or off in worktree sessions. |

## Launching

Windows: `wt.exe -w new new-tab -d <cwd> --title "pi NAME" <pi> --add-dir "A\;B"`. Windows Terminal
reads `;` as its own separator, so the extension escapes it. If `wt.exe` is not found, it falls
back to `cmd /c start`. On macOS and Linux nothing is started; the command is printed.

## Unity

Only the session in the original folder drives the open Unity Editor. A session that runs inside a
worktree set gets a system prompt section saying so, and the guard refuses `bash`, `ctx_execute`
and `ctx_batch_execute` calls with a `unity` command that drives an Editor or runs a project
(`command`, `cmd`, `recompile`, `list`, `job`, `mcp`, `run`, `test`, `build`, `pipeline`) unless
`--project-path` is inside the set. Any `UNITY_PROJECT_PATH=` assignment is refused. `unity status`,
`install` and similar pass. Sessions outside `<root>` are not restricted.

The guard reads command text only; it is not a sandbox. `cd` in the text is ignored when resolving
a relative `--project-path`, and commands built at runtime or started from a script file are not seen.

## Limits

- Paths with spaces or `;` are not supported.
- Absolute paths inside tracked settings still point at the original folders.
- A branch can be checked out in only one worktree.
- Avoid `git gc` and `git worktree prune` in the original repos while worktrees exist.
- `node_modules` is shared with the original; a worktree that changes `package.json` should install its own.
- An added folder that is a subfolder of a repo is replaced by that repo's worktree root.
- Pushes to `main` stay blocked by each repo's own hook.
- On Windows the folder pi was started in stays locked by its parent processes until pi exits. `/wt done` treats that as removed and starts a detached cleanup that deletes the leftover empty folders (only empty folders, never files) for up to 2 minutes. If it cannot, delete them by hand.

## Tests

```
node --experimental-strip-types --test config.test.ts layout.test.ts files.test.ts git-ops.test.ts manage.test.ts unity-guard.test.ts
```
