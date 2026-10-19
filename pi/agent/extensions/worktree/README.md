# worktree

Run several pi sessions on the same repos without copying them. Git worktrees share one object
store, so a set of checkouts costs a few MB (plus whatever you build in them).

## Commands

| Command | What it does |
|---|---|
| `/wt new NAME` | Creates one worktree per git repo of this session (the working folder and every added folder) under `<root>/NAME/<repo>` on branch `wt/NAME`, starting from `origin/<default branch>` with no upstream. Links or copies the gitignored files, then opens a new Windows Terminal window (or a new VS Code terminal when pi runs in one, see VS Code) running pi in the working repo's worktree with `--add-dir` set to the other worktrees. Folders that are not git repos are passed through unchanged. The current session is not changed. |
| `/wt open [NAME]` | Reopens an existing set (without NAME, pick one from a list): starts pi with `--continue` in the set's working repo (the only repo, or the one named like this session's repo, otherwise you pick one), with `--add-dir` for the other repos, through the same launch path as `/wt new`. Refuses from a session inside that set. When you quit an interactive pi session inside a set that still exists, a reminder is printed to stderr with how to reopen or remove it; nothing is ever deleted on quit. |
| `/wt list` | Lists every set under `<root>` with, per repo: branch, changed files, ahead/behind (or "not pushed: N commits" against the base branch when there is no upstream), whether `unity/Library` exists, and whether a Unity Editor is open for it (from one `unity status` call; `unknown` if it fails). |
| `/wt update [NAME]` | Brings a set up to date (without NAME: the set this session runs in, otherwise pick one from a list). For every repo it fetches, then fast-forwards the branch to its base branch (`origin/HEAD`, `main` or `master`) when the branch has no commits of its own. It never merges, rebases or resets: a branch with its own commits or a detached HEAD is reported and left alone. Uncommitted changes are allowed; git refuses the fast-forward when it would overwrite one. |
| `/wt remove [NAME]` | Deletes a set (without NAME, pick one from a list). Refuses if this session uses it, if there is no UI, or if any repo has uncommitted changes or commits not pushed (a squash-merged branch counts as unpushed: delete those by hand). Otherwise asks for confirmation, removes the links first (never their targets), runs `git worktree remove` without `--force`, then `git branch -d` (the branch is kept if git refuses). Deletes the worktree's `Library/` with it. |
| `/wt done` | Runs inside a worktree session and removes the set it runs in. Same checks as `/wt remove`, plus it refuses while a Unity Editor is open in the set (a failing `unity status` only adds a warning). Asks for confirmation, moves pi out of the set, removes the working repo's worktree last (links first, never their targets, no `--force`, then `git branch -d`), shows the report, then asks "Close this pi session?". On refusal or failure the session stays open. |

While a `/wt` command or the automatic update runs, a widget above the editor shows a spinner, the current stage, the git command running now with its folder, and the elapsed time. It is hidden while a dialog is open and removed when the command ends.

## Automatic update

When an interactive pi session starts (or resumes) inside a set, the extension runs the same update as
`/wt update` for every repo of the set, with one difference: a repo with uncommitted changes is skipped.
So a clean set with no commits of its own follows `main` by itself, and a branch with your commits is
never moved. Headless pi processes (subagents, `pi -p`) never update, so they cannot move files under a
session that is working in the set. The fetches run before the session takes input (15 s timeout per
fetch, no credential dialog), so startup takes a few seconds longer. Nothing is shown when every repo was already current;
otherwise one line per repo. Turn it off with `"autoUpdate": false` in `worktree.json`.

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
| `vscode` | `true` | Open the new session in a VS Code terminal when pi runs in a VS Code terminal with the bridge installed. `false` always uses Windows Terminal. |
| `unityGuard` | `true` | Turns the Unity guard on or off in worktree sessions. |
| `autoUpdate` | `true` | Fast-forward the set's repos when a session starts inside it (see Automatic update). |

## Launching

Windows: `wt.exe -w new new-tab -d <cwd> --title "pi NAME" <pi> --add-dir "A\;B"`. Windows Terminal
reads `;` as its own separator, so the extension escapes it. If `wt.exe` is not found, it falls
back to `cmd /c start`. On macOS and Linux nothing is started; the command is printed.

## VS Code

When pi runs in a VS Code terminal, `/wt new` opens the session in a new focused terminal tab (titled `pi NAME`) of the same VS Code window instead of Windows Terminal. This needs the bundled `pi-terminal-bridge` extension in `vscode/`. It listens on a local named pipe and sets `PI_VSCODE_TERMINAL` (the pipe path) for every terminal of its window. pi sends it one JSON line `{name, cwd, shellPath, shellArgs}`.

Install: run `pi-config vscode` from the pi-config repo (or `./pi-config.sh vscode`). `pi-config setup` does it too when `code` is on PATH. Or by hand:

```
cd ~/.pi/agent/extensions/worktree/vscode
npx --yes @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license -o "$TEMP/pi-terminal-bridge.vsix"
code --install-extension "$TEMP/pi-terminal-bridge.vsix" --force
```

Reload the VS Code window, then open a new terminal (terminals opened earlier lack the variable).

If the bridge fails, `/wt new` falls back to Windows Terminal and says why. If pi runs in VS Code but `PI_VSCODE_TERMINAL` is missing, it falls back and adds a hint. `vscode: false` or `launch: "none"` disables the bridge.

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

- Terminals opened before the VS Code extension activated use Windows Terminal.
- If VS Code does not answer within 3 s the fallback opens, and the VS Code terminal can still appear late.
- Any process of the same user can ask the bridge to open a terminal running any program.
- Paths with spaces or `;` are not supported.
- Absolute paths inside tracked settings still point at the original folders.
- A branch can be checked out in only one worktree.
- Avoid `git gc` and `git worktree prune` in the original repos while worktrees exist.
- `node_modules` is shared with the original; a worktree that changes `package.json` should install its own.
- An added folder that is a subfolder of a repo is replaced by that repo's worktree root.
- Pushes to `main` stay blocked by each repo's own hook.
- `/wt open` cannot see a pi already running in the set. Plain (non-git) folders come back only through the continued session. With no earlier session in that folder, `--continue` starts a new one.
- On Windows the folder pi was started in stays locked by its parent processes until pi exits. `/wt done` treats that as removed and starts a detached cleanup that deletes the leftover empty folders (only empty folders, never files) for up to 2 minutes. If it cannot, delete them by hand.
- The progress spinner pauses while gitignored files are copied (a synchronous copy).

## Tests

```
node --experimental-strip-types --test config.test.ts layout.test.ts files.test.ts git-ops.test.ts manage.test.ts unity-guard.test.ts vscode-bridge.test.ts update.test.ts progress.test.ts
node --test vscode/request.test.js
```
