<!-- pi-workflow plan v1 flow=20261016-1129-wt-open-name-to-reopen-a-worktree-set-pl-3fd8 -->
## Plan: `/wt open NAME` to reopen a worktree set, plus a reminder when you quit a worktree session

### 1. Goal and non-goals
**Goal**
- Add `/wt open NAME`. It starts a new pi in an existing worktree set and continues that folder's most recent session (`--continue`).
- It passes the right `--add-dir`, uses the same launch path as `/wt new` (VS Code bridge, Windows Terminal, `cmd start` or print), and completes the NAME on Tab.
- When you quit an interactive pi session that runs in a worktree set that still exists, pi prints a reminder saying how to reopen or remove it.

**Non-goals**
- Worktrees are never deleted automatically when pi quits.
- `/wt new`, `/wt list`, `/wt remove` and `/wt done` keep their behaviour.
- No new config keys.
- Nothing is written into a set to record which repo was the working one.
- No detection of a pi that is already running in the set.

### 2. User decisions
- D1: Add `/wt open NAME`. It relaunches pi in an existing set with `--continue` and `--add-dir` for the set's other repos, through the same launch path as `/wt new`, with Tab completion of NAME like `/wt remove`.
- D2: Add a reminder when a worktree session quits, saying the set is still on disk and naming `/wt open NAME`, `/wt done` and `/wt remove NAME`.
- D3: Do not auto-delete worktrees on quit. Sets are removed only by `/wt done` or `/wt remove`.

### 3. Facts the executor needs
All paths are under `pi/agent/extensions/worktree/`.

**`index.ts`**
- `SUBCOMMANDS = ["new", "list", "remove", "done"]` is at `index.ts:20`.
- The command is registered at `index.ts:291-315`:
  - description at `:292`
  - completions at `:293-302`, which only complete `remove NAME` (regex `/^remove\s+(\S*)$/i`)
  - dispatch at `:306-309`
  - usage text at `:310`
- `launch(cfg, name, cwd, folders)` is at `index.ts:85-128`. It builds `opts: LaunchOpts`, tries `sendToVscode(pipe, vscodeTerminalSpec(opts))`, then falls back to `launchSpec(opts)` and spawns it detached.
- The end of `newSet` (`index.ts:175-181`) calls `launch` and notifies the result. Use it as the model for the notification.
- Other helpers in `index.ts`:
  - `configFor(pi, ctx)` (`:184-189`) gives the same root from the original repo and from a worktree.
  - `completionConfig()` (`:194-196`) gives the config for completions.
  - `makeGit(pi)` (`:24`).
  - `slash` (`:22`).
- `doneCmd` (`index.ts:217-…`) shows how to call `detectSession(git, cfg, ctx.cwd)` fresh.
- The `session_start` handler (`index.ts:270-282`) caches `session: WtSession | null` (`{ setRoot, branch, unityProject }`, defined at `manage.ts:206-210`).
- `index.ts` already imports `fs` and `path` (`:8-9`).

**`layout.ts`**
- `LaunchOpts` is at `layout.ts:31-39`.
- `launchSpec`:
  - print form at `layout.ts:43-46`: `` `cd ${o.cwd} && ${o.piCommand || "pi"}${dirs}` ``
  - wt.exe args at `:47-53`: `..., "--title", \`pi ${o.name}\`, o.piCommand, ...wtFlag`
  - cmd fallback at `:54`
- `vscodeTerminalSpec` is at `layout.ts:64-69`:
  - win32 `shellArgs: ["/d", "/c", backslashes(o.piCommand), ...flag]`
  - other platforms `shellArgs: flag`
- Name helpers: `checkName` (`layout.ts:7-12`) returns `"give a name: /wt new <name>"` for an empty name. `setRootOf`, `baseName` are at `:20-22`.

**`manage.ts`**
- `listSets(cfg)` (`manage.ts:22`) lists the sets.
- `reposOf(cfg, name)` (`manage.ts:25-28`) lists the set's subfolders that contain `.git`, sorted, as `${set}/${d}`.
- `caseFold`, `norm`, `inside` (`manage.ts:10-12`) are module-private helpers.
- `removeSet` refuses names that leave the root (test at `manage.test.ts:89`).

**pi runtime**
- `SessionShutdownEvent.reason` is `"quit" | "reload" | "new" | "resume" | "fork"` (`…/pi-coding-agent/dist/core/extensions/types.d.ts:637-642`).
- On an interactive quit, pi stops the TUI before it emits `session_shutdown`, then prints "To resume this session: …" (`…/dist/modes/interactive/interactive-mode.js:3506-3519`). Text written in the handler therefore lands on the restored terminal.
- In RPC/print modes stdout carries protocol or output, so the reminder must go to **stderr**, and only when `ctx.hasUI && process.stderr.isTTY`.
- `pi -c/--continue` "Continues the most recent session for the current project" (`docs/cli.md:86-87`).
- The workflow extension merges `--add-dir` into the session's saved folders without repeats (`workflow/index.ts:2673-2697`). With `--continue`, the folders the old session already had come back, and the set's repos are added if missing.

**Tests**
- `layout.test.ts:30` defines `base`. The launch tests are at `:32-77`.
- `manage.test.ts:20-38` defines `fixture()`, which gives `{ d, cfg, env, wt }` with one set `s1` containing `repo`.
- Test command: README "Tests" section.

### 4. Design
**Components**
- `layout.ts`: `LaunchOpts` gets an optional `piArgs?: string[]`, inserted right after the pi command in every launch form. When it is missing or empty, the output is exactly what it is today.
- `manage.ts`: two new pure helpers, plus a small refactor of `reposOf`. Signatures:
  ```ts
  export function repoDirsIn(setRoot: string): string[]            // reposOf's body, by set path
  export type OpenPlan = { cwd: string; folders: string[] } | { choose: string[] } | { error: string };
  export function openPlan(cfg: WtConfig, name: string, preferred: string | null): OpenPlan
  export function quitReminder(setRoot: string): string
  ```
  `reposOf(cfg, name)` becomes `repoDirsIn(setRootOf(cfg, name))`.
- `index.ts`: new `openCmd`, a `launch(..., piArgs: string[] = [])` parameter, completions and usage text, and a `session_shutdown` handler.

**`openPlan` rules**, in order:
1. If `name === ""`, return `{ error: "give a name: /wt open <name>" }`.
2. If `checkName(name)` returns a message, return that message as `{ error }`.
3. Set `repos = reposOf(cfg, name)`. If it is empty, return
   `{ error: \`no worktree set "${name}" in ${cfg.root}\` }`, followed by `` `; sets: a, b` `` when `listSets(cfg)` is not empty.
4. If there is exactly one repo, return `{ cwd: repos[0], folders: [] }`.
5. If `preferred` is not null and equals `baseName(r)` for exactly one repo (compared with `caseFold`), return `{ cwd: r, folders: <the other repos in reposOf order> }`.
6. Otherwise return `{ choose: repos.map(baseName) }`.

**`openCmd(pi, ctx, name)`** flow:
1. Get `cfg = await configFor(pi, ctx)` and `git = makeGit(pi)`.
2. Set `preferred` to `baseName` of `git rev-parse --show-toplevel` run in `ctx.cwd`, or `null` when that call fails.
3. Compute `p = openPlan(...)`.
   - If it is `error`: `notify(error, "error")`.
   - If it is `choose`:
     - Without UI: notify `` `set "${name}" has several repos (${list}); run /wt open from one of them or with a UI` `` as an error.
     - With UI: `ctx.ui.select(\`Working repo for "${name}"\`, choose)`. If the user cancels (`undefined`), notify "Cancelled." with `"info"`. Otherwise call `openPlan(cfg, name, picked)` again; it now resolves.
4. Refuse with `` `this session already runs in worktree set "${name}"` `` when `detectSession(git, cfg, ctx.cwd)?.setRoot` equals `setRootOf(cfg, name)`. Compare them after `slash` and lowercasing on win32. Do this check before launching.
5. Call `l = await launch(cfg, name, p.cwd, p.folders, ["--continue"])`.
6. Notify `` [`Reopening worktree set "${name}" in ${setRootOf(cfg, name)}`, l.error ?? l.text].join("\n") ``, with level `"warning"` if `l.error`, otherwise `"info"`.

**Quit reminder.** `pi.on("session_shutdown", (event, ctx) => …)` writes `quitReminder(session.setRoot)` to `process.stderr` only when all of these hold:
- `event.reason === "quit"`
- `session` is set
- `ctx.hasUI && process.stderr.isTTY`
- `repoDirsIn(session.setRoot).length > 0`, which is false after `/wt done` even if a locked empty folder is left

Wrap the handler in try/catch and ignore errors. It must never block or throw during shutdown.

Exact `quitReminder` format, with `NAME = path.posix.basename(slash(setRoot))`:
```
Worktree set "NAME" is still on disk: <setRoot>
  reopen: /wt open NAME   remove: /wt done (inside it) or /wt remove NAME
```
It ends with `\n`.

**Failure handling**
- Launch failures reuse the fallback and error reporting inside `launch`.
- `openCmd` sits inside the existing try/catch in `handler`.

**Scale.** A set holds a handful of repos and the root a few dozen sets. Everything is synchronous directory reads, with no limit that matters.

**Alternatives rejected**
- Writing a marker file for the working repo at `/wt new`: it changes the set layout and the removal code, and old sets would not have it.
- `--resume` instead of `--continue`: an extra picker on every open.
- Notifying through `ctx.ui` on quit: the TUI is already stopped.
- Writing to stdout: it corrupts RPC/print output.

### 5. Steps
**S1.** `layout.ts:31-69`: add `piArgs?: string[]` to `LaunchOpts` and insert it right after the pi command:
- print form: `cd X && pi --continue --add-dir '…'` (args joined with spaces, each preceded by a space)
- wt.exe: after `o.piCommand`
- cmd fallback: after `backslashes(o.piCommand)`
- `vscodeTerminalSpec` win32: after `backslashes(o.piCommand)`
- `vscodeTerminalSpec` other platforms: `shellArgs: [...piArgs, ...flag]`

If `piArgs` is missing, the output is unchanged.

**S2.** `index.ts:85` `launch`: add a 5th parameter `piArgs: string[] = []` and put it into `opts`. Leave the `newSet` call unchanged.

**S3.** `manage.ts:24-28`: add `repoDirsIn(setRoot)`, move `reposOf`'s body into it, and make `reposOf` delegate. Then add `openPlan` and `quitReminder` (section 4), modelled on the pure helpers in that file. Import `listSets` from the same file; `checkName`, `baseName` and `setRootOf` are already imported (`manage.ts:8`).

**S4.** `index.ts`:
- Add `openCmd` (section 4) next to `removeCmd` (`:204`).
- Set `SUBCOMMANDS` to `["new", "open", "list", "remove", "done"]`.
- Change the completion regex to `/^(remove|open)\s+(\S*)$/i`, with values `` `${m[1].toLowerCase()} ${n}` ``.
- Add the dispatch line `if (sub === "open") return await openCmd(pi, ctx, rest[0] ?? "");`.
- Usage text: `Usage: /wt new NAME | /wt open NAME | /wt list | /wt remove NAME | /wt done`.
- Description: `...: new NAME, open NAME, list, remove NAME, done`.
- Header comment (`:1-5`): mention `/wt open`.
- Import the new helpers.

**S5.** `index.ts`, inside `worktree()` after `session_start`: add the `session_shutdown` handler (section 4). Import `quitReminder` and `repoDirsIn`.

**S6.** `README.md` (worktree):
- Add a table row for `/wt open NAME`. It starts pi with `--continue` in the set's working repo (the only repo, or the one named like this session's repo, otherwise you pick one), with `--add-dir` for the other repos, through the same launch path. It refuses from a session inside that set.
- Add a sentence on the quit reminder (stderr, interactive only, never deletes anything).
- Add to Limits:
  - `/wt open` cannot see a pi already running in the set.
  - Plain (non-git) folders come back only through the continued session.
  - With no earlier session in that folder, `--continue` starts a new one.

**S7.** Repo `README.md:62`: change the worktree mention to include `/wt open NAME`.

### 6. Tests
**`layout.test.ts`**
- "launchSpec piArgs window": `{...base, piArgs: ["--continue"]}` gives `args` ending `"pi.cmd", "--continue", "--add-dir", "A\\;B"`.
- "launchSpec piArgs cmd fallback": `wtPath: null` gives `[..., "pi.cmd", "--continue", "--add-dir", "A;B"]`.
- "launchSpec piArgs print": linux, `piCommand: ""` gives `print === "cd D:/c && pi --continue --add-dir 'A:B'"`.
- "vscodeTerminalSpec piArgs": win32 `shellArgs` is `["/d","/c","pi.cmd","--continue","--add-dir","A;B"]`; linux `shellArgs` is `["--continue","--add-dir","A:B"]`.
- The existing tests stay unchanged and keep passing, which proves the default is unchanged.

**`manage.test.ts`** (use `fixture()`)
- "openPlan opens a one-repo set": `openPlan(cfg, "s1", null)` gives `{ cwd: wt, folders: [] }`.
- "openPlan errors": `""` gives `{ error: "give a name: /wt open <name>" }`; `"Bad!"` gives an error matching `/bad name/`; `"nope"` gives an error matching `/no worktree set "nope"/` and `/sets: s1/`.
- "openPlan with several repos": create a second worktree `${cfg.root}/s1/other`. One way is a second clone added as a worktree; any folder with a `.git` entry works, because `repoDirsIn` only checks `.git`. Then:
  - `preferred "other"` gives `cwd` ending `/s1/other` and `folders` equal to `[wt]`.
  - `preferred null` gives `{ choose: ["other", "repo"] }` (sorted).
- "quitReminder text": `quitReminder("D:/x/wt/s1")` equals the exact two lines from section 4, with a trailing `\n`.
- "repoDirsIn": it lists `${cfg.root}/s1/repo`, and gives `[]` for a missing folder.

**Commands** (in `pi/agent/extensions/worktree`):
```
node --experimental-strip-types --test config.test.ts layout.test.ts files.test.ts git-ops.test.ts manage.test.ts unity-guard.test.ts vscode-bridge.test.ts
node --test vscode/request.test.js
```
Expected: all pass, 0 fail.

### 7. Done when
- `/wt open NAME`:
  - starts pi with `--continue` in the chosen repo worktree of set NAME, with `--add-dir` for the set's other repos, through the same VS Code / Windows Terminal / cmd / print path as `/wt new`
  - completes NAME on Tab
  - errors clearly for a missing or bad name or an unknown set, and refuses from a session inside that same set
- Quitting an interactive pi session inside a set that still has repo worktrees prints the reminder to stderr. Nothing prints in other cases (reload, new or resume, RPC or print mode, after `/wt done`).
- No code path deletes worktrees on quit.
- All tests listed in section 6 pass.
- Both READMEs document `/wt open` and the reminder.

### 8. Risks, rollback, what not to touch
**Risks**
- If a pi version handles `--continue` differently when there is no session, the open still starts pi (it is documented in Limits).
- On a signal-triggered shutdown, the reminder may print before the TUI restore. It is cosmetic.

**Rollback:** revert the two commits.

**Do not touch**
- the removal logic (`removeSet`, `finishSet`, `SWEEP_SCRIPT`)
- `git-ops.ts`, `config.ts`, `files.ts`, `unity-guard.ts`, `vscode-bridge.ts`, `vscode/`
- the workflow extension
- `newSet`'s launch behaviour

### 9. Commits
1. `feat(worktree): /wt open NAME reopens a worktree set with pi --continue`, with files `worktree/layout.ts`, `layout.test.ts`, `manage.ts` (`repoDirsIn`, `openPlan`), `manage.test.ts` (openPlan and repoDirsIn tests), `index.ts` (launch piArgs, openCmd, completions, usage), `worktree/README.md` (open row and limits) and the repo `README.md`.
2. `feat(worktree): remind on quit that the worktree set is still on disk`, with files `manage.ts` (`quitReminder`), `manage.test.ts` (quitReminder test), `index.ts` (`session_shutdown` handler) and `worktree/README.md` (reminder sentence).

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 `layout.ts:31-69`: add `piArgs?: string[]` to `LaunchOpts` and insert it right after the pi command:
- [ ] S2 `index.ts:85` `launch`: add a 5th parameter `piArgs: string[] = []` and put it into `opts`. Leave the `newSet` call unch
- [ ] S3 `manage.ts:24-28`: add `repoDirsIn(setRoot)`, move `reposOf`'s body into it, and make `reposOf` delegate. Then add `open
- [ ] S4 `index.ts`:
- [ ] S5 `index.ts`, inside `worktree()` after `session_start`: add the `session_shutdown` handler (section 4). Import `quitRemin
- [ ] S6 `README.md` (worktree):
- [ ] S7 Repo `README.md:62`: change the worktree mention to include `/wt open NAME`.
