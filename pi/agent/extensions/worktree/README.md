# worktree

Run several pi sessions on the same repos without copying them. Git worktrees share one object
store, so a set of checkouts costs a few MB (plus whatever you build in them).

## Commands

| Command | What it does |
|---|---|
| `/wt new NAME` | Creates one worktree per git repo of this session (the working folder and every added folder) under `<root>/NAME/<repo>` on branch `wt/NAME`, starting from `origin/<default branch>` with no upstream. Links or copies the gitignored files, then opens a new Windows Terminal window (or a new VS Code terminal when pi runs in one, see VS Code) running pi in the working repo's worktree with `--add-dir` set to the other worktrees. Folders that are not git repos are passed through unchanged. The current session is not changed. |
| `/wt open [NAME]` | Reopens an existing set (without NAME, pick one from a list): starts pi on the set's newest earlier session (or a new one) in the set's working repo (the only repo, or the one named like this session's repo, otherwise you pick one), with `--add-dir` for the other repos, through the same launch path as `/wt new`. Refuses from a session inside that set and when another live pi session uses the set. When you quit an interactive pi session inside a set that still exists, a reminder is printed to stderr with how to reopen or remove it; nothing is ever deleted on quit. |
| `/wt use [NAME]` | Moves this conversation into a free workspace (a set no other live session uses), or back to the original folders (`/wt use original`, or pick `original folders`). Without NAME, pick from the free sets, `original folders` (inside a set) or `+ new workspace` (asks for a name and creates it). The conversation is copied into a new session file in the target repo, pi switches to it, and a message lists the new paths. Added folders follow to the sibling worktrees (the workflow's folder follow rule). Refused while a flow is executing (the workflow cancels the switch), for a set in use (`<set> is in use by pi <pid>`) and for the set this session already runs in. |
| `/wt unlink PATH` | Inside a set: removes the link `PATH` (relative to the repo, for example `node_modules`) in every repo of the set, never its target, so the workspace can install its own packages. The `.git/info/exclude` lines stay. |
| `/wt list` | Lists every set under `<root>` (marked `free` or `in use by pi <pid>`) with, per repo: branch, changed files, ahead/behind (or "not pushed: N commits" against the base branch when there is no upstream), whether `unity/Library` exists, and whether a Unity Editor is open for it (from one `unity status` call; `unknown` if it fails). |
| `/wt update [NAME]` | Brings a set up to date (without NAME: the set this session runs in, otherwise pick one from a list). For every repo (in parallel) it fetches, then: puts the set's branch back when the repo sits on a detached HEAD at a commit of the base branch (what `gh pr merge --delete-branch` leaves behind); fast-forwards a branch with no commits of its own to the base branch (`origin/HEAD`, `main` or `master`); resets a branch whose work was merged as a PR on GitHub (squash or rebase merge, found with `gh`; needs a clean tree); rebases unpushed own commits onto the base branch. Commits that are already pushed are never rebased (that would need a force push), a conflicting rebase is aborted and the branch is left as before, and other detached HEADs are reported and left alone. Uncommitted changes are allowed for a fast-forward (git refuses when it would overwrite one) but block a rebase or reset. |
| `/wt remove [NAME]` | Deletes a set (without NAME, pick one from a list). Refuses if this session uses it, if there is no UI, or if any repo has uncommitted changes or commits not pushed (a squash-merged branch counts as unpushed: delete those by hand). Otherwise asks for confirmation, removes the links first (never their targets), runs `git worktree remove` without `--force`, then `git branch -d` (the branch is kept if git refuses). Deletes the worktree's `Library/` with it. |
| `/wt done` | Runs inside a worktree session and removes the set it runs in. Same checks as `/wt remove`, plus it refuses while a Unity Editor is open in the set (a failing `unity status` only adds a warning). Asks for confirmation, moves pi out of the set, removes the working repo's worktree last (links first, never their targets, no `--force`, then `git branch -d`), shows the report, then asks "Close this pi session?". On refusal or failure the session stays open. |

While a `/wt` command or the automatic update runs, a widget above the editor shows a spinner, the current stage, the git command running now with its folder, and the elapsed time. It is hidden while a dialog is open and removed when the command ends.

## Automatic update

When an interactive pi session starts (or resumes) inside a set, the extension runs the same update as
`/wt update` for every repo of the set (in parallel), with one difference: a repo with uncommitted changes is
skipped. So a clean set follows `main` by itself, a repo left on a detached HEAD by a merged PR gets its
branch back, a branch delivered as a PR on GitHub is reset to `main`, and unpushed own commits are rebased
onto `main` (clean tree only; a conflict aborts the rebase and is reported; pushed commits are never
touched). The set's branch is also put back before each prompt, so a merge during the session does not
leave the repos detached. Headless pi processes (subagents, `pi -p`) never update, so they cannot move
files under a session that is working in the set. The fetches run before the session takes input (15 s
timeout per fetch, no credential dialog), so startup takes a few seconds longer. Nothing is shown when every
repo was already current; otherwise one line per repo. Turn it off with `"autoUpdate": false` in
`worktree.json`, or only the rebase with `"rebaseUnpushed": false`.

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
| `rebaseUnpushed` | `true` | Let the automatic update rebase unpushed own commits onto the base branch. `false` turns off only the automatic rebase; `/wt update` still rebases. |

## Running sessions and workspaces

Every interactive pi session with this extension writes `<agentDir>/live/<pid>.json` (cwd, added folders, set root, busy, the workflow's phase and stage from its `workflow:status` event), every 30 s and on each change, and deletes it on exit. A file counts when it is under 120 s old and its pid is alive; readers delete files of dead pids. The footer entry `wt-sessions` shows the other live sessions as `set: working execute 2/5 · other: needs you · third: idle`, polled every 5 s. A set is in use when another live session's folder or added folder is inside it. This is display and a guard only; it does not lock anything. Headless sessions (no UI) write nothing.

`/wt new` writes `<set>/.pi-set.json` (`{ v, created, branch, repos: [{ main, dir }] }`). Sets made by older versions have none and work as before.

A workspace is a pool entry, not tied to a session: any session can `/wt use` a free one and move on to another or back home.

## Shared files

Links such as `node_modules` and `.pi/git` point into the original repo. In a set, tool calls that would change the original through a link are refused (under the same `unityGuard` switch): `npm`/`pnpm`/`yarn` installs while `node_modules` is linked, recursive deletes (`rm -r`, `rmdir /s`, `Remove-Item -Recurse`, `rimraf`, `del /s`) naming a linked path, and `edit`/`write` inside a linked path. The message says to run `/wt unlink <path>`.

Git calls that fail because another process holds a git lock (`index.lock`, `cannot lock ref`) are retried after 1 s and after 3 s.

## Launching

Windows: `wt.exe -w new new-tab -d <cwd> --title "pi NAME" <pi> --session <file> --add-dir "A\;B"`. Windows Terminal
reads `;` as its own separator, so the extension escapes it. If `wt.exe` is not found, it falls
back to `cmd /c start`. On macOS and Linux nothing is started; the command is printed.

The process starts in the original repo (`<cwd>` above), not in the set, so no pi process holds a workspace folder. pi starts on a session file (`--session`): `/wt new` writes a header-only file whose cwd is the set's working repo, `/wt open` uses the newest earlier session of that folder or makes a new one, and pi moves to the file's own cwd.

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

## Relationship to the workflow extension

The dependency is one-way. This extension uses only the workflow's public contract (see "Public contract for other extensions" in the workflow README): the `session-folders` entry (K1) to learn the added folders, the `--add-dir` flag (K3) when it launches pi, and later the `workflow:status` event (K4). The workflow reads nothing of this extension. The one code import is the shell parser `workflow/readonly-bash.ts`, used by the Unity guard. `boundary.test.ts` enforces both sides.

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
- pi is launched in the original repo (`--session` moves it to the set), so extensions that use `process.cwd()` (for example context-mode's project folder) see the original repo, not the workspace.
- The running-sessions list sees only sessions on this machine, and only those that run this extension with a UI.
- Plain (non-git) folders come back only through the session's saved folders.
- On Windows, a pi started inside a set by an older version keeps that folder locked by its parent processes until pi exits (sessions launched by this version start in the original repo). `/wt done` treats that as removed and starts a detached cleanup that deletes the leftover empty folders (only empty folders, never files) for up to 2 minutes. If it cannot, delete them by hand.
- The progress spinner pauses while gitignored files are copied (a synchronous copy).

## Tests

```
node --experimental-strip-types --test config.test.ts layout.test.ts files.test.ts git-ops.test.ts manage.test.ts unity-guard.test.ts vscode-bridge.test.ts update.test.ts progress.test.ts index.test.ts folders.test.ts boundary.test.ts live.test.ts sessions.test.ts meta.test.ts shared-guard.test.ts
node --test vscode/request.test.js
```
