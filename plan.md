<!-- pi-workflow plan v1 flow=20261021-0011-reusable-worktree-workspaces-one-way-con-d2ef -->
## Plan: Reusable worktree workspaces, one-way contract with the workflow, safe cleanup

### 1. Goal and non-goals

**Goal.** Make several tasks in the same projects easy to run in parallel with git worktrees:
- A worktree set ("workspace") is reusable. It reattaches its branch after a merge, follows `main` and rebases unpushed work onto it.
- Any interactive pi session can attach to a free workspace and move between workspaces.
- Sessions can see each other, and two sessions can't run the same flow.
- Workspaces can't corrupt shared files.
- One command cleans up everything that is safe to remove; undelivered work is only removed after an explicit discard with a backup.
- The worktree extension depends only on a small, documented public contract of the workflow extension. The workflow extension knows nothing about worktrees.

**Non-goals.**
- No change to delivery itself (`workflow/delivery.ts`) or to the push guard.
- No force push anywhere.
- No Unity Editor sharing between workspaces.
- No messages between sessions.
- No deletion of pi session files.
- S6 (hand an approved plan to another workspace) and a lock retry for the workflow's own git calls are backlog ideas only.
- No third "folders" extension.
- macOS/Linux terminal launching stays "print the command".

### 2. User decisions

- D1. Option A: the automatic update rebases unpushed own commits onto `origin/<base>` when a session starts in or attaches to a workspace, only on a clean tree, and aborts on conflict.
- D2. `rebaseUnpushed: false` turns off only the automatic rebase; `/wt update` still rebases.
- D3. Commits that are already pushed are never rebased, because that would need a force push, which the push guard refuses. Keep rebasing `main` into the branch before merge to keep history clean.
- D4. A pi session is not tied to a workspace. Workspaces are a pool. A session attaches to a free one (`/wt use`) and can move to another free one or back to the original folders.
- D5. Workspace names are automatic. `/wt new` without a name suggests the next free name and Enter accepts it. `/wt rename` renames later.
- D6. Cleanup follows C1–C8:
  - one removal path, set states and `/wt clean`
  - discard with backup refs, kept 30 days (`backupDays`)
  - remote branch deletion behind its own separate confirmation
  - `/wt done` moves the conversation home, then removes the set
  - launch through `--session`, set metadata, and session files are never deleted
- D7. Session interaction is included: S1 (list of running sessions with a footer, replacing leases), S2 (flow claims), S3 (shared-file guard plus `/wt unlink`), S4 (git lock retry in the worktree extension). S5 (`PI_SUBAGENT`) is dropped. S6 stays a backlog idea built on K3.
- D8. The dependency is one-sided: worktree may use the workflow's public contract (K1 entry, K1b rule, K2 hook behaviour, K3 flags, K4 event); the workflow never refers to the worktree extension. No circular dependency, enforced by tests.
- D9. The "delivered" check keeps the gh merged-PR check as a fallback for squash or rebase merges done on GitHub, after the git ancestor check.
- D10. Delivery happens in five stages, in this order: lifecycle, contract, workspaces, cleanup, naming.

### 3. Facts the executor needs

**pi API** (paths under `C:/Users/IEC-WW/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/pi-coding-agent/dist/`)
- `core/session-manager.d.ts:394` has `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir?, options?)`. `core/session-manager.js:1374-1410` writes the new file at once:
  - the header is `{type:"session", version, id, timestamp, cwd, parentSession}`
  - the file goes in `getDefaultSessionDir(targetCwd)`
  - it throws if the source file is missing or empty
- `core/session-manager.js:797-809`: a new session file is only written once it has a user or assistant message. `SessionManager.create` alone leaves no file.
- `core/session-manager.js:1326-1347` (`open`) and `665-683`: an existing file containing only a header loads fine, with `cwd` taken from the header. A missing file falls back to `process.cwd()`.
- `main.js:267,580,702`: `pi --session <file>` runs the session in the header's `cwd`, not in the process cwd.
- `index.d.ts:21` exports `SessionManager`, `CURRENT_SESSION_VERSION` and the type `SessionInfo`.
- `core/session-manager.d.ts:163-177` (`SessionInfo`: `path`, `cwd`, `created`, `modified`) and `:408` (`SessionManager.list(cwd)`).
- `core/session-manager.js:15-19`: session IDs must match `^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$`.
- `core/extensions/types.d.ts:316` has `ctx.switchSession(path, { withSession })`. `withSession` gets a fresh context bound to the new session (`:327`). `core/agent-session-runtime.js:128-146`: the switch emits `session_before_switch`, tears down the old runtime and creates a new one in the header cwd, then fires `session_start` with reason `resume`.
- `core/extensions/types.d.ts:589-593`: `SessionBeforeSwitchEvent {type, reason: "new"|"resume", targetSessionFile?}`. `:1130-1132`: the result is `{cancel?: boolean}`. `:1191` registers it with `pi.on("session_before_switch", …)`. `core/agent-session-runtime.js:84-88` honours `cancel`.
- `core/extensions/types.d.ts:1406` has `pi.events: EventBus`; `core/event-bus.d.ts:1-4` has `emit(channel, data)` and `on(channel, handler) → unsubscribe`.
- `core/extensions/types.d.ts:15-25`: `ui.select`, `ui.confirm`, `ui.input(title, placeholder?)`, `ui.setStatus(key, text|undefined)`. `:236`, `:290`: `ctx.isIdle()`, `ctx.waitForIdle()`.
- Subagents run with `-p --no-session --no-extensions` (`workflow/subagent.ts:185`), so `ctx.hasUI` is false and the worktree extension is not loaded in them.

**Worktree extension** (`pi/agent/extensions/worktree/`)
- `index.ts:23-41`: `addedFolders` reads the workflow's internal `workflow-state` entry. This is replaced by K1.
- `index.ts:27-33`: `makeGit` (where S4 goes).
- `index.ts:79-96`: `collect`.
- `index.ts:98-129`: `launch`.
- `index.ts:132-153`: `build`.
- `index.ts:155-190`: `newSet`.
- `index.ts:242-301` (approx.): `removeCmd` / `openCmd`. The `--continue` launch is at `:286`.
- `index.ts:305-323`: `updateCmd`.
- `index.ts:325-358`: `doneCmd`, with the sweep and the close question.
- `index.ts:360-438`: the factory with `session_start` (auto update), `session_shutdown` (quit reminder), `before_agent_start` (prompt section), `tool_call` (Unity guard) and command registration with `SUBCOMMANDS`.
- `update.ts:23-46`: `updateRepo`. `:37` skips a detached HEAD; `:36` skips when there are own commits. `:49-59`: `updateSet` runs one repo after another.
- `git-ops.ts:171-181`: `baseOf` / `baseRefOf`.
- `git-ops.ts:183-198`: `repoStatus`.
- `git-ops.ts:206-221`: `removeChecks`. "Unpushed" against base at `:197`.
- `git-ops.ts:223`: `mainRepoOf`.
- `git-ops.ts:129-150`: `rollback`, the pattern for undoing partial work.
- `manage.ts:95-110`: `removeSet`.
- `manage.ts:134-176`: `removeAll`, including `onlyEmptyDirs` and `isRegistered`.
- `manage.ts:192-213`: `finishSet`.
- `manage.ts:215-230`: `SWEEP_SCRIPT`.
- `manage.ts:244-262`: `detectSession`.
- `manage.ts:264-267`: `worktreePrompt`.
- `config.ts:6-16`: `WtConfig`. `config.ts:23-34`: defaults. `config.ts:41-69`: `mergeConfig`, with the boolean key pattern at `:50-53`.
- `layout.ts:7,20-23`: `checkName`, `setRootOf`, `branchOf`, `baseName`, `targetOf`. `:32-74`: `LaunchOpts`, `launchSpec`, `vscodeTerminalSpec`.
- `files.ts:7,27`: `isLink`, `unlinkLink`, which removes only the link and throws on a real folder.
- `unity-guard.ts:141`: `guardProblem(toolName, input, opts)`, the pattern for S3.
- `progress.ts:33-…`: `Progress` handles several git calls running at once (`runs: Running[]`).
- `README.md` "Limits": the squash-merge, `/wt open`, `git worktree prune` and Windows lock bullets must be rewritten. "Tests" holds the test command.
- Evidence of the detached-HEAD problem: `D:/projects/wt/test-core/*` are all on a detached HEAD at `Merge pull request #… from iecgames/wt/test-core`, and the reflog shows `checkout: moving from wt/test-core to origin/main`. This comes from `gh pr merge --delete-branch` (`workflow/delivery.ts:100-103`, config `deleteBranch: true`).

**Workflow extension** (`pi/agent/extensions/workflow/index.ts`)
- `:97`: `Phase` is `"off" | "plan" | "execute"`. `:99-158`: `FlowState`, with `folders` at `:155-156` and `planDoc` at `:138`.
- `:179`: `STATE_ENTRY`.
- `:292-300`: the flags `add-dir` and `flow`.
- `:308-313`: `persist()`.
- `:352`: `updateStatus(ctx)`.
- `:397`: `setPhase`.
- `:459`: `currentStages()`.
- `:610-621`: `gitRoot`.
- `:624-632`: `existingFolders`.
- `:861,879`: `planDirs` and `planDirFor(root)`.
- `:914-925`: the status object, with `title: planTitle(snap.plan)`.
- `:1004`: `planMilestone`.
- `:1106-1160`: `resumeFlow`, with the busy checks at `:1108-1111` and `:1156-1159` and the picker labels at `:1150`.
- `:1226-1239`: resume adds folders.
- `:2705-2729`: `applyAddDir`.
- `:2731-2775`: `session_start`, which restores state at `:2737-2741` and calls `applyAddDir` for non-reload reasons.
- `:2815-2904`: `/folders` add (`:2885`) and remove (`:2898`).
- `:2940`: `/flow off`.
- `repos.ts:10-18`: `repoKey`, for path comparison.
- `plan-store.ts:11-16`: the plans dir is `<git-common-dir>/pi/plans`.
- `readonly-bash.ts:517`: `git worktree list` is allowed.
- No file under `workflow/` mentions `wt/`, `.pi-set` or `/live` today (checked by grep).
- `README.md:187`: the test command.
- `docs/workflow-improvements.md`: the rules are at `:7-11` and the Status line at `:5`. Next free IDs: A10 and D7. Effect measurement table at `:79-121`.

### 4. Design

**Components and responsibilities**
- **workflow (unchanged role):** flows, plans, guards, delivery, and the session's folder list. New:
  - publishes K1
  - applies K1b
  - cancels switches (K2)
  - emits K4
  - writes and checks flow claims (S2)
- **worktree:** workspace sets and their git state:
  - reattach, update, rebase
  - the running-sessions list and footer (S1)
  - moving sessions (`/wt use`, `/wt done`)
  - launching through `--session` (C6)
  - set metadata (C7)
  - the shared-file guard and `/wt unlink` (S3)
  - lock retry (S4)
  - cleanup (C1–C5)
  - naming and rename
  - the Unity guard (unchanged)
- **Dependency direction:**
  - worktree → workflow public contract (K1, K3, K4; it observes K2 only as a cancelled switch) and the pi API.
  - workflow → pi API and git only.
  - The tests in §6 enforce this.

**Contracts (documented in both READMEs)**
- **K1. Session entry** `customType: "session-folders"`, data `{ "v": 1, "cwd": "<ctx.cwd, forward slashes>", "folders": ["<absolute, forward slashes>", …] }`.
  - The workflow is the only writer. It appends a K1 entry whenever `state.folders` changes (`applyAddDir`, `/folders add|remove`, resume, K1b), and at every non-reload `session_start` when the newest K1 on the branch is missing or differs from `{ctx.cwd, state.folders}`. That second case is also the migration for old sessions.
  - The worktree extension only reads the newest K1 on the branch. A missing K1 means no added folders.
- **K1b. Folder follow rule (workflow, git only).** It runs at non-reload `session_start` when saved state exists and the newest K1's `cwd` differs from `ctx.cwd` (compared with `repoKey`).
  - Let `R` be the git top of `ctx.cwd`. If `ctx.cwd` is not a repo, nothing changes. Let `P = dirname(R)`.
  - For each saved folder `f` that is inside a git repo with top `T`:
    1. Read the worktrees of `T` from `git worktree list --porcelain`.
    2. Candidates are worktree paths `W` with `dirname(W) == P`.
    3. With exactly one candidate, `f` becomes `W/<f relative to T>`, if that folder exists.
    4. Otherwise `f` stays as it is.
  - Plain folders never change. A result equal to the working folder is dropped, and duplicates are removed.
  - Afterwards `persist()` runs, then K1 is appended. This runs before `applyAddDir`.
- **K2. Switch guard (workflow).** `pi.on("session_before_switch")` returns `{cancel: true}` when `state.phase === "execute"` and `state.approvedPlan` is set, for both reasons `new` and `resume`. It notifies `workflow: a flow is executing; finish it or leave it with /flow off before switching sessions`.
- **K3. CLI flags.** The `--add-dir` value is folders joined by `;` on Windows and `:` elsewhere, with absolute paths. The worktree extension passes it only when there are added folders. It also passes `--session <file>`, which is pi's own flag.
- **K4. Event** `pi.events.emit("workflow:status", { v: 1, phase: "off"|"plan"|"execute", flowId?: string, title?: string, stage?: number, stages?: number })`.
  - Emitted from `updateStatus`, only when the payload differs from the last one emitted.
  - `flowId` comes from `state.planDoc?.flowId`.
  - `title` comes from `planTitle(state.approvedPlan)` when an approved plan exists.
  - `stage` and `stages` come from `currentStages()`.
  - Listeners that don't exist or fail are ignored.

**Files written by the worktree extension**
- **Running-session file (S1):** `<agentDir>/live/<pid>.json`.
  - Data: `{ "v": 1, "pid": n, "started": ISO, "updated": ISO, "sessionFile": string|null, "cwd": string, "folders": string[], "set": "<set root>"|null, "busy": boolean, "flow": { "phase", "flowId"?, "title"?, "stage"?, "stages"? } | null }`.
  - Only sessions with `ctx.hasUI` write it. It is rewritten on `session_start`, `agent_start` (busy true), `agent_end` (busy false), each K4 event and every 30 s, and deleted on `session_shutdown`. Timers and the K4 subscription are cleared on `session_shutdown`.
  - **Live** means `updated` is less than 120 s old and `process.kill(pid, 0)` succeeds (an `EPERM` error counts as alive). Readers delete files whose pid is dead.
  - A set is **in use** when another live entry has its `cwd` or any of its `folders` inside the set root.
- **Set metadata (C7):** `<set>/.pi-set.json`, data `{ "v": 1, "created": ISO, "branch": "wt/w1", "repos": [{ "main": "<original repo top>", "dir": "<folder name in set>" }] }`.
  - Written at the end of a successful `/wt new` build, and updated by rename.
  - Sets without it (for example `test-core`) fall back to `mainRepoOf` for each repo and to `branchOf(cfg, name)`.
- **New session file (C6):** a single JSONL header line `{ "type": "session", "version": CURRENT_SESSION_VERSION, "id": <id>, "timestamp": ISO, "cwd": path.resolve(cwd) }`.
  - Path and id: take `getSessionFile()` and `getSessionId()` from `SessionManager.create(cwd)`. If `getSessionFile()` is undefined, use `<getSessionDir()>/<timestamp with : and . replaced by ->_<id>.jsonl`, as in `forkFrom:1396`.
  - Create the folder and write with flag `wx`.
- **Backup refs (C4):** `refs/wt-backup/<set>/<dir>/<yyyymmdd-hhmmss>` (commits) and `…-wip` (output of `git stash create`). They live in the repo's shared ref store.
- **Flow claim (S2, written by the workflow):** `<plans dir of the flow>/<flowId>/claim.json`, data `{ "v": 1, "pid": n, "host": os.hostname(), "cwd": string, "updated": ISO }`.
  - Written when an unfinished `planDoc` exists (at `planMilestone` and every 60 s). Deleted when the flow finishes or is abandoned, and on `session_shutdown`.
  - **Live** means the same host, the pid is alive and `updated` is less than 180 s old.

**Repo "delivered" check (stage 1, `git-ops.ts`), used everywhere**
- Inputs: worktree dir, base ref, branch name.
- Result: `{ delivered: "base" | "pr" | null, pr?: number, own: number, dirty: number, ghError?: string }`.
- Rules:
  - `dirty > 0` → not delivered.
  - `git merge-base --is-ancestor HEAD <base>` succeeds → `"base"`.
  - Otherwise run `gh pr list --head <branch> --state merged --json number,headRefOid --limit 20` in the dir. If a PR's `headRefOid` equals HEAD's SHA → `"pr"` with its number.
  - gh missing or failing → `null` with `ghError: "gh unavailable"`.
- Uses `pi.exec("gh", …)` through a `Gh` function parameter, the same pattern as `Git`.

**Data model, migration and compatibility**
- **K1 migration:** it is written at the first session start after stage 2. Old `workflow-state.folders` stays as the workflow's internal copy.
- **Old sets:** the C7 fallbacks above. Old sessions launched in a set folder keep working. The Windows lock fallback (sweep) stays for them.
- **New config keys** in `worktree.json`:
  - `rebaseUnpushed` (boolean, default `true`)
  - `backupDays` (number ≥ 0, default 30, 0 = keep forever)

  Invalid values give a warning, following `config.ts:50-53`.

**Failure handling**
- Fetch fails: work from the last known refs (main only grows, so a set can only look less delivered).
- Rebase conflict: run `git rebase --abort` and report.
- A step fails partway: the removal engine is idempotent (missing worktrees and branches are skipped), and the next `/wt clean` finishes the job.
- Rename fails: repos already moved are moved back.
- A switch is cancelled by K2: delete the forked file this command just wrote, and report.
- A registry or claim write fails: ignore it. Display only.

**Scale assumptions**
- 2–5 sets of 1–3 repos, at most about 10 live sessions.
- `/wt clean` does one fetch per original repo (in parallel), about 4 git calls and 1 gh call per worktree, and finishes in about 3–10 s.
- The footer reads at most 10 small files every 5 s.
- The reattach before each prompt costs one `rev-parse` per repo when attached (≈50 ms).
- Limits:
  - beyond about 30 sets or 100 live files, `/wt clean` takes over 30 s and the footer poll should become a file watcher
  - sessions on another machine are never seen (the registry is local)
  - PR detection checks only the 20 latest merged PRs for a branch name

**Alternatives rejected**
- `/wt use` writing workflow state: this is write coupling, against D8.
- A third "folders" extension: two writers, plus a migration.
- Environment variables (`PI_SUBAGENT`, `PI_FLOW_RESUME`): `hasUI` and K3 cover them.
- Lease files in the set folder: replaced by the running-sessions file, one source of truth.
- Resetting a branch with undelivered work: never.
- Unity Editor serving workspaces: switching means a `Library/` reimport.
- Deleting session files: they are pi's data.

### 5. Steps

### Stage 1: Workspace lifecycle (reattach, delivered check, update with rebase)

**S1.** `worktree/git-ops.ts`, next to `repoStatus` (`:183`): add `deliveredState(git, gh, wt, baseRef, branch)` implementing the "delivered" check from §4. Add the type `Gh` (same shape as `Git`). Model the result handling on `repoStatus`.

**S2.** `worktree/update.ts`: add `reattach(git, wt, branch)`.
- If HEAD is detached and `git merge-base --is-ancestor HEAD <base>` succeeds:
  - if branch `<branch>` doesn't exist, or its tip is an ancestor of HEAD → run `git switch -C <branch>` with no start point (same commit, no file changes, allowed on a dirty tree) and return state `"reattached"` with the text `<dir>: reattached to <branch>`
  - if the branch has commits that are not in HEAD → return `"skipped"` with `branch <branch> has commits not in HEAD; left detached`
- Any other detached HEAD → no action.
- An attached HEAD → no action. That costs one `rev-parse --abbrev-ref HEAD` call, and the base is resolved only when detached.

**S3.** `worktree/update.ts:23` `updateRepo`: change the signature to take an options object `{ allowDirty, rebase: boolean, branch, gh }`. Keep `fetchGit`. New order:
1. Fetch with `--prune`.
2. `reattach`.
3. Status: dirty count, `behind` (`HEAD..base`), `own` (`base..HEAD`).
4. If `own > 0`:
   - **Delivered in a PR** (`deliveredState` says `"pr"`) and clean → `git switch -C <branch> --no-track <base>`. State `"updated"`, text `work delivered in PR #N; reset to <base>`. If dirty → `"skipped"` with `delivered in PR #N; commit or discard changes, then /wt update`.
   - **`behind == 0`** → `"current"`.
   - **Some commits pushed** (`git rev-list --count <base>..HEAD --not --remotes` < `own`) → `"skipped"` with `<own> own commit(s), pushed: rebasing needs a force push; merge <base> by hand or deliver as is`.
   - **Dirty** → `"skipped"` with `<own> own commit(s), <behind> behind <base>, <n> uncommitted change(s): commit, then /wt update`.
   - **`rebase` false** → `"skipped"` with `<own> own commit(s), <behind> behind <base>: /wt update to rebase`.
   - **Otherwise** run `git rebase --quiet <base>`.
     - On success: new state `"rebased"`, text `rebased <own> commit(s) onto <base> (<short sha>)`.
     - On failure: run `git rebase --abort`, state `"failed"`, text `rebase onto <base> conflicts; left as before: rebase by hand`.
5. If `own == 0`: the existing fast-forward path (`:35-45`), unchanged.

Add `"reattached"` and `"rebased"` to `UpdateState`. `worthNotifying` stays "anything not current".

**S4.** `worktree/update.ts:49` `updateSet`: run the repos in parallel with `Promise.all`. They are different repos with separate object stores. Fix the comment. Keep the per-repo try/catch.

**S5.** `worktree/config.ts`: add `rebaseUnpushed` (default `true`) to `WtConfig`, `defaults` and `mergeConfig`, following the `autoUpdate` pattern at `:50-53`.

**S6.** `worktree/index.ts`:
- **Startup update** (`session_start`, `:360-397`): pass `rebase: cfg.rebaseUnpushed`, `allowDirty: false`, the set branch and gh.
- **`/wt update`** (`updateCmd`, `:305-323`): pass `rebase: true`, `allowDirty: true`.
- **Reattach before each prompt** (`before_agent_start`, `:400`): before setting the prompt section, when `session` is set, run `reattach` for each repo of the set with no fetch and existing refs. Errors are ignored.
  - If any repo was reattached, refresh `session.branch` and notify one line per reattached repo.
  - The set branch is `branchOf(cfg, basename(setRoot))`. Keep the cfg from `session_start` in the factory closure for this.
- **gh function:** a `makeGh(pi)` that runs `pi.exec("gh", args, { cwd, timeout: 20000 })`.

**S7.** `worktree/README.md`:
- Rewrite "/wt update" and "Automatic update": reattach after merge, recycle after a PR merge, rebase of unpushed commits (D1–D3), parallel fetches.
- Add `rebaseUnpushed` to the Config table.

### Stage 2: One-way contract (workflow publishes, worktree reads)

**S8.** `workflow/index.ts`, K1:
- Add a constant `FOLDERS_ENTRY = "session-folders"`.
- Add `publishFolders(ctx)`. It appends `{v:1, cwd, folders}` via `pi.appendEntry` when the newest `session-folders` entry on the branch differs.
- Call it after `persist()` in:
  - `applyAddDir` (`:2727`)
  - `/folders add` (`:2885`) and `/folders remove` (`:2898`)
  - resume (`:1238`, after state is saved)
  - `session_start` (both branches at `:2737-2775`, reason ≠ `reload`)

**S9.** `workflow/index.ts` `session_start` (`:2741`): before `applyAddDir`, apply K1b as specified in §4.
- Use the existing `gitRoot` (`:610-621`) and `repoKey`.
- Put the pure matching part (porcelain parse plus choosing the candidate) in `repos.ts` as `followFolders(folders, newTop, worktreesOf)`, so it can be tested without git.
- When any folder changed, notify `workflow: added folders follow the working folder: <old> → <new>` (one line per change).

**S10.** `workflow/index.ts`, K2: register `pi.on("session_before_switch", …)` exactly as in §4. Model the notification on `resumeFlow`'s `notify` (`:1107`).

**S11.** `workflow/index.ts` `updateStatus` (`:352`), K4: emit `workflow:status` with the payload from §4, deduplicated by its JSON.

**S12.** `workflow/plan-store.ts` and `workflow/index.ts`, S2:
- In `plan-store.ts` add `writeClaim(dir, flowId, claim)`, `readClaim(dir, flowId)` and `dropClaim(dir, flowId)`, plus a pure `claimLive(claim, now, host, isAlive)`.
- In `index.ts`:
  - write the claim at each `planMilestone` (`:1004`) while the flow is unfinished
  - refresh it on a 60 s timer, started when a claim is first written and cleared on finish and on `session_shutdown`
  - drop it when `planMilestone` gets `finished`, on `setPhase` leaving execute (`:405`) and on `session_shutdown`
  - the dir is `planDirs.get(flowId)` (`:861`)
- In `resumeFlow`:
  - read the claim of each candidate from `planDirFor(root)`
  - append ` — running in <cwd> (pid <n>)` to the labels of live claims held by another pid (`:1150`)
  - refuse a chosen or `wanted`-matched live claimed flow with `<title> is running in <cwd> (pid <n>); finish or leave it there first`
  - a stale claim is allowed, with the notice `took over a stale claim from pid <n>`

**S13.** `worktree/index.ts:23-41`: `addedFolders` reads only the newest `session-folders` entry. Remove `STATE_ENTRY` and every mention of `workflow-state`.

**S14.** `workflow/README.md`: new section "Public contract for other extensions" listing K1, K1b, K2, K3 and K4 with the exact formats from §4, and the rule that the workflow never refers to other extensions. Add a Claims paragraph near resume. Add the new test files to the test command (`:187`). In `worktree/README.md`, "Relationship to the workflow extension" states that worktree uses only K1, K3 and K4.

**S15.** `docs/workflow-improvements.md`: add the following rows, following the rules at `:7-11`.

| ID | Item | Status |
|---|---|---|
| D7 | K1 and K1b, folder list entry and follow rule | **Done:** |
| D8 | K2, switch guard during execute | **Done:** |
| D9 | K4, status event | **Done:** |
| D10 | S2, flow claims | **Done:** |
| D11 | Boundary tests | **Done:** |
| A10 | Lock retry for the workflow's git calls | idea only |
| A11 | S6, hand an approved plan to a free workspace via `--flow resume:<id>` | idea only |

Update the Status line, and add Effect measurement rows for D7–D11 and A10–A11.

### Stage 3: Workspaces (running sessions, `/wt use`, launch, guards)

**S16.** New `worktree/live.ts`:
- `writeLive(dir, entry)` and `removeLive(dir, pid)`.
- `readLive(dir, now, isAlive)`: returns live entries and deletes dead-pid files.
- `setInUse(entries, setRoot, ownPid)`: returns the holder or null.
- `footerText(entries, ownPid)`, with these rules:
  - label = basename of `set`, or of `cwd`'s repo when `set` is null
  - state = `working` if busy, plus ` <phase> <stage>/<stages>` when the flow phase is execute
  - when not busy: `needs you` if the flow phase is plan or execute, otherwise `idle`
  - entries joined by ` · `, at most 4, then ` +N`
  - undefined when there are no other entries

Pure functions take `now` and `isAlive` as parameters. Model the I/O style on `manage.ts`.

**S17.** `worktree/index.ts` factory, wiring S1:
- In interactive sessions (`ctx.hasUI`):
  - write the live entry on `session_start`, `agent_start`, `agent_end`, each `workflow:status` (only payloads with `v === 1`) and every 30 s
  - `folders` comes from K1
  - poll every 5 s and set `ctx.ui.setStatus("wt-sessions", footerText(...))`
  - on `session_shutdown`: clear all timers, unsubscribe, remove the entry
- Headless sessions do none of this.

**S18.** New `worktree/sessions.ts`:
- `newSessionFile(cwd)`: implements the C6 header file from §4.
- `latestSession(cwd, after)`: the newest `SessionManager.list(cwd)` entry with `modified > after`, or null.

**S19.** `worktree/layout.ts:32-74` and `worktree/index.ts:98-129`, C6 launch:
- `LaunchOpts` gets `sessionFile`. The pi arguments become `--session <file>` plus `--add-dir` when there are folders. `--continue` is removed.
- The process cwd (wt.exe `-d`, the spawn cwd and the VS Code request `cwd`) is the original working repo: `mainRepoOf` of the working worktree. If that is not found, use `cfg.root`.
- For `/wt new`: `newSessionFile(<working worktree cwd>)`.
- For `/wt open`: `latestSession(cwd, created from .pi-set.json, or 0)`, otherwise `newSessionFile`.
- The quoting and escape rules for `;` stay as they are.

**S20.** `worktree/index.ts` `build` (`:132-153`): after success, write `.pi-set.json` (C7). New `worktree/meta.ts` with `readMeta(set)` / `writeMeta(set, meta)`, tolerant of missing or invalid files (returns null).

**S21.** New command `/wt use [NAME]` in `worktree/index.ts` (behaviour fixed by D4):
1. `await ctx.waitForIdle()`.
2. **Picker** (when NAME is missing; with no UI, refuse with `give a name`): free sets with a one-line state, then `original folders` (only when the session is in a set), then `+ new workspace`.
   - `+ new workspace` runs the `/wt new` creation path without launching (refactor `newSet` into `createSet`, which returns the targets), then continues with the new set.
3. **Refusals:**
   - target in use → `<set> is in use by pi <pid>`
   - target is this session's set → `this session already runs in <set>`
4. **Target cwd:**
   - the set's checkout of the current working repo, matched by `git rev-parse --git-common-dir`, plus the current subfolder
   - no match: the only repo when the set has one, otherwise a picker over the set's repos (`openPlan` choose, `manage.ts:31-49`); with no UI, refuse
   - for `original folders`: `mainRepoOf(<working worktree>)` plus the subfolder
5. **New session file:** if `ctx.sessionManager.getSessionFile()` exists on disk, `SessionManager.forkFrom(file, targetCwd)`. Otherwise `newSessionFile(targetCwd)`.
6. **Switch:** `ctx.switchSession(newFile, { withSession })`.
   - If cancelled: delete `newFile` and notify `move cancelled`.
   - In `withSession(nctx)`:
     - read K1 from `nctx.sessionManager.getBranch()`
     - send one custom message, `customType: "worktree-moved"`, `display: true`, content: `This conversation moved to <targetCwd> (<set name or "original folders">). Repo paths now: <cwd>, <folders…>. Earlier messages refer to the old paths.`
     - list the set's repos that are neither the new working repo nor in K1 as `not attached: <dirs>; add them with /folders add`

**S22.** `worktree/index.ts`, in-use checks:
- `/wt open` refuses a set in use (`setInUse`).
- `/wt remove` refuses it with `in use by pi <pid>`.
- `/wt list` adds `in use by pi <pid>` or `free` for each set.

**S23.** New `worktree/shared-guard.ts`, S3: `sharedProblem(toolName, input, { cwd, setRoot, linked: string[] })`, where `linked` is the absolute paths of links in the set.
- **Package installs.** In the text of `bash`, `ctx_execute` (shell) and `ctx_batch_execute` commands:
  - patterns: `npm (install|i|ci|add|update)`, `pnpm (install|i|add|update)`, and `yarn` at the end of a command or followed by `install|add|upgrade`
  - refused when any linked path ends in `/node_modules`
  - message: `node_modules in <dir> is linked to the original repo; installing would change it. Ask the user to run /wt unlink node_modules first.`
- **Recursive deletes.**
  - patterns: `rm` with `-r`, `-R` or `--recursive`; `rmdir /s`; `Remove-Item` with `-Recurse`; `rimraf`; `del /s`
  - refused when the text contains a linked path's relative name or absolute path as a token
  - message: `<path> is a link to the original repo; deleting recursively could delete the original's files. Ask the user to run /wt unlink <rel>.`
- **`edit` / `write`:** refused when the resolved path is inside a linked path.
- Wired into `tool_call` (`index.ts:404`) after the Unity guard, under the same `guardOn` switch.
- The linked list is computed at `session_start` (for each repo of the set, the `cfg.link ∪ DEFAULT_LINK` paths where `isLink`) and refreshed after `/wt unlink`.
- Model on `unity-guard.ts:120-157`.

**S24.** New command `/wt unlink PATH`.
- Only inside a set; otherwise `run /wt unlink inside a worktree session`.
- For each repo of the set where `<repo>/<PATH>` `isLink`: `unlinkLink` it, which removes the link and never the target.
- Report each one, plus `install the packages in this workspace now`. Leave the `.git/info/exclude` lines in place.
- If none matched: `<PATH> is not a link in this set`.

**S25.** `worktree/index.ts:27` `makeGit`, S4: retry a call that failed with stderr matching `/cannot lock ref|Unable to create '.*\.lock'|index\.lock/` after 1 s, then after 3 s, then return the last result. Put this in `git-ops.ts` as `withLockRetry(git, sleep)` so it can be tested.

**S26.** `worktree/README.md`:
- document `/wt use`, `/wt unlink`, the footer, the running-sessions file, `.pi-set.json` and the launch through `--session`
- remove the `/wt open` "cannot see a pi already running" limit
- change the Windows lock limit to apply only to sessions started inside a set by older versions
- add the shared-file guard, and the S4 note to the Limits section
- update `SUBCOMMANDS`, completions (`use` gets set names) and the usage text

### Stage 4: Cleanup (one removal path, `/wt clean`, discard with backup, `/wt done` moves home)

**S27.** `worktree/manage.ts`, C2: `classifySet(env, set)` returns:
- `{ kind: "delivered"|"in-use"|"has-work"|"broken"|"leftover", repos: RepoState[], reason: string }`
- `RepoState = { dir, main, branch, dirty, own, delivered, pr?, error? }`

Precedence: `in-use` (live session or Unity Editor open) > `broken` (a repo folder whose main repo isn't found, or whose worktree isn't registered (`isRegistered`, `manage.ts`) unless it holds only empty folders, or a repo from `.pi-set.json` missing) > `has-work` > `delivered`. `leftover` means no repo folders and only empty folders and set files (`.pi-set.json`). There's no fetch inside; the callers fetch first.

**S28.** `worktree/manage.ts`, C1: replace `removeSet`, `removeAll` and `finishSet` (`:95-213`) with `removeWorkspace(env, set, { discard })`, which works through the set's repos one by one:
1. Unlink links (`cfg.link ∪ DEFAULT_LINK`, `isLink` only).
2. `git worktree remove <wt>`, with `--force` only when `discard`.
3. Delete branch `branchOf(cfg, name)` if it exists, with `-D`: delivered work is proven by S1, and discard has its backup.
4. A repo whose worktree is already gone is skipped.
5. An "in use" failure where the folder holds only empty folders goes to `leftovers`.

After all repos: delete `.pi-set.json`, then rmdir the set if empty. Leftovers start the existing sweep fallback (`SWEEP_SCRIPT`, `index.ts:333-341`). The report format is `Removed set "<name>":` followed by one line per repo, including kept branches and leftovers.

**S29.** `worktree/manage.ts`, C4 discard: `discardPreview(env, state)` and `backupRepo(git, main, set, dir, ts)`.
- **Preview:** for each repo, up to 10 lines of `git log --oneline <base>..HEAD` and the dirty count.
- **Backup:**
  - `git update-ref refs/wt-backup/<set>/<dir>/<ts> HEAD` when `own > 0`
  - when dirty: `git stash create`, and if it prints a SHA, `update-ref …/<ts>-wip <sha>`
- `ts` is local time `yyyymmdd-hhmmss`.
- The report prints how to restore: `git -C <main> switch -c <branch> <ref>` and `git -C <wt-or-main> stash apply <wip-ref>`.

**S30.** `/wt remove [NAME]` (`worktree/index.ts`):
1. Fetch each repo.
2. `classifySet`.
3. By state:
   - `in-use` or `broken` → refuse with the reason
   - `delivered` → one confirm listing the repos and `Library/` notes, as at `manage.ts:92`
   - `has-work` → first confirm `Discard work in "<name>"?` with the preview and `Files git doesn't track are not backed up and will be lost. Backups are kept <backupDays> days.`, then backup, then `removeWorkspace(..., {discard: true})`
4. No UI → refuse.

**S31.** New `/wt clean`:
1. **Discover:** every set, and every known original repo (from `.pi-set.json` or `mainRepoOf` of each set repo, plus the current session's repos: the cwd top and K1 folder tops, deduplicated by common dir).
2. **Fetch** each original repo once with `--prune`, at most 4 at a time.
3. **Classify** every set, at most 4 at a time.
4. **Collect "Will remove":**
   - `delivered` sets, and `leftover` sets
   - stale worktree entries: `prunable` lines in `git worktree list --porcelain`. The action is `git worktree prune` in that repo, which removes only entries whose folder is gone.
   - local `refs/heads/<prefix>*` branches not checked out in any worktree, whose tip is an ancestor of base or is a merged PR's head (S1)
   - `refs/wt-backup/*` refs whose name timestamp is older than `backupDays`. 0 = never.
5. **Collect "Kept":** each other set with its reason, for example `w3: game-template has 2 unpushed commits; /wt remove w3 to discard`.
6. **One confirm** `Clean up worktrees?`. Nothing to remove → report only. No UI → report only, remove nothing.
7. **Execute** the items one by one and continue after a failure.
8. **Remote branches:** `refs/remotes/origin/<prefix>*` whose tip equals a merged PR's head and which no existing worktree is on. These go into a second, separate confirm, `Also delete <n> remote branch(es)?`, and are deleted with `git push origin --delete <branch>`.
9. **Final report:** removed items, kept items, failures.

**S32.** `/wt done`, C5, replacing `doneCmd` (`:325-358`):
1. `waitForIdle`. The session must be in a set.
2. A Unity Editor open in the set → refuse (as at `manage.ts:200-201`).
3. Move the conversation to the original folders, using the S21 path (fork + switch, cancel handling).
4. In `withSession`, run the `/wt remove <name>` logic (S30) with the new context, so the same discard question appears.
5. Refused or cancelled after the move: the conversation stays home and reports `set kept: <reason>`.
6. The "Close this pi session?" question is removed.

**S33.** `worktree/config.ts`: `backupDays` (number ≥ 0, default 30), validated with a warning. `/wt list` shows each set's C2 kind and its reason.

**S34.** `worktree/README.md`:
- document `/wt clean`, the states, discard and backups, `backupDays`, and that session files are kept (C8)
- remove "squash-merged branch counts as unpushed"
- replace "Avoid `git worktree prune`" with "`/wt clean` prunes only entries whose folder is gone"
- describe `/wt done` as move home + remove

### Stage 5: Naming (automatic names, `/wt rename`)

**S35.** `worktree/layout.ts`: `nextFreeName(existing: string[], branchTaken: (name) => boolean)` returns the smallest `w<N>` (N ≥ 1, N ≤ 999) whose set folder doesn't exist and whose branch `<prefix>w<N>` isn't taken. In `index.ts`, `branchTaken` is checked in every repo of the session with `git rev-parse --verify --quiet refs/heads/<branch>`.

**S36.** `/wt new [NAME]` and `+ new workspace` in `/wt use`, when no NAME is given:
- With a UI: `ctx.ui.input("Name for the new workspace (Enter = <suggested>)", <suggested>)`. Empty input → the suggestion; `undefined` → `Cancelled.`; any other text goes through `checkName`.
- Without a UI: the suggestion is used directly.

**S37.** New command `/wt rename [OLD] [NEW]`. Missing arguments: a picker for OLD and an input for NEW (suggestion = `nextFreeName`).
- **Refused when:**
  - NEW fails `checkName`
  - the NEW folder exists
  - OLD doesn't exist
  - OLD is in use or is this session's set
  - any repo's branch `<prefix>OLD` has an upstream, or `git ls-remote --heads origin <prefix>OLD` is not empty (`<dir>: branch is pushed; renaming would break its pull request`)
  - `<prefix>NEW` exists in any repo
- **Steps:**
  1. Create the NEW set folder.
  2. For each repo: run `git worktree move <old wt> <new wt>` from the main repo, then `git branch -m <prefix>OLD <prefix>NEW` when that branch exists.
  3. On any failure, undo the repos already done in reverse order (move back, rename back), report, and remove the empty NEW folder.
  4. Afterwards, move `.pi-set.json` with `branch` updated, and remove the empty OLD folder.

**S38.** `worktree/README.md`: automatic names, `/wt rename`, usage and completions (`rename` gets set names).

### 6. Tests

Worktree tests use fake `Git` and `Gh` functions or temp repos, modelled on `git-ops.test.ts`, `update.test.ts` and `manage.test.ts`. Workflow tests model on `repos.test.ts` and `plan-store.test.ts`.

**Stage 1**
- `worktree/git-ops.test.ts` "deliveredState":
  - ancestor of base → `"base"`
  - not ancestor, gh returns a PR whose head equals HEAD → `"pr"`, pr = N
  - gh head differs → `null`
  - gh fails → `null` with `ghError: "gh unavailable"`
  - dirty → `null`, dirty count set
- `worktree/update.test.ts`:
  - **"reattach":** detached at a commit in base with no branch → `switch -C` called, state `"reattached"`. A branch with extra commits → `"skipped"`. Detached at a commit not in base → no call. Attached → only one `rev-parse` call.
  - **"rebase unpushed":** own 2, behind 3, clean, none on remotes, `rebase: true` → `rebase` called, state `"rebased"`. With `rebase: false` → `"skipped"`, text contains `/wt update to rebase`.
  - **"rebase pushed":** `--not --remotes` count lower than own → `"skipped"`, text contains `force push`, no `rebase` call.
  - **"rebase conflict":** rebase exits 1 → `rebase --abort` called, state `"failed"`.
  - **"delivered by PR":** own > 0 and gh PR head equals HEAD, clean → `switch -C <branch> --no-track <base>`. Dirty → `"skipped"`.
  - **"updateSet parallel":** two repos with delayed fakes → total time below the sum of the delays, and results in input order.
- `worktree/config.test.ts`: `rebaseUnpushed` default true, false accepted, `"no"` gives a warning.
- Real-repo test in `update.test.ts`, "detached after merge": temp origin, clone, worktree on `wt/x`; merge `wt/x` into origin main, detach the worktree at origin/main, delete `wt/x` → `updateRepo` reattaches it to `wt/x`.

**Stage 2**
- `workflow/repos.test.ts` "followFolders":
  - set `D:/p/wt/w1/game` (folders: `D:/p/knowledge/docs`; worktrees of knowledge: `D:/p/knowledge`, `D:/p/wt/w1/knowledge`) → `D:/p/wt/w1/knowledge/docs`
  - the reverse move
  - no candidate → unchanged
  - two candidates → unchanged
  - a plain folder → unchanged
  - a result equal to the working folder → dropped
- `workflow/plan-store.test.ts` "claims": write/read/drop round trip; `claimLive` is false for another host, a dead pid, or `updated` older than 180 s, and true otherwise.
- `workflow/boundary.test.ts` "workflow never refers to worktree": reads every `*.ts` in `workflow/` and asserts:
  - no import specifier containing `../worktree`
  - none of the strings `.pi-set.json`, `agent/live`, `wt-backup`, `worktree.json`, `"wt/`
- `worktree/boundary.test.ts` "worktree uses only the public contract": no import specifier containing `../workflow`, and no string `workflow-state`.
- `worktree/manage.test.ts` or a new `folders.test.ts` "addedFolders reads K1": takes the newest `session-folders` entry, and returns `[]` without one.
- K2 and K4 are wired into `index.ts`, so they have no unit test. Check them with a grep: `session_before_switch` and `workflow:status` each appear exactly once in `workflow/index.ts`.

**Stage 3**
- `worktree/live.test.ts`:
  - `readLive` drops a dead pid and an `updated` older than 120 s
  - `setInUse` matches by cwd and by folder, and ignores its own pid
  - `footerText`: busy execute 2/3 → `w2: working execute 2/3`; idle in plan → `needs you`; phase off → `idle`; 6 entries → 4 shown plus ` +2`; no others → `undefined`
- `worktree/sessions.test.ts`: `newSessionFile` in a temp agent dir writes one line whose JSON has `type:"session"`, `version === CURRENT_SESSION_VERSION`, an id matching the pi regex and the resolved `cwd`. A second call doesn't overwrite. `SessionManager.open(file).getCwd()` equals the cwd.
- `worktree/layout.test.ts`: the launch args contain `--session <file>` and no `--continue`; `-d` / cwd is the original repo; the `;` escaping is unchanged.
- `worktree/shared-guard.test.ts`:
  - with a linked `node_modules`: `npm i`, `pnpm add x`, `yarn` and `yarn install` are refused; `npm run build` passes
  - `rm -rf node_modules`, `Remove-Item -Recurse node_modules` and `rmdir /s node_modules` are refused; `rm -rf dist` passes
  - `write` to `<repo>/node_modules/x` is refused
  - with no links → everything passes
- `worktree/git-ops.test.ts` "withLockRetry": a fake fails twice with `cannot lock ref` and then succeeds → 3 calls, success; a non-lock error → 1 call.
- `worktree/meta.test.ts`: round trip; an invalid file → null.

**Stage 4**
- `worktree/manage.test.ts`:
  - **"classifySet":** each kind, including precedence (in-use beats has-work) and a registered/unregistered leftover with only empty folders.
  - **"removeWorkspace":** a delivered set removes links, then the worktree, then `branch -D`; an already removed repo is skipped; a second run is a no-op; the `.pi-set.json` file is deleted before rmdir.
  - **"discard":** dirty plus own > 0 → `update-ref` called for the commit ref and the `-wip` ref, then `worktree remove --force`, then `branch -D`; the preview lists at most 10 commits.
  - **"clean plan":** two delivered sets, one in use, one has-work, a prunable entry, an orphan merged branch, a backup ref 40 days old (`backupDays` 30) and one 5 days old → the remove list holds the two sets, the prune, the branch and the old ref; the kept list holds the in-use and has-work sets with their reasons. No UI → no removal calls.
  - **"remote branches":** a merged-PR tip match is offered; a tip mismatch or a branch used by a worktree is not.
- `worktree/config.test.ts`: `backupDays` default 30, 0 accepted, -1 gives a warning.

**Stage 5**
- `worktree/layout.test.ts` "nextFreeName": `[]` → `w1`; `["w1","w3"]` → `w2`; `w2` with a taken branch → `w3`.
- `worktree/manage.test.ts` or a new `rename.test.ts`:
  - "rename" success (move and branch rename for each repo, meta updated)
  - the second repo's move fails → the first is moved back and renamed back
  - a pushed branch → refused before any move

**Commands**
- `cd pi/agent/extensions/worktree && node --experimental-strip-types --test *.test.ts && node --test vscode/request.test.js`
- `cd pi/agent/extensions/workflow && node --experimental-strip-types --test *.test.ts`

Expected: every test passes (`# fail 0`) after each stage. Update the README test command lines to list the new files.

### 7. Done when

- After a workflow merge with `--delete-branch`, the next prompt in that workspace reattaches every detached repo to `wt/<name>`, and `/wt update` follows `main` again (D1, D3).
- The automatic update rebases unpushed own commits on a clean tree, aborts cleanly on conflict, and never touches pushed commits. `rebaseUnpushed: false` stops only the automatic rebase (D1, D2, D3).
- A squash or rebase merge on GitHub is recognised as delivered through gh (D9).
- `/wt use` moves the current conversation into a free workspace or back to the original folders, and added folders follow (K1b). Moving is refused while a flow is executing (K2), and refused for a set in use by another live session (D4).
- `/wt new` and `/wt open` start pi from the original repo with `--session`, so no pi process holds a workspace folder (C6).
- The footer shows the other live sessions. `/flow resume` refuses a flow claimed by another live session (D7).
- Package installs and recursive deletes on linked paths in a workspace are refused, and `/wt unlink` removes a link safely (D7).
- `/wt clean`, `/wt remove` with discard and backup, and `/wt done` moving home work as in S27–S33. Remote branches are deleted only after their own confirmation, and backups expire after `backupDays` (D6).
- `/wt new` without a name suggests `w<N>` and Enter accepts it. `/wt rename` renames an unpushed, unused set and rolls back on failure (D5).
- The boundary tests pass: the workflow never refers to the worktree extension, and the worktree extension imports nothing from the workflow (D8).
- All tests pass, the READMEs and `docs/workflow-improvements.md` are updated, and each of the five stages was delivered separately and in order (D10).

### 8. Risks, rollback, and what not to touch

**Risks**
- **Hand-written session header (C6) depends on pi's session format.** Mitigated by using the exported `CURRENT_SESSION_VERSION`, the same header fields as `forkFrom`, and the round-trip test through `SessionManager.open`.
- **The switch inside a command (`/wt use`, `/wt done`).** Any work after the switch must use the `withSession` context, never the old `ctx`.
- **Timers leaking across a session switch:** the old runtime's extension instance must clear them on `session_shutdown`.
- **Automatic rebase rewrites local commits.** It is limited to clean trees and unpushed commits, and aborts on conflict.
- **Other extensions that use `process.cwd()`** (for example context-mode's project folder) see the original repo instead of the workspace when launched through C6. This is acceptable; note it in the README Limits.
- **K1b can map a folder wrongly** if two checkouts of a repo share a parent folder. In that case the rule keeps the folder unchanged.

**Rollback:** each stage is its own commit set; revert the stage's commits. K1 entries already written are ignored by older code.

**What not to touch**
- `workflow/delivery.ts`, `push-guard.ts`, `commit-guard.ts` and `subagent.ts`.
- The `workflow-state` format beyond reading `folders` in K1b.
- The Unity guard rules.
- The VS Code bridge protocol (`vscode/`).
- `git worktree prune` must never run except in `/wt clean`, on entries git marks `prunable`.
- No `--force` push, `reset --hard` or `branch -D` outside the cases named in S3, S28 and S29.

### 9. Commits

Stage 1:
1. `feat(worktree): reattach after merge, recycle delivered branches, rebase unpushed commits in /wt update` — `worktree/git-ops.ts`, `git-ops.test.ts`, `update.ts`, `update.test.ts`, `config.ts`, `config.test.ts`, `index.ts`, `README.md`

Stage 2:

2. `feat(workflow): publish the folder list, follow folders to sibling checkouts, guard switches, emit status, claim flows (D7-D11)` — `workflow/index.ts`, `repos.ts`, `repos.test.ts`, `plan-store.ts`, `plan-store.test.ts`, `boundary.test.ts`, `README.md`, `docs/workflow-improvements.md`
3. `refactor(worktree): read added folders from the workflow's session-folders entry only` — `worktree/index.ts`, `boundary.test.ts`, `folders.test.ts`, `README.md`

Stage 3:

4. `feat(worktree): running-sessions list with footer and in-use checks` — `worktree/live.ts`, `live.test.ts`, `index.ts`, `README.md`
5. `feat(worktree): /wt use moves a conversation between workspaces; launch through --session; set metadata` — `worktree/sessions.ts`, `sessions.test.ts`, `meta.ts`, `meta.test.ts`, `layout.ts`, `layout.test.ts`, `index.ts`, `README.md`
6. `feat(worktree): guard linked shared folders, /wt unlink, retry git lock errors` — `worktree/shared-guard.ts`, `shared-guard.test.ts`, `git-ops.ts`, `git-ops.test.ts`, `index.ts`, `README.md`

Stage 4:

7. `feat(worktree): one removal path, /wt clean, discard with backup refs, /wt done moves home` — `worktree/manage.ts`, `manage.test.ts`, `config.ts`, `config.test.ts`, `index.ts`, `README.md`

Stage 5:

8. `feat(worktree): automatic workspace names and /wt rename` — `worktree/layout.ts`, `layout.test.ts`, `manage.ts` (or `rename.ts` with `rename.test.ts`), `index.ts`, `README.md`

## Plan choices upheld at a pass
pi/agent/extensions/worktree/boundary.test.ts:14 - minor - [plan-flaw] The plan's boundary rule still conflicts with existing code. §6 says worktree has "no import specifier containing `../workflow`", and D8 says worktree uses only K1, K3 and K4. But `unity-guard.ts:2` imports `KEYWORDS`, `parseCommands` and `WRAPPERS` from `../workflow/readonly-bash.ts`. The executor added a narrow exception to the test and documented it in the worktree README. The plan's contract does not list this import.

<!-- pi-workflow:status -->
## Checklist
- [x] S1 `worktree/git-ops.ts`, next to `repoStatus` (`:183`): add `deliveredState(git, gh, wt, baseRef, branch)` implementing th
- [x] S2 `worktree/update.ts`: add `reattach(git, wt, branch)`.
- [x] S3 `worktree/update.ts:23` `updateRepo`: change the signature to take an options object `{ allowDirty, rebase: boolean, bra
- [x] S4 `worktree/update.ts:49` `updateSet`: run the repos in parallel with `Promise.all`. They are different repos with separat
- [x] S5 `worktree/config.ts`: add `rebaseUnpushed` (default `true`) to `WtConfig`, `defaults` and `mergeConfig`, following the `
- [x] S6 `worktree/index.ts`:
- [x] S7 `worktree/README.md`:
- [x] S8 `workflow/index.ts`, K1:
- [x] S9 `workflow/index.ts` `session_start` (`:2741`): before `applyAddDir`, apply K1b as specified in §4.
- [x] S10 `workflow/index.ts`, K2: register `pi.on("session_before_switch", …)` exactly as in §4. Model the notification on `resum
- [x] S11 `workflow/index.ts` `updateStatus` (`:352`), K4: emit `workflow:status` with the payload from §4, deduplicated by its JS
- [x] S12 `workflow/plan-store.ts` and `workflow/index.ts`, S2:
- [x] S13 `worktree/index.ts:23-41`: `addedFolders` reads only the newest `session-folders` entry. Remove `STATE_ENTRY` and every 
- [x] S14 `workflow/README.md`: new section "Public contract for other extensions" listing K1, K1b, K2, K3 and K4 with the exact f
- [x] S15 `docs/workflow-improvements.md`: add the following rows, following the rules at `:7-11`.
- [ ] S16 New `worktree/live.ts`:
- [ ] S17 `worktree/index.ts` factory, wiring S1:
- [ ] S18 New `worktree/sessions.ts`:
- [ ] S19 `worktree/layout.ts:32-74` and `worktree/index.ts:98-129`, C6 launch:
- [ ] S20 `worktree/index.ts` `build` (`:132-153`): after success, write `.pi-set.json` (C7). New `worktree/meta.ts` with `readMet
- [ ] S21 New command `/wt use [NAME]` in `worktree/index.ts` (behaviour fixed by D4):
- [ ] S22 `worktree/index.ts`, in-use checks:
- [ ] S23 New `worktree/shared-guard.ts`, S3: `sharedProblem(toolName, input, { cwd, setRoot, linked: string[] })`, where `linked`
- [ ] S24 New command `/wt unlink PATH`.
- [ ] S25 `worktree/index.ts:27` `makeGit`, S4: retry a call that failed with stderr matching `/cannot lock ref|Unable to create '
- [ ] S26 `worktree/README.md`:
- [ ] S27 `worktree/manage.ts`, C2: `classifySet(env, set)` returns:
- [ ] S28 `worktree/manage.ts`, C1: replace `removeSet`, `removeAll` and `finishSet` (`:95-213`) with `removeWorkspace(env, set, {
- [ ] S29 `worktree/manage.ts`, C4 discard: `discardPreview(env, state)` and `backupRepo(git, main, set, dir, ts)`.
- [ ] S30 `/wt remove [NAME]` (`worktree/index.ts`):
- [ ] S31 New `/wt clean`:
- [ ] S32 `/wt done`, C5, replacing `doneCmd` (`:325-358`):
- [ ] S33 `worktree/config.ts`: `backupDays` (number ≥ 0, default 30), validated with a warning. `/wt list` shows each set's C2 ki
- [ ] S34 `worktree/README.md`:
- [ ] S35 `worktree/layout.ts`: `nextFreeName(existing: string[], branchTaken: (name) => boolean)` returns the smallest `w<N>` (N 
- [ ] S36 `/wt new [NAME]` and `+ new workspace` in `/wt use`, when no NAME is given:
- [ ] S37 New command `/wt rename [OLD] [NEW]`. Missing arguments: a picker for OLD and an input for NEW (suggestion = `nextFreeNa
- [ ] S38 `worktree/README.md`: automatic names, `/wt rename`, usage and completions (`rename` gets set names).
