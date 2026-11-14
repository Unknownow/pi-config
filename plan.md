<!-- pi-workflow plan v1 flow=20261114-1511-relay-an-autonomous-lead-worker-judge-ex-ef67 -->
## Plan: `relay`, an autonomous lead/worker/judge extension

### Goal and non-goals
**Goal.** Build a new pi extension, `relay`, in `pi/agent/extensions/relay/`.
- Your session is the **lead** (Opus). It is always on, it discusses the what and the how with you, and it does small work itself.
- The lead hands real work to headless **workers** (pi RPC sub-sessions in worktree sets).
- A **critic** checks each brief before dispatch. A **judge** checks each result.
- Relay delivers within the Authority the lead approved, then writes a report.
- "go" is the only input relay needs from you. The report is the only output you need to read.

Supporting changes:
- `worktree`: W1 `launch: "none"`, W2 and W3.
- `sandbox`: `read_pdf`.
- `workflow`: the K16 one-owner check.

**Non-goals.**
- No change to how `workflow` behaves, beyond K16 and its docs.
- No change to `orchestrate`. Whether to retire it is decided later.
- Nothing shared with `workflow`, and `shared/` exports stay unchanged.
- No UI menus or prompts after "go".

### User decisions
- **D1.** `relay` is a new extension, written fresh. `workflow` stays installed and standalone for manual control.
- **D2.** Relay is as autonomous as possible: "go" is the only required input, and the report is the only required output. `relay.json` `askUser` is an opt-in list, empty by default.
- **D3.** Roles, not phases:

  | Role | What it is |
  |---|---|
  | lead | Your session (Opus). Always on, and takes input at any time, including while jobs run. |
  | critic | One-shot and read-only. Reads the code. |
  | worker | RPC process on Sonnet, or a per-job model. |
  | judge | One-shot and read-only. |
  | escalate | A stronger model that takes over the worker. |
- **D4.** The lead can read, search, use media, run bash, tests and builds, commit, push, open PRs, and take sensitive actions without asking. It logs them all.
  - Edit budget: 40 lines or 3 files uncommitted.
  - Past the budget, `edit` and `write` are refused and the work becomes a job.
- **D5.** The lead's uncommitted edits move into the job through a temporary-index snapshot.
  - New files are included.
  - Each file is hash-checked before it is reverted.
  - Staged files are unstaged.
- **D6.** The brief has these sections: Goal, Done-when, Non-goals, Constraints, Decisions (locked), Design, Scale (in numbers; the lead assumes numbers when none are given), Targets, Authority (all six categories, each `yes (specific)`, `no` or `n/a`), and Budget. The "go" gate refuses an incomplete brief.
- **D7.** The critic runs up to 3 rounds, and the lead revises the brief after each. The lead may override a locked decision only on a blocker or major finding. Overrides go first in the report.
- **D8.** The worker ⇄ judge loop runs automatically: 3 judge rounds, then 2 escalated rounds, then 1 re-plan, then stop and report.
  - The lead gets one-line notices.
  - It is woken only for worker questions or approvals, the cap, a plan flaw, a stall or crash, and PASS or delivery.
- **D9.** Your input during a job:
  - Unrelated input goes to the lead.
  - Status comes from `relay_status`.
  - An amendment is sent as a `steer`.
  - A change of direction aborts the worker, revises the brief and restarts.
  - You can stop, pause, or take over with `/wt open`.
  - The judge always reviews the current brief version. A verdict on an older version is discarded.
  - An amendment after PASS holds delivery.
  - A queued steer still pending when the worker settles becomes a follow-up prompt.
  - A follow-up to a finished job is an amendment to the same job.
- **D10.** Sensitive categories are approved by the lead, in the brief or with `relay_approve`: merge or push to a protected branch, publish, issue/PR comments, deletions, formats/schemas/migrations/CI/secrets, and dependencies.
  - Guards check commands and sensitive path globs.
  - The judge treats any change that Authority doesn't cover as a blocker.
  - The report starts with an Approvals section.
- **D11.** The critic and judge check:
  - efficiency at the stated scale
  - a path for the named extensions
  - fit with the repo's patterns
  - no duplication
  - neither under- nor over-engineering

  Their inputs are `AGENTS.md` and the knowledge base.
- **D12.** Roles are config: `relay.json` plus a prompt file each. The job lifecycle is a series of step modules. The model is chosen per job, state is per job, and N=3 jobs run at once with a queue behind them. Events are versioned `relay:*`. Judge rechecks look only at the delta.
- **D13.** Workers run as `pi --mode rpc -ne -ns -np -e worker.ts` plus an allow-list.
  - `RELAY_ROLE` is set, and each job has its own session dir.
  - Trust follows the lead (`-a` or `-na`).
  - Worker and lead talk through `outbox.jsonl` and `inbox.jsonl`.
- **D14.** Delivery:
  1. Rebase onto the target.
  2. The result counts as `passedViaRebase` when the rebase is clean, the upstream changes touch none of the job's files, and Verify passes. Otherwise there is a fix round and a delta judge.
  3. A multi-repo job merges only when every repo is accepted, in Targets order.
- **D15.** Reliability:
  - The job lock is the one in D23. Ownership is checked on every heartbeat and before every action that drives the job.
  - Resume and adoption are automatic, with no prompt.
  - A stall is 10 minutes with no events and no tool running.
  - Tool timeouts are separate from the budget.
- **D16.** Budget defaults: 120 min, 4M weighted tokens, 3+2 judge rounds, 1 re-plan.
  - When the budget runs out, a grace period starts, then the job stops.
  - The lead raises the budget for jobs that use long tools.
  - `relay.json` warns about tool patterns longer than the default budget.
- **D17.** Dependent jobs are stacked PRs. They are rebased with `--onto` after their predecessor merges.
- **D18.** Relay uses worktree W1 with a per-request `launch: "none"`, W2 `worktree:remove`, W3 `worktree:add-repo`, and K1 `session-folders`. It checks K16 for one owner with workflow. `/folders` stays in workflow.
- **D19.** `read_pdf` goes in `sandbox`: `pdftotext` for text, `pdftoppm` for images, at most 8 pages per call.
- **D20.** The merge gate, push guard and subagent runner are copied into relay with their tests, then adapted. Everything else is new.
- **D21.** Each delivery step has acceptance criteria, as agreed. They include the untracked-file snapshot test and the concurrent-takeover test.
- **D22.** The numbers (edit budget, N, caps, stall and tool timeouts, grace) are starting values, to be tuned after first use.
- **D23.** *(Proposed. It replaces the agreed tombstone takeover, so it needs your confirmation; see the end.)* The job lock is a generation lock:
  - A takeover creates `owner.<n+1>.lock` with `O_EXCL`.
  - The lead with the highest generation owns the job.
  - `isOwner()` checks `sessionId`, `pid` and `host`.

Merge points: none. The whole flow lands as one PR, merged at the end.

Stages:
1. Prerequisites: worktree W1/W2/W3, sandbox `read_pdf`, workflow K16.
2. Relay core: one job end to end.
3. Running jobs: mid-run input, critic loop, escalation, re-plan, stall, resume and adoption, follow-ups.
4. Parallel and dependent jobs, add-repo, widget and log, docs.

### Facts the executor needs
**Worktree**
- `parseCreate` (W1) is at `worktree/create-event.ts:5-22`.
- `createAndLaunch(pi, ctx, name, progress, only?, bases?)` is at `worktree/index.ts:268-277`.
  - It always calls `launch` (`:139-192`).
  - It returns `launched: !l.error` and `text: l.error ?? l.text`.
- `newSet` is at `:280`. The W1 listener is at `:885-936`; it calls `createAndLaunch` at `:907` and replies at `:909`.
- The branch name comes from `branchOf(cfg, name)` (`index.ts:274`, `manage.ts:239`).
- `worktreeForFolder` is at `add-folder.ts:70`.
- `/wt remove` builds its environment like this: `editors = unityEditors(pi)` (`index.ts:348-349`), then `workspaceEnv(makeGh(pi), ctx, cfg, git, editors)` (`:352`, defined at `:383`).
- `removeWithConfirm` (`manage.ts:381-418`):
  - It refuses when there is no UI.
  - It calls `classifySet` (`:157-217`), which reads `env.inUse`, `env.editors` and `env.gh`. The result is one of `in-use`, `broken`, `has-work`, `delivered` or `leftover`. A branch that is pushed but not merged counts as `has-work`.
  - For `has-work` it calls `backupSet` (`:352`), then `removeWorkspace(…, {discard:true, heads})`.
- `removeWorkspace` (`manage.ts:234-298`) deletes the branch with `branch -D`. On a non-discard run it keeps a branch whose tip is ahead of HEAD (`:273-276`), and it reports that only in its text.
  - `RemoveResult` is at `manage.ts:221-227`.
  - Its callers are `removeWithConfirm` (`:416`) and `clean.ts:174`.
- The worktree tests are listed at `worktree/README.md:182`. There is an existing kept-branch test at `manage.test.ts:331`.

**Workflow**
- `setPhase` is defined at `workflow/index.ts:681` and returns `Promise<void>`. Not counting the definition, it has **18 call sites**.
- These call sites can start from `off`:

  | Line | Where |
  |---|---|
  | `:768` | `startQuick` |
  | `:1955` | `resumeFlow`, defined at `:1810`. It runs `git switch` and `merge --ff-only` at `:1940-1953`, before `setPhase`, and its busy check is at `:1812-1816`. |
  | `:4673` | `session_start` |
  | `:4698` | the K9 handler (`:4686-4712`) |
  | `:4941` | `/flow <phase>` |

  The other call sites run inside a flow: `:546`, `:555`, `:778`, `:846`, `:3383`, `:3601`, `:3808`, `:3974`, `:4175`, `:4257`, `:4706` and `:4950`. The one at `:552` goes to `off`.
- `session_start` resets the phase to `off` at `:4667`. A restored flow returns earlier (`:4640-4661`) and never calls `setPhase`.
- Contract parsers live in `hooks.ts`. The contracts are documented from `workflow/README.md:258`, and the tests are listed at `README.md:257`.
- The existing resume tests are in `workflow/agent-end.test.ts` and `ui-guard.test.ts`.
- `AGENTS.md` requires that `docs/workflow-improvements.md` is updated in the same commit (row, Status line, Effect row). The next free ID is **A53**.

**Sandbox**
- `video_frames` is registered at `sandbox/index.ts:49` and implemented in `video-frames.ts`.
- Tests run with `node --experimental-strip-types --test *.test.ts`.
- `pdftotext` (`/ucrt64/bin`) and `pdftoppm` (MiKTeX) are on PATH.

**Code to copy**
- `workflow/subagent.ts`:
  - `baseArgs` (`:42`) uses `--mode json -p --no-session --no-extensions`.
  - `idleWatch` is at `:91` and `runSubagent` at `:198`.
  - `piInvocation` (`:170-178`, used at `:222`) has no override.
- `workflow/merge-gate.ts`: `gateCheck` (`:67`), `baseFromTree` (`:111`), `recordJudged` (`:131`).
- `workflow/push-guard.ts`: `pushProblem` (`:42`), `shellProblem` (`:167`), `registryPublishProblem` (`:369`).
- `workflow/repo-diff.ts` and `workflow/mcp-forward.ts`.

**Shared modules relay may import.** `shared/` imports from no extension (checked by `boundary.test.ts`). Relay may use:
- `readonly-bash.ts`, `readonly-tools.ts`, `repos.ts`
- `tokens.ts` (`countTokens`, `DEFAULT_TOKEN_WEIGHTS`)
- `roles.ts` (`parseRoleSpec`)
- `findings.ts` (`parseFindings` `:25`, `judgeVerdict` `:99`)
- `claims.ts`: `emitClaims(emit, data, timeoutMs)` (`:20`) collects claims from every listener synchronously, then returns the first non-null answer (`:40-55`).
- `notify.ts`

**Patterns**
- JSONL mailbox with cursors: `orchestrate/store.ts:53`, `:120`, `:138`, `:159-166`.
- Inbox delivery: `orchestrate/index.ts:418-452`.
- `sendToModel`: `orchestrate/index.ts:82-84`.
- Config path: `workflow/config.ts:244`.

**pi docs** (`…/pi-coding-agent/docs`)
- `cli.md`: `-ne`, `-ns`, `-np`, `--session-dir`, `-c`, `-a`/`-na`.
- `rpc.md`:
  - Strict LF-delimited JSONL. Don't use `readline`, because it also splits on U+2028.
  - Match responses to requests by `id`.
  - `agent_settled` marks the end of a turn.
- `rpc-commands.md`: `prompt`, `steer`, `follow_up`, `abort`, `clear_queue`, `get_state`, `set_model`.
- `extensions.md:1197`: `ctx.isProjectTrusted()`.

### Design
**Files** (`pi/agent/extensions/relay/`):
| File | Responsibility |
|---|---|
| `index.ts` | Lead entry, inert when `RELAY_ROLE` is set. At load it registers the K16 listener. It also provides `leadOn(ctx)`, the tools, the commands, the typed "go" hook, the lead prompt, the edit-budget and action-log hooks, and the watcher. |
| `worker.ts` | Worker entry: `ask_lead`, `report_done`, the worker guard. |
| `reviewer.ts` | Critic and judge entry. Refuses non-read tools. |
| `config.ts` | Loads `RELAY_CONFIG`, or else `getAgentDir()/relay.json`. Applies defaults and prints warnings. |
| `pi-bin.ts` | `piCommand(args)`, used by `rpc.ts` and `subagent.ts`. |
| `brief.ts` | Parses, validates, versions and amends briefs. |
| `job.ts` | `job.json` I/O, job ids, job folders. |
| `lock.ts` | The generation lock. |
| `engine.ts` | Runs the steps, the queue and concurrency. |
| `steps/critic.ts`, `dispatch.ts`, `loop.ts`, `deliver.ts`, `report.ts`, `cleanup.ts`, `followup.ts` | The step modules. |
| `rpc.ts` | The RPC client. |
| `subagent.ts`, `mcp-forward.ts`, `repo-diff.ts`, `merge-gate.ts`, `push-guard.ts` | The adapted copies. |
| `snapshot.ts` | Moves the lead's edits into a job. |
| `budget.ts` | Edit budget, job budget, grace, tool timeouts. |
| `authority.ts` | Sensitive categories, guards, approvals. |
| `mailbox.ts` | Outbox and inbox. |
| `events.ts` | `relay:*` events and K16. |
| `prompts/{lead,critic,worker,judge}.md`, `README.md` | Prompts and docs. |
| `*.test.ts`, `test/fake-pi.mjs`, `e2e/live.mjs` | Tests. |

**Job ids and branches.**
- A job id is `r` followed by 6 base36 characters, and it passes `checkName`.
- The set name is the job id; a follow-up that needs a new set uses `<id>-f<N>`.
- Each repo's `branch` comes from the W1 reply. Relay never builds a branch name itself.
- `remoteBranch` is the branch that delivery pushes. It is set to `branch` at the first push.
- `remotePushed` is the sha of the last push relay made to it.

**Brief format** (`brief.md`). `##` headings:
- Required: `Goal`, `Done when`, `Non-goals`, `Constraints`, `Decisions (locked)`, `Design`, `Scale`, `Verify`.
- `Targets`: one line per repo, `<repo dir or key>: <branch>`.
- `Authority`: one line for each of `merge`, `publish`, `comments`, `delete`, `formats` and `deps`. Each value is `yes (<specifics>)`, `no` or `n/a`. A `yes` without specifics is invalid for `merge`, `publish`, `delete` and `formats`.
- Optional:
  - `Budget`: `wall: 120m; tokens: 4M; size: small|normal|large`
  - `Files`: globs
  - `Depends on`: a job id
  - `Publish`: exact commands, allowed only with `publish: yes`

Amendments are added as `## Amendment N (lead|user|approval): …`. The brief's version is 1 plus the number of amendments.

**`job.json`** (v1):
```
{ v:1, id, title, state, briefVersion, set,
  repos:[{key, main, worktree, target, base, branch, remoteBranch?, remotePushed?, leadEdits?, followBase?, judgedTree?, acceptedTree?, passedViaRebase?:{from}, pr?, merged?}],
  dependsOn?, size, round, escalated, replans, followups, budget:{wallMs, tokens}, used:{wallMs, tokens}, grace?:{startedAt, tokensAt},
  worker?:{pid, model, sessionDir}, approvals:[{at, item, category, by:"brief"|"lead", reason}], overrides:[{decision, finding, reason}], notes:[…], lastVerdict? }
```
- `base` is the sha of `origin/<target>` at dispatch.
- States: `draft`, `critic`, `queued`, `working`, `paused`, `judging`, `delivering`, `done`, `stopped`, `failed`.

**Folder layout.**
- Per job, in `<git common dir>/pi/relay/<id>/`:
  - `brief.md`, `job.json`, `owner.<gen>.lock`
  - `outbox.jsonl`, `inbox.jsonl` and their cursors
  - `log.jsonl`, `critic/round-N.md`, `judge/round-N.md`
  - `sessions/` (`sessions/f<N>/` for follow-ups)
  - `report.md`
- Lead actions outside any job go to `<common>/pi/relay/lead-actions.jsonl`.

**Step contract:**
```ts
export interface Step { name: StepName; run(job: Job, ctx: StepCtx): Promise<StepName | "wait" | "end"> }
```
- `StepCtx` provides git and gh, RPC, subagent, config, `notify(line)`, `wake(text)` and `save(job)`.
- The engine persists `state` before each step.
- `"wait"` parks the job until something resumes it: an outbox message, a worker settle, or a lead tool call.
- A new step is one module plus one entry in the engine's list.

**Mailbox messages**
- Worker → lead:
  - `{type:"ask", id, question}`
  - `{type:"approval", id, category, item, why}`
  - `{type:"done", summary}`
  - `{type:"note", text}`
- Lead → worker:
  - `{type:"answer", replyTo, text}`
  - `{type:"approve"|"refuse", replyTo, reason}`

**Events** (`v:1`):
- `relay:job-start {v, job, title, repos}`
- `relay:job-end {v, job, how:"delivered"|"stopped"|"failed", report}`
- `relay:approval {v, job, category, item, by, reason}`

**K16 `flow:active`.**
- Payload: `{v:1, from:"workflow"|"relay", claim}`. Answer: `{owner}`.
- Each extension's listener ignores events whose `from` is itself. With only the two listeners, the one possible answer comes from the other extension.
- Senders use `emitClaims` with a 2 s timeout; the first non-null answer counts. No answer within the timeout counts as no claim.
- **Relay's listener** is registered at load.
  - While relay's activation is undecided, it claims `{owner:"relay"}` when `relay.json` `active` is true and `RELAY_ROLE` is unset.
  - Once decided, it claims only if lead mode is on.
- **Workflow's listener** claims while `state.phase !== "off"`.
- **`leadOn(ctx)`** decides once, on the first of: `input`, `before_agent_start`, or any relay tool or command. By that time every `session_start` has finished, so load order doesn't matter.
  - It emits `{from:"relay"}`.
  - If any answer comes, lead mode stays off for the session, with a notice. Otherwise lead mode turns on.
- **Outcome:**
  - A workflow flow restored from the session wins, because its restore path makes it claim.
  - Otherwise relay wins over workflow's `startPhase` and `--flow`: workflow's start from `off` sees relay's claim and refuses.

**W1 extension.**
- Optional `launch: "none"` in the payload.
- Reply: `{name, branch, cwd, setRoot, launched:false, text:"created, not launched", repos}`.

**W2 `worktree:remove`.**
- Payload: `{v:1, name, force?, claim}`.
- Answer: `{removed, paths, backups, kept, warnings}`, or `{error}`.
- It never shows a dialog.

**W3 `worktree:add-repo`.**
- Payload: `{v:1, name, folder, base?, claim}`.
- Answer: `{path, branch}`, or `{error}`.

**Lock (D23).**
- Lock files are named `owner.<n>.lock`. Each holds `{pid, sessionId, host, heartbeat}`.
- **acquire:** create `owner.1.lock` with `O_EXCL`.
- **takeOver:**
  1. Read the highest generation `n` and confirm it is stale: the heartbeat is older than 2 min, or the pid is dead on the same host.
  2. Write a temp file, then link it to `owner.<n+1>.lock`. The link fails on `EEXIST`, which makes it the `O_EXCL` step.
  3. Run `isOwner()` again. Succeed only if it passes; otherwise delete the file this attempt created and fail.
  4. Delete only the generations lower than its own.
- **`isOwner()`:** this lead's generation is the highest one present, and its file holds this lead's `sessionId`, `pid` and `host`.
  - It runs before every action that drives the job (an RPC command, starting the judge, a delivery step).
  - It also runs on every 30 s heartbeat.
- **Heartbeat:** write `owner.<n>.lock.tmp`, then rename it over `owner.<n>.lock`. It runs only after `isOwner()` passes.
- **An unreadable lock file** is judged stale only by its mtime (older than 2 min).
- **Losing ownership:** the lead stops driving the job.
- **Why two leads can't own the job at once:**
  - The new generation is created atomically.
  - The ownership recheck catches a takeover that was based on a stale read.
  - The pid check separates two processes that share a session.

**Job base and lead edits.**
1. `snapshotEdits` creates a commit whose parent is the lead's HEAD. The branch `relay/<id>/lead-edits` keeps it from being garbage-collected.
2. W1 creates the set from `origin/<target>`.
3. In the worktree, `git cherry-pick <snapshot>` applies only the lead's uncommitted edits, as the first job commit "relay: lead edits". The lead's unpushed commits stay out.
4. If the cherry-pick conflicts: `cherry-pick --abort`, remove the new set with W2 `force`, and fail the dispatch with the paths.
5. The lead's checkout is reverted only after a successful apply.
6. The judge diffs `base..HEAD`, or `followBase..HEAD` for a follow-up.
7. `relay/<id>/lead-edits` is deleted after delivery.

**Pushing the job branch.** One rule, used by S19, S29 and S31:
- **First push:** `git push origin HEAD:<remoteBranch>`. It must create the branch; if the branch already exists remotely, the push fails and the lead is woken.
- **Every later push** (after a delivery rebase, a follow-up, `relay_deliver`, or a stacked `--onto` rebase): `git push --force-with-lease=<remoteBranch>:<remotePushed> origin HEAD:<remoteBranch>`.
- After each successful push, record `remotePushed`.
- **Force-with-lease is allowed only when:**
  - the branch is the job's own `remoteBranch`
  - it isn't the target
  - it isn't a protected branch in `relay.json`

  It isn't a `merge` or `delete` Authority item.
- **A lease failure** means someone else pushed to the branch (for example you, after `/wt open`). Delivery stops and the lead is woken. It never overwrites.
- The relay copy of `push-guard.ts` lets these pushes through only from the delivery step. The worker guard still refuses every push.

**Worker allow-list.** The worker's `-e` list is exactly:
- `worker.ts`
- the paths in `relay.json` `worker.extensions`
- `builtin:mcp` and relay's `mcp-forward.ts`, only when `knowledge` is configured

`-ne` is always present.

**pi binary.** `piCommand(args)`:
- If `RELAY_PI_BIN` is unset, it behaves like the copied `piInvocation`.
- If `RELAY_PI_BIN` ends in `.mjs`, `.js` or `.ts`, it runs `process.execPath <file> …args`.
- Any other value is run as a command.

**Budgets.**
- Wall time and weighted tokens are checked at round boundaries and on every usage event.
- When either runs out mid-round, one grace window opens. It ends after 30 min or after 10% of the token budget (400k), whichever comes first.
- At the end of grace: abort the worker, end the round with no verdict, stop the job and report.
- Tool timeouts are separate from the budget:
  - bash gets 60 min
  - `toolTimeouts: [{pattern, minutes}]` sets others
  - the watcher enforces them by aborting the worker, which counts as a crash
- At dispatch, if Verify or Design matches a tool pattern, the job's wall budget becomes at least timeout×2 + 60 min, recorded in `notes`.
- On load, `relay.json` warns about any pattern longer than the default wall budget.

**Failure handling.**
- Worker crash or stall: one restart with `-c` in the same `--session-dir`, then wake the lead.
- Judge or critic error: retry once, then wake the lead. There is never a default PASS.
- Rebase conflicts and file overlaps become fix rounds.
- Unreadable JSON or JSONL lines are skipped with a warning.

**Scale.** One lead per session; 3 jobs run at once per lead and the rest queue. A job folder holds about 1–5 MB.

This design stops working at these limits:
- File locks are reliable only on one host.
- About 10 workers at once, at roughly 300 MB per process.
- Diffs larger than 400k characters: the judge gets the file list plus whatever diffs fit.

**Rejected alternatives.**
- **The tombstone-rename lock:** it has an ABA race.
- **`git reset --hard` to the snapshot:** it carries the lead's unpushed history into the job.
- **Fast-forward-only pushes:** they fail as soon as a pushed branch is rebased.
- **Merging the target into an already-pushed branch:** it breaks the rebase-based D14 rule.
- **Workers in the lead's checkout, or as terminal windows.**
- **Workers that do outward actions themselves.**
- **Deciding activation at `session_start`:** the result would depend on load order.

---

### Stage 1: Prerequisites in existing extensions

**S1. W1 launch per request.**
- `parseCreate` accepts an optional `launch: "none"` and rejects any other value.
- `createAndLaunch` gets a last parameter, `opts?: { launch?: "none" }`. With `"none"` it skips `progress.stage("opening terminal")` and `launch(...)`, and returns:
  - `launched: false`
  - `text: "created, not launched"`
  - `warn: false`
  - a `report` without the launch line
- The W1 listener (`:907`) passes `{launch: req.launch}`. `newSet` and the other `/wt` callers pass nothing.
- Document it in the README's W1 section.

**S2. W2 `worktree:remove`.** Add a parser in `create-event.ts` and a listener next to W1.
- **Environment:** the listener builds the same one `/wt remove` uses: `editors = unityEditors(pi)`, then `workspaceEnv(makeGh(pi), quietCtx, cfg, git, editors)`. `quietCtx` is the non-UI context the W1 listener already builds.
- **Steps**, with no dialog:
  1. `checkName`, and check that the set exists.
  2. Fetch each repo.
  3. `classifySet`.
  4. Act on the result:
     - `in-use` or `broken`: `{error}`, even with `force`.
     - `has-work` without `force`: `{error, reason}`.
     - `has-work` with `force`: `backupSet`, then `removeWorkspace(…, {discard:true, heads})`. If the backup fails, refuse.
     - `delivered` or `leftover`: `removeWorkspace(…, {discard:false, heads})`.
- When `editors` is `null`, removal goes ahead, and the reply includes `warnings: ["Unity Editor state unknown"]`.
- Add `kept: string[]` to `RemoveResult`. `removeWorkspace` fills it with every branch it keeps (`:273-276`), and its text stays the same. `removeWithConfirm` and `clean.ts:174` don't change.
- Reply: `{removed, paths, backups, kept, warnings}`.
- Document W2 in the README.

**S3. W3 `worktree:add-repo`.**
- Add a parser and a listener.
- The set root is the config root plus `name`, and must contain `.pi-set.json`.
- Call `worktreeForFolder` with `base`. Reply `{path, branch}`.
- Errors: unknown set, a folder that isn't a git repo, a repo already in the set.
- Document W3 in the README.

**S4. `read_pdf`.** New file `sandbox/read-pdf.ts`, registered next to `video_frames` and modelled on `video-frames.ts`.
- Parameters: `{path, pages?: "A-B", images?: boolean, width?}`.
- **Text mode:**
  - Runs `pdftotext -layout -f A -l B` into a temp `.txt`.
  - Returns the page count (from `pdfinfo`, or by counting form feeds), the size, the first 2,000 characters, and the temp path.
  - If there are fewer than 20 non-space characters per page, it says "no text layer (scanned?); use images: true".
- **Image mode:**
  - Runs `pdftoppm -png -r 110 -f A -l B` on at most 8 pages; a larger range is clipped, and the reply says so.
  - Returns the images as attachments plus their paths.
- **Errors:** a missing binary returns its name and an install hint. A missing file or a bad range returns an error.
- Document it in `sandbox/README.md`.

**S5. K16 in workflow.**
- **Listener:** add the parser to `hooks.ts`. The listener ignores `from:"workflow"` and claims `{owner:"workflow"}` while `state.phase !== "off"`.
- **`relayOwns(): Promise<boolean>`:** emits `{v:1, from:"workflow"}` through `emitClaims` with a 2 s timeout, and returns `true` when the answer is `owner:"relay"`.
- **`setPhase`** (`:681`) now returns `Promise<boolean>`.
  - Only when going from `off` to a non-`off` phase, it calls `relayOwns()`. If relay owns the session: notify "workflow: relay is active in this session; /relay off first", return `false`, and change nothing.
  - Every other transition returns `true`.
- **`resumeFlow`** (`:1810`): when `state.phase === "off"`, call `relayOwns()` right after the busy check (`:1812-1816`). That is before `gitRoot`, the plan search and any `git switch` or `merge`. If relay owns the session, notify the same message and return. The `setPhase` at `:1955` also stops on `false`, before `folders`, `approvedPlan` and persist.
- **The other call sites that can start from `off`** stop on `false`:
  - `:768` `startQuick`: return before `quickFrom`, persist and `sendUserMessage`.
  - `:4673` `session_start`: `updateStatus(ctx)` and stay `off`.
  - `:4698` K9: reset `extraPlanTools`, then return `{error: "workflow:start-plan: relay is active in this session"}` before `refilterTools`, `planSpec` and `sendUserMessage`.
  - `:4941` `/flow <phase>`: return before the notice and the kickoff.
- The 13 call sites that run inside a flow stay as they are.
- **Docs:**
  - Document K16 in `workflow/README.md`.
  - `docs/workflow-improvements.md`:
    - **A53** "One-owner check with relay (K16)": implemented. Effect row: "refused starts while the other owner is active".
    - **A54** "relay: autonomous lead/worker/judge extension for hands-off work": **in progress**. Effect row: "user interventions, judge rounds and wall time per job".
    - Update the Status line.

**S6.** Run the Stage 1 tests.

### Stage 2: Relay core (one job end to end)

**S7. Scaffold and config.**
- Create `relay/` with `config.ts`, and add `pi/agent/relay.json`. The config path is `RELAY_CONFIG`, or else `getAgentDir()/relay.json`.
- Keys and defaults:

  | Key | Default |
  |---|---|
  | `active` | `true` |
  | `roles` | `{model, thinking, prompt, tools}` per role. Critic, judge and escalate: Opus 5.5 high. Worker: `{small: Haiku 5.5 medium, normal: Sonnet 5.5 medium, large: Opus 5.5 medium}` |
  | `editBudget` | `{lines: 40, files: 3}` |
  | `maxJobs` | `3` |
  | `caps` | `{critic: 3, judge: 3, escalate: 2, replans: 1}` |
  | `budget` | `{wallMin: 120, tokens: 4_000_000, graceMin: 30, graceTokenShare: 0.1}` |
  | `stallMin` | `10` |
  | `bashTimeoutMin` | `60` |
  | `toolTimeouts` | `[]` |
  | `worker.extensions` | `[]` |
  | `repos` | `{"<owner/name or path glob>": {merge: "after-pass"\|"pr-only", protectedBranches, sensitivePaths}}` |
  | `defaultMerge` | `"pr-only"` |
  | `askUser` | `[]` |
  | `knowledge` | Same shape as in `workflow.json` |
  | `judge.maxDiffChars` | `400_000` |
  | `tokenWeights` | Same as workflow |

- Default `sensitivePaths`:
  - `**/package.json`, `**/package-lock.json`, `**/pnpm-lock.yaml`
  - `**/*.csproj`, `**/Packages/manifest.json`
  - `.github/workflows/**`, `**/.env*`
- Invalid keys fall back to their defaults with a warning. The long-tool warning is printed here too.
- Model specs are parsed with `shared/roles.ts`.

**S8. Copy the guards and runners.**
- Copy `subagent.ts`, `mcp-forward.ts`, `repo-diff.ts`, `merge-gate.ts` and `push-guard.ts` into relay, with their tests.
  - Replace workflow imports with relay's config or `shared/`.
  - Drop `midFlowMergeProblem`, plan stages and the git-task env.
- `subagent.ts`:
  - `baseArgs`: `--mode json -p --no-session -ne -ns -np`, plus `-a` or `-na` according to the lead's `ctx.isProjectTrusted()`.
  - It spawns through `pi-bin.ts` `piCommand`.
- Add `pi-bin.ts`.
- Add `boundary.test.ts`: no imports from `../workflow`, `../orchestrate` or `../worktree`; `../shared` is allowed.

**S9. `brief.ts`.**
- `parseBrief(text)` returns `{sections, authority, targets, budget?, files?, dependsOn?, publish?, version}`, or `{errors}`.
- `validateBrief` (D6) requires:
  - every required section present and non-empty
  - at least one Done-when bullet
  - all six Authority keys, each valid
  - at least one Targets line
- `appendAmendment(text, by, body)` raises the version.

**S10. `job.ts`, `mailbox.ts`, `lock.ts`.**
- `job.json` is written to a temp file, then renamed.
- The mailbox is JSONL with cursors, modelled on `orchestrate/store.ts:120-166`.
- The lock is as described in Design.

**S11. `authority.ts`.**
- **Command → category**, using the copied `push-guard.ts` parsers:

  | Category | Commands |
  |---|---|
  | `merge` | merge or push to a protected branch |
  | `publish` | `registryPublishProblem`, `gh release` |
  | `comments` | `gh issue\|pr comment\|close\|review`, issue writes through `gh api` |
  | `delete` | `git branch -D`, `push --delete`, `rm -rf` outside the set |
  | `deps` | `npm\|pnpm\|yarn add\|install <pkg>`, `dotnet add package` |

- **`pathCategory`:** manifests are `deps`; other `sensitivePaths` are `formats`.
- **`allowed(category, item, job)`:** true when the brief's Authority or an approval covers it.

**S12. `worker.ts`.**
- **Guard** (`tool_call`):
  - Always refused: `git push`, any `gh` write, publish, branch deletion, and `git checkout`/`switch`/`reset` to a ref other than the job's branch or `base`.
  - Refused unless `allowed`: edits to sensitive paths, and dependency installs.
  - Every refusal tells the worker to use `ask_lead`.
- **`ask_lead {question, approval?: {category, item, why}}`:** appends to the outbox, then polls the inbox every 1 s for a matching `replyTo`. It honours abort.
- **`report_done {summary}`:** commits any leftover changes as `relay: wip`, appends `{type:"done"}`, and returns "submitted for review; stop and wait".
- **`prompts/worker.md`** holds the worker's rules.

**S13. `rpc.ts`.**
- `startWorker({cwd, model, thinking, sessionDir, env, resume})` spawns this through `piCommand`:
  ```
  --mode rpc -ne -ns -np -e <relay>/worker.ts [allow-list -e …] --session-dir <dir> [-c] --model … --thinking … -a|-na
  ```
  with env `RELAY_ROLE=worker`, `RELAY_JOB` and `RELAY_JOB_DIR`.
- Framing: strict LF JSONL on bytes, CR stripped, no `readline`.
- Methods: `prompt`, `steer`, `followUp`, `abort`, `clearQueue`, `getState`, `setModel`, each matched to its response by `id`.
- Callbacks: tool start/end, usage, `agent_settled`, exit.

**S14. `snapshot.ts` (D5).**
- **`snapshotEdits(repoDir, jobId)`** returns `{sha, paths}`, or `null` when there is nothing to move:
  1. With `GIT_INDEX_FILE` set to a temp index: `read-tree HEAD`, `add -A`, `write-tree`, then `commit-tree -p HEAD -m "relay: lead edits for <id>"`.
  2. Create the branch `relay/<id>/lead-edits` on that commit.
  3. Get the paths from `git diff --name-status HEAD <sha>`.
- **`revertSnapshotted(repoDir, sha, paths)`** returns `{reverted, skipped}`. S16 calls it only after a successful cherry-pick.
  - A path is reverted only if `git hash-object --path` matches the snapshot blob; a deleted path must still be absent.
  - Modified and deleted paths: `git checkout HEAD --`. New paths: delete the file. Then `git reset -q HEAD -- <reverted>`.
  - Any path that changed after the snapshot is skipped and noted.

**S15. Lead `index.ts`, part 1.**
- **Activation:**
  - The K16 listener is registered at load. It ignores `from:"relay"` and claims as described in Design.
  - `leadOn(ctx)` decides lazily: if any answer comes back, lead mode stays off with a notice; otherwise it turns on.
  - `/relay on` emits K16 again and refuses while workflow claims.
  - `/relay off` is refused while this lead owns running jobs.
- **Prompt:** `before_agent_start` appends `prompts/lead.md`. It covers the role, the autonomy rules, the sensitive-category check while discussing, the brief and "go" flow, job sizing and splitting, and when to answer, approve or override.
- **Typed "go":** an `input` hook, active only in lead mode and only for text that doesn't start with `/`. It uses the approve regex copied into config and rewrites "go" into "go" plus a kickoff: write the brief, run `relay_critic`, revise, then `relay_dispatch`. `/relay go` does the same.
- **Edit budget:**
  - Measuring: on `tool_call` for `edit` or `write`, measure the uncommitted changes across the cwd repo and the K1 folders (read with a small copied reader, as in `orchestrate/folders.ts`). The measure is `git diff --numstat HEAD` plus the line counts of untracked files.
  - Refusal: at 40 lines or more, or when the edit would touch a 4th file, refuse with "edit budget reached: write a brief and relay_dispatch it (your uncommitted edits move into the job)".
  - After bash: after each bash `tool_result`, measure again. If the changes are now over budget, show a one-line notice, and the next `edit` or `write` is refused.
  - Bash itself is never blocked up front; the README states this limit.
  - A commit resets the count.
- **Action log:** bash commands that `authority.ts` classifies go to `lead-actions.jsonl`.

**S16. Lead tools, part 1.**
- **`relay_critic {brief}`:** see S17.
- **`relay_dispatch {brief, size?, overrides?}`:**
  1. Validate the brief.
  2. Assign an id. Write `brief.md` and `job.json`, with Authority approvals marked `by:"brief"` and the `overrides`.
  3. Acquire the lock and apply the long-tool budget rule.
  4. Snapshot the lead's edits in each Target repo.
  5. Send W1 `{v:1, name:id, launch:"none", bases, folders}`, where `folders` are the K1 folders that are in Targets, and `bases` maps each repo to `origin/<target>`.
  6. Record `base` (`rev-parse origin/<target>`) and `branch` for each repo.
  7. Cherry-pick the snapshot; on failure, handle it as described in Design.
  8. Revert the lead's checkout.
  9. Start the worker and emit `relay:job-start`.

  Beyond `maxJobs` running jobs, the job is `queued`.
- **`relay_status {job?}`:** state, round, files, last verdict, budget used, and the last 5 log lines.
- **`relay_approve {job, askId, approve, reason}`:**
  - If the category is in `askUser`, it refuses with "ask the user first".
  - Otherwise it appends `## Amendment N (approval)`, updates `approvals`, answers the worker's inbox and emits `relay:approval`.
- **`relay_stop {job}`:** aborts the worker, sets `stopped` and writes the report.
- **`relay_deliver {job}`:** retries delivery with the current approvals, under the push rule in Design.

**S17. `steps/critic.ts`.**
- Runs through `subagent.ts`:
  - prompt `prompts/critic.md`
  - tools `read,grep,find,ls`, plus `-e reviewer.ts`
  - the knowledge MCP
  - cwd is the main checkout, so `AGENTS.md` loads
- Findings use the `shared/findings.ts` format, plus two kinds:
  - `[locked]`: the finding concerns a locked decision
  - `[authority]`: the brief implies a sensitive item that Authority doesn't cover
- Saves `critic/round-N.md` and returns the findings to the lead.
- In Stage 2 each call is a single round.

**S18. `steps/loop.ts`.**
- Starts by sending the worker `prompt` with the brief and "finish with report_done".
- **On `done`:**
  1. Check `isOwner()`.
  2. Run the judge through `subagent.ts`:
     - prompt `prompts/judge.md`, the same tools, `reviewer.ts`, the MCP
     - cwd is the worktree
     - input: the current brief and its version, plus the diff per repo (`base..HEAD`, or `followBase..HEAD`)
  3. Record `judgedTree` with `write-tree` on a temp index.
  4. Save `judge/round-N.md`.
- **Verdicts:**
  - **PASS** (no blocker or major findings): wake the lead and go to deliver.
  - **FAIL:** `prompt` the worker with the findings and `round++`. The lead gets one notice and is not woken.
  - **A `[plan]` finding:** wake the lead.
  - **At `caps.judge`:** stop and report (Stage 2).
- **`ask` and `approval`:** wake the lead with `sendMessage` and `triggerTurn`, using `followUp` when the lead is busy.
- **Usage events:** count against the budget, with grace.
- **The judge prompt** includes D10 and D11.

**S19. `steps/deliver.ts` (D14).**
- **Per repo, in Targets order:**
  1. `git fetch`, then `git rebase origin/<target>`.
  2. **If the rebase is clean:** intersect the files changed upstream since `base` with the job's files. If they don't overlap, run Verify. If Verify passes, set `acceptedTree` and `passedViaRebase:{from: judgedTree}` (or `acceptedTree = judgedTree` when the tree is unchanged).
  3. **On a conflict:** `rebase --abort`, then a fix round. An overlap or a failed Verify also becomes a fix round, followed by a delta judge.
- **When every repo is accepted:**
  1. Push each repo with the push rule from Design: the first push creates the branch; later pushes use `--force-with-lease` against `remotePushed`.
  2. With GitHub (`gh repo view` works), create the PR if it doesn't exist.
- **Merge** when Authority `merge` is yes, or when the repo's `merge` is `after-pass` and Authority isn't `no`. Merges run in Targets order:
  1. `gateCheck` with `passedTrees = [acceptedTree]`.
  2. With GitHub: `gh pr merge --<method> --match-head-commit <sha>`.
  3. Without GitHub: `git push origin <sha>:<target>`, after a fast-forward check; if the target moved, rebase again.
  4. Set `merged: true`.
- **After all merges:** run the `Publish` commands, only with `publish: yes`, then delete `relay/<id>/lead-edits`.
- **Failures:** a lease failure or a refused action becomes a report item and wakes the lead.

**S20. `steps/report.ts` and `steps/cleanup.ts`.**
- **`report.md`, in this order:**
  1. Approvals
  2. Overrides
  3. Done-when, with evidence
  4. Decision log
  5. Open minor findings
  6. PR and merge state per repo, or the reason the job stopped
- **After writing it:** notify the lead (3 lines plus the path) and emit `relay:job-end`.
- **Cleanup:**
  - Wait for the worker to exit; kill it after 10 s.
  - **Merged:** send W2 without `force`. A refusal or a kept branch is reported, and the set is kept.
  - **PR-only:** keep the set on purpose ("set kept until the PR merges"). W2 is not called.
  - **Stopped or failed:** keep the set.

**S21. Commands, part 1:** `/relay`, `/relay on|off`, `/relay go`, `/relay stop <job>`, `/relay model <role> <provider/id[:thinking]>`.

**S22. `relay/README.md` for the core:** roles, brief, Authority, files, config (including `RELAY_CONFIG`), the push rule, the edit-budget bash limit, the contracts (W1, W2, K1, K16), and the events.

### Stage 3: Running jobs

**S23. `relay_send {job, text, mode: "steer"|"follow_up"|"restart", reset?: "base"|"keep"}` (D9).**
- Every mode first appends `## Amendment N (user|lead)`.
- **`steer`:**
  - If the worker is running: RPC `steer`. If it is idle: `prompt`.
  - At `agent_settled`, if `getState` still shows the steer pending: `clearQueue`, then send it as a `prompt`.
- **`restart`:** abort, optionally reset to `base`, then start a new session with the revised brief and "previous approach dropped: <text>". The critic re-checks only the amendment.
- **A judge result on an older brief version** is discarded, and the judge runs again after the worker's next `done`.
- **An amendment while delivering, before the merge:** the job goes back to `working`, and nothing merges until the new version gets a PASS.

**S24. Critic loop (D7).**
- Rounds are counted per draft title, up to `caps.critic`.
- At the cap, the result says "cap reached; decide and log".
- `relay_dispatch {overrides}` records the overrides. S20 lists them right after Approvals.

**S25. Escalation and re-plan (D8).**
1. After `caps.judge` failed rounds: `setModel` to the escalate role and send the findings, for up to `caps.escalate` rounds.
2. Then wake the lead. `relay_replan {job, brief}` (up to `caps.replans`) starts a new session on the same worktree and resets `round` and `escalated`.
3. After that: stop and report.

**S26. Stall and tool timeouts.**
- The watcher tracks running tools.
- A stall (`stallMin` with no events and no tool running), or a tool past its timeout, triggers `abort`, then one restart with `-c`, then a wake of the lead.

**S27. Resume and adoption.** In `leadOn(ctx)`, after lead mode turns on:
1. Scan `<common>/pi/relay/*/job.json` for unfinished jobs.
2. Own jobs with a current lock: re-attach.
3. Stale jobs: `takeOver`, kill any surviving worker pid, then restart with `-c`. If the job was judging, run the judge again.
4. One notice per job, no prompt.

**S28. Pause and takeover.**
- `/relay pause <job>` aborts the worker, sets the job to `paused` and shows `/wt open <id>`.
- `/relay resume <job>` and `relay_resume` continue the job.

**S29. Follow-up on a finished job: `relay_followup {job, text}`** (`steps/followup.ts`). For a job in `done`, `stopped` or `failed`:
1. Acquire the lock (with `takeOver` if it is stale) and append `## Amendment N`.
2. The critic checks only the amendment.
3. Choose the workspace:
   - **Not merged, set still there** (stopped, failed or PR-only): reuse the set and its branch, and keep `remoteBranch` and `remotePushed`.
   - **Not merged, set gone:** W1 with `launch:"none"`, name `<id>-f<N>` and base `origin/<remoteBranch>`. Keep `remoteBranch` and `remotePushed`, so the push updates the same PR.
   - **Merged** (`merged: true`, whether or not the set still exists): W1 with name `<id>-f<N>` and base `origin/<target>`. Set the new `branch` and clear `remoteBranch` and `remotePushed`, so delivery opens a new PR.
     - The old set, if it still exists, gets W2 without `force`. A refusal is reported.
     - The old remote branch is left alone.
4. Set `followBase` to the worktree HEAD, then start a new session in `sessions/f<N>/`.
5. The judge reviews `followBase..HEAD`.
6. Deliver as in S19 (including its rebase and the push rule), then clean up as in S20.
7. The report gets a `## Follow-up N` section with its own Approvals.

`/relay followup <job> <text>` maps to this tool.

### Stage 4: Parallel and dependent jobs, add-repo, widget and log

**S30. Queue and overlap.**
- Queued jobs start in creation order when a slot frees up.
- At dispatch, if the job's `Files` (or the files named in its Design) overlap a running job's, both jobs get a notice and a log entry.

**S31. Stacked jobs (D17).**
- A job with `Depends on: <id>`:
  - stays queued until its predecessor has passed
  - starts its worktree at the head of the predecessor's branch
  - opens its PR against the predecessor's branch
- After the predecessor merges:
  1. `git rebase --onto origin/<target> <predecessor head> <branch>`
  2. `gh pr edit --base <target>`
  3. Push with the push rule (force-with-lease against `remotePushed`).
  4. Apply the D14 rules.
- If the predecessor stops, its dependents stop too, with the reason.

**S32. `relay_add_repo {job, folder, target}`.** Emits W3. On success it adds the repo, with `base` = `origin/<target>` and the returned `branch`, and answers the worker. The judge diff and delivery include the new repo.

**S33. Widget and log.**
- A status widget shows each job's id, state, round and budget.
- `/relay log <job> [n]` shows the last n lines of `log.jsonl` and the job's paths.
- The log holds summarised events: tool names with short arguments, verdicts, amendments and approvals.

**S34. Docs.**
- Complete `relay/README.md`: lifecycle, mid-run input, follow-ups, the push rule, budgets, locks, W3, the queue, stacking, tests, and limits.
- `docs/workflow-improvements.md`: mark A54 **implemented** (row and Status line), and add "jobs running at once" to its Effect row.

### Tests
All tests run with `node --experimental-strip-types --test`.

**Stage 1**
- **`worktree/create-event.test.ts`:**
  - `launch:"none"` is accepted; `"window"` is rejected.
  - W2 and W3 payloads: valid ones pass, and a wrong `v` is rejected.
- **`worktree/manage.test.ts`:** a branch ahead of HEAD is reported in `kept`, next to the existing test at `:331`.
- **`worktree/contracts.test.ts`** (temp repos):
  - W1 with `launch:"none"` returns `launched:false` and a `cwd`, and `launch` is never called (spy). `/wt new` still calls `launch`.
  - W2 refuses `in-use` even with `force`, using the same `inUse` provider as `/wt remove`.
  - W2 refuses a dirty set without `force`. With `force`, it makes a backup ref, then removes the set.
  - A clean remove deletes the `branchOf` branch.
  - With `editors: null`, W2 removes a delivered set and returns the warning.
  - W3 adds a second repo.
- **`sandbox/read-pdf.test.ts`** (fixtures generated in the test; skipped with a message when the binaries are missing):
  - text mode returns the count, summary and path
  - a PDF without text gives "no text layer"
  - 12 pages in image mode give 8 images and "clipped"
  - a missing binary gives an error
- **`workflow/hooks.test.ts`:** parses K16.
- **`workflow/gate-wiring.test.ts`** (source scan):
  - In `resumeFlow`, `relayOwns(` appears before the first `gitRoot(`, `planChain` or `"switch"`.
  - The `setPhase(` calls in `startQuick`, `resumeFlow`, `session_start`, K9 and `/flow <phase>` check the return value.
  - There are exactly 18 `setPhase(` call sites, not counting the definition.
- **Workflow behaviour** (fake listener answering `{owner:"relay"}`):
  - K9 returns `{error}` and sends nothing.
  - `startQuick` leaves the phase `off`.
  - `/flow resume` on a temp repo with a resumable flow ref leaves each repo's branch and HEAD unchanged, in the style of `agent-end.test.ts` / `ui-guard.test.ts`.
  - Without the listener, all three behave as before.

**Stage 2** (`relay/`)
- **Copied tests:** `merge-gate`, `push-guard`, `subagent`, `repo-diff`, `mcp-forward`. Plus `boundary.test.ts`.
- **`push-guard.test.ts` (added):** force-with-lease is allowed only on the job's `remoteBranch`, only from the delivery step, and never on the target or a protected branch.
- **`pi-bin.test.ts`:**
  - an absolute `.mjs` path runs as `process.execPath <file> …args`
  - a plain command runs as given
  - when unset, it falls back to `piInvocation`
- **`subagent.test.ts`:** with `RELAY_PI_BIN=<abs>/test/fake-pi.mjs`, the judge returns the fake's scripted verdict.
- **`brief.test.ts`:**
  - a valid brief passes
  - a missing Authority key, `merge: yes` without specifics, or an empty Done-when gives errors
  - an amendment raises the version
- **`lock.test.ts`:**
  - after `acquire`, a second `acquire` fails
  - takeover of a fresh lock is refused
  - **two takeovers at once of a stale lock:** a fixed interleaving with injected fs operations. Exactly one wins, and there is never a moment when both pass `isOwner()`.
  - **stale read:** B reads generation 1. A takes over to 2, then 3, deleting the lower files. B creates 2 and fails its `isOwner()` recheck; its file is removed and it reports failure.
  - same `sessionId` but a different pid: only the pid in the file passes
  - a heartbeat interrupted between the temp write and the rename leaves the lock readable
  - an unreadable lock with a fresh mtime is not stale
  - a heartbeat after losing the lock returns lost
- **`snapshot.test.ts`:**
  - modified, deleted, **new untracked** and staged files all end up in the snapshot, and the checkout is clean after the revert
  - a file changed between snapshot and revert is skipped and noted
  - with an **unpushed lead commit** plus edits, the job branch is `base` plus exactly one "relay: lead edits" commit
  - a conflicting cherry-pick fails the dispatch and keeps the lead's edits
- **`authority.test.ts`:** commands and paths map to all six categories; actions are refused until approved, then allowed.
- **`budget.test.ts`:**
  - edit-budget arithmetic: 40 lines; a 4th file
  - grace on wall time or tokens, ending at whichever comes first
  - the long-tool rule
  - the warning on load
- **`k16.test.ts`:**
  - both load orders, with workflow `startPhase:"plan"`, give relay on and workflow `off`
  - a restored workflow flow keeps relay off, in both orders
  - relay's own emit isn't answered by its own listener, so with no workflow listener, lead mode turns on
  - a listener that never answers counts as no claim after 2 s (fake timers)
  - `/relay on` is refused while workflow claims
- **`index.test.ts`:**
  - typed "go" in lead mode is transformed; "/go", or "go" with lead mode off, passes through unchanged
  - an `edit` on a 4th file is refused
  - after a bash `tool_result` brings the total past 40 lines, the next `edit` is refused
  - after a commit, `edit` is allowed again
- **`deliver.test.ts`** (temp repos with bare remotes):
  - a clean rebase with no overlap and passing Verify gives `passedViaRebase`
  - an overlap, a conflict or a failed Verify gives a fix round
  - the gate refuses a tree that wasn't accepted
  - without GitHub, the merge is a push to the target
  - **two repos:** a failed Verify in B means no merge anywhere; when both are accepted, they merge in Targets order
  - **pushes:** the first push creates the branch; a second delivery after `origin/<target>` moved rebases, then pushes with force-with-lease and records `remotePushed`; a remote branch moved by someone else makes the lease fail, and delivery stops and wakes the lead
- **`rpc.test.ts`:** keeps U+2028, handles CRLF, matches responses by `id`.
- **`engine.test.ts`** (`RELAY_PI_BIN=<abs>/test/fake-pi.mjs`; one fake file serves the RPC worker and the json-mode critic and judge, switching on `--mode`):
  - dispatch → FAIL → fix → PASS → delivery to the bare remote → `report.md` → worker exit → W2
  - an edit to `package.json` is refused until `relay_approve`
  - `askUser:["publish"]` makes `relay_approve` refuse publish but accept other categories
  - spawn args contain `-ne`, `worker.ts` and the configured `worker.extensions`; `builtin:mcp` and `mcp-forward.ts` appear only with `knowledge`; there is no other `-e`
  - a FAIL round gives one notice and no `triggerTurn`; `ask`, `approval`, cap, `[plan]`, crash and PASS each trigger a turn
  - `relay_stop` aborts, sets `stopped`, and writes `report.md`
  - a PR-only delivery keeps its set and never calls W2

**Stage 3** (`engine.test.ts`, with fakes and a fake clock)
- **Mid-run input:**
  - a steer reaches a running worker
  - a verdict on an old brief version is discarded, and the judge runs again
  - a steer still queued at settle is re-sent as a prompt
  - a restart aborts the worker and restarts it with the amendment
  - an amendment after PASS but before merge holds delivery until a new PASS
- **Critic cap:** the 4th call returns "cap reached", and overrides appear right after Approvals.
- **Escalation:** cap → `setModel` → re-plan → stop.
- **Stalls:** a stall (10 min with no events and no tool) gives an abort and a `-c` restart; a second stall wakes the lead. A 15-min tool call is not a stall, and a tool timeout aborts.
- **Adoption:** kill the lead mid-job (drop the engine and expire the heartbeat). A new engine adopts the job and reaches PASS.
- **Pause and resume:** a paused job holds; resume reaches PASS.
- **Follow-ups**, each with `origin/<target>` moved between the first delivery and the follow-up:
  - **PR-only, set present:** the set is reused; delivery rebases, pushes with force-with-lease, and the same PR is updated.
  - **PR-only, set gone:** `<id>-f1` is created from `origin/<remoteBranch>`; it rebases, pushes with the lease to the same `remoteBranch`, and updates the same PR.
  - **Stopped job:** the set is reused.
  - **Merged, set present after W2 refused:** `<id>-f1` is created from `origin/<target>`, a new PR is opened, the old remote branch is untouched, and W2 is tried again on the old set.
  - **Merged, set gone:** same as the previous case, without the W2 retry.
  - In every case, the judge diff is only `followBase..HEAD`.

**Stage 4** (`engine.test.ts`)
- 3 jobs run and a 4th queues, then starts when a slot frees.
- An overlap warning is logged.
- **Stacked job:**
  - it is delivered with `--onto` after its predecessor, including a squash-merged predecessor
  - `origin/<target>` moves after the dependent's first push: the dependent rebases and pushes with force-with-lease, and the PR is retargeted
  - when the predecessor is stopped, the dependent stops with the reason
- W3 adds a repo mid-job, and the repo is covered by the diff and the delivery.
- The widget shows the lines for 2 jobs, and `/relay log <job> 3` prints 3 lines plus the paths.

**Commands**
- **Fast:**
  - `cd pi/agent/extensions/relay && node --experimental-strip-types --test *.test.ts`
  - plus the touched suites: `worktree/README.md:182`, `sandbox/README.md:19`, `workflow/README.md:257`, `shared/README.md`

  Expected: all pass, 0 failures.
- **Slow** (about 15–25 min with real models; run once at the end of Stage 2 and once at the end of Stage 4): `node pi/agent/extensions/relay/e2e/live.mjs`
  - Setup:
    1. Create a scratch repo with a local bare remote.
    2. Write a temp `relay.json` with `repos: {"<scratch path>": {merge: "after-pass"}}`, and set `RELAY_CONFIG` to it.
    3. Start `pi --mode rpc -ne -e relay/index.ts -e worktree/index.ts -e sandbox/index.ts`.
    4. Send a short discussion stating "merge: yes (fast-forward to main after PASS)", then "go".
  - It waits up to 30 min for `relay:job-end`.
  - It asserts:
    - `report.md` has Approvals and Done-when
    - the target branch on the bare remote has the change
    - the set has been removed
  - Expected: exit 0, printing the job id and `delivered`.

### Done when
- All four stages are implemented. Every suite passes, and the live e2e passes after Stage 2 and after Stage 4.
- With relay active, "go" after a discussion runs through to `report.md` with no prompt to you: brief, critic, a worker in a W1 `launch:"none"` set, the judge loop, and delivery within Authority.
- Workers load only `worker.ts` plus the allow-list. They never push, merge or publish, and they touch sensitive paths only with the lead's approval.
- Lead edits past the budget are refused. Dispatch moves only the uncommitted edits (including new files) into the job.
- Mid-run input (amend, restart, stop, pause) and follow-ups on finished jobs work as in D9, including after the target branch has moved.
- Jobs survive a lead restart through adoption, and two leads never drive the same job.
- Workflow and relay each refuse to start while the other owns the session, whatever the load order.
- `read_pdf` works in all its modes.
- The docs are updated: the relay, worktree, sandbox and workflow READMEs, and A53/A54.

### Risks, rollback, and what not to touch
- **Risks:**
  - The RPC protocol may differ from the 1.5.2 docs; the fake-pi tests and the live e2e check it.
  - Windows file locks can block reverts; the affected paths are skipped and noted.
  - The live e2e costs model tokens.
  - W2 never removes unpushed work without a backup.
  - Force-with-lease only rewrites the job's own branch, and only against the sha relay itself pushed.
- **Rollback:**
  - `relay.json` `active: false` makes relay inert.
  - Deleting `relay/` removes it.
  - The worktree contracts are additions only.
  - K16 is a no-op without relay.
- **Do not touch:**
  - `orchestrate/`
  - workflow behaviour beyond S5
  - `shared/` exports
  - existing W1 and `/wt` behaviour

### Commits
1. `worktree: per-request launch none, W2 remove and W3 add-repo contracts`: `worktree/create-event.ts`, `index.ts`, `manage.ts` (`RemoveResult.kept`), `README.md`, tests.
2. `sandbox: read_pdf tool`: `sandbox/read-pdf.ts`, `index.ts`, `README.md`, test.
3. `workflow: K16 one-owner check with relay`: `workflow/index.ts`, `hooks.ts`, `README.md`, tests, and `docs/workflow-improvements.md` (A53 implemented, A54 in progress, Status line, Effect rows).
4. `relay: config, copied guards and runners`: `relay/config.ts`, `pi-bin.ts`, the copied modules, their tests, `boundary.test.ts`, `pi/agent/relay.json`.
5. `relay: brief, job store, lock, mailbox, authority, snapshot, budget`: the modules and their tests.
6. `relay: worker entry, RPC client, critic, judge loop, delivery, report and lead tools`: `worker.ts`, `reviewer.ts`, `rpc.ts`, `steps/*`, `engine.ts`, `index.ts`, `prompts/*`, `test/fake-pi.mjs`, the Stage 2 tests, `e2e/live.mjs`, `README.md`.
7. `relay: mid-run input, critic loop, escalation, re-plan, stall, adoption and follow-ups`: the Stage 3 files and tests.
8. `relay: queue, stacked jobs, add-repo, widget and log`: the Stage 4 files and tests, `README.md`, and `docs/workflow-improvements.md` (A54 implemented, Status line, Effect row).

---

**D23 needs your answer.** The plan uses a **generation lock**: each takeover creates `owner.<n+1>.lock` with `O_EXCL` and then checks again that it owns the job, and `isOwner()` checks the session, pid and host. This replaces the tombstone takeover agreed in discussion. With the tombstone, two leads can drive the same job for up to 30 seconds (an ABA race). Do you want the generation lock? Approving the plan confirms it.

## Plan changes

Each item below **replaces** the text it names in the last full `## Plan:`. Text that isn't named stays as it is.

### Changed decisions
- **D20 (replaced).** These are copied into relay with their tests, then adapted:
  - from workflow: `merge-gate.ts`, `push-guard.ts`, `subagent.ts`, `repo-diff.ts`, `mcp-forward.ts`
  - the K1 folder reader from `orchestrate/folders.ts`

  Everything else is new, and nothing is imported from those extensions.
- **D23:** unchanged. It still needs your confirmation at the end.

### Facts (added)
**`worktreeForFolder`** (`worktree/add-folder.ts:70-109`):
- It takes `(git, {cfg, setRoot, folder}, progress)` and returns `{folder, lines} | {error} | null`. It has no `base` and returns no branch.
- It returns `null` when the folder is not a git folder, or is already inside the set (`:80-82`).
- It **reuses** an existing worktree of that repo in the set and reports success (`:86-93`).
- It calls `preflight(git, [main], cfg, name)` at `:97`.
- Its only callers are `index.ts:872` (K6 `/folders`) and `add-folder.test.ts:45`.

**`preflight`** (`git-ops.ts:87`) already takes `bases?: Record<string,string>`. Keys are repo top-level paths, matched case-insensitively (`git-ops.ts:61`).

**`removeWorkspace`** keeps a branch in two cases (`manage.ts:273-280`):
- the branch is ahead of HEAD
- `branch -D` fails

**`workspaceEnv`** and **`addedFolders`**:
- `workspaceEnv(gh, ctx: ExtensionCommandContext, …)` is at `worktree/index.ts:383`. It marks a set "in use by this session" from `ctx.cwd` plus `addedFolders(ctx)`.
- `addedFolders(ctx: SetCtx)` is at `index.ts:80`.
- `SetCtx` is `Pick<ExtensionContext, "cwd"|"ui"|"hasUI"|"sessionManager">` (`:77`).
- The W1 listener's `quiet` ctx is at `:895-905`.

**`emitClaims`** answers with `{error}` on a timeout or a rejection (`shared/claims.ts:49-50`). It answers with the first non-null value otherwise, and `null` when nobody claims.

**Sessions opened with `/wt open`** load the user's extensions (`worktree/index.ts:139`, `:993`), relay included.

### Design (replaced parts)
- **K16, how answers are read (replaces the sentence "No answer within the timeout counts as no claim").**
  - The sender reads only `answer?.owner`.
  - `null`, `{error}` (timeout or rejection) and any value without `owner` all count as **no claim**.
- **Sessions inside a job set (new rule).**
  - At load, relay walks up from `process.cwd()` to the nearest `.pi-set.json`.
  - If the folder holding that file is named like a job set (`^r[0-9a-z]{6}(-f\d+)?$`), the session is a **job-set session**. That covers worker processes, `/wt open` takeovers and anything else opened inside a job's set.
  - In a job-set session the K16 listener never claims, and `leadOn` turns lead mode off with the notice "relay: this is a job's worktree; lead mode off". There is then:
    - no edit budget
    - no "go" hook
    - no dispatch
    - no adoption scan
  - `RELAY_ROLE` still makes `index.ts` inert in workers, as before.
- **Job root (replaces "Folder layout", first line).**
  - Job folders live in `<git common dir of the lead's cwd repo>/pi/relay/<id>/`. That holds for single- and multi-repo jobs; other Target repos are referenced from `job.json` by path.
  - `relay_dispatch` refuses when the lead's cwd is not inside a git repo.
  - S27 scans exactly this root.
  - `lead-actions.jsonl` lives in the same root. When the cwd is not a git repo, lead actions go to `getAgentDir()/relay/lead-actions.jsonl`.
- **Lock, heartbeat (replaces the Heartbeat bullet).**
  - The heartbeat runs only after `isOwner()` passes. It writes `owner.<n>.lock.tmp`, then renames it over `owner.<n>.lock`.
  - On `EPERM`, `EBUSY` or `EACCES`, the rename is retried up to 5 times, with backoff of 50, 100, 200, 400 and 800 ms.
  - If all retries fail, the heartbeat counts as **not written**: logged, temp file removed, ownership kept. The lead loses the lock only when a later `isOwner()` fails.
  - A takeover needs a heartbeat older than 2 min, so several missed heartbeats are tolerated.
  - `takeOver` writes its new generation with the same retry for its link/rename step.
- **Critic drafts.**
  - The first `relay_critic` call creates a **draft id** (`d` + 6 base36 characters), stored under `<root>/pi/relay/drafts/<draft>/`.
  - Later rounds pass `draft`, and `relay_dispatch {draft}` links those rounds to the job.
  - The round cap counts per draft id, so retitling a brief does not reset it.

### Steps (replaced in full)

**S2. W2 `worktree:remove`.** Same as before, with three changes:
- **Context type.** Widen the `ctx` parameter of `workspaceEnv` (`index.ts:383`) to `Pick<ExtensionContext, "cwd"|"sessionManager">`. `addedFolders` (`:80`) is widened to the same type. Its existing callers (`/wt remove` at `:352`, and the other command callers) still pass a full context, so their behaviour is unchanged. The W2 listener passes its `quiet` ctx, built like the one at `:895-905`.
- **`kept` field.** Add `kept: string[]` to `RemoveResult`. `removeWorkspace` fills it in **both** cases where it keeps a branch, ahead of HEAD or a failed `branch -D` (`manage.ts:273-280`); its text is unchanged.
- **Unchanged callers.** `removeWithConfirm` and `clean.ts:174` stay as they are.

The rest of S2 stays: env from `unityEditors` plus `workspaceEnv`, the `classifySet` decisions, a backup on `force`, the `warnings` when `editors` is null, and the reply shape.

**S3. W3 `worktree:add-repo`.**
1. **Extend `worktreeForFolder`** (`add-folder.ts:70`) with an optional `base?: string` in its options object. When it is set, the function passes `{[main]: base}` as `bases` to `preflight` (`:97`). The K6 caller (`index.ts:872`) and `add-folder.test.ts` pass nothing, so their behaviour is unchanged.
2. **Listener.** Add a parser and listener for `{v:1, name, folder, base?, claim}`:
   1. Check the name with `checkName`. The set root is `setRootOf(cfg, name)` and must contain `.pi-set.json`; otherwise answer `{error: "unknown set"}`.
   2. Resolve the folder's repo: `git rev-parse --show-toplevel`, then `mainRepoOf`. If either fails, answer `{error: "not a git repo"}`.
   3. **Before calling `worktreeForFolder`,** detect a repo that is already in the set: `.pi-set.json` `repos` holds that main repo, or `git worktree list` shows a worktree of it inside the set. Answer `{error: "repo already in the set"}`, because the function would otherwise reuse the worktree.
   4. Call `worktreeForFolder(git, {cfg, setRoot, folder, base}, progress)`.
      - `null` → `{error: "not a git repo or inside the set"}`.
      - `{error}` → passed through.
      - success → `{path: result.folder, branch: branchOf(cfg, name)}`.
3. Document W3 in `worktree/README.md`.

**S5. K16 in workflow.** Same as before, plus:
- `relayOwns()` reads only `answer?.owner === "relay"`. `null`, `{error}` (timeout) and anything else count as no claim.

**S15. Lead `index.ts`, part 1 (activation bullet replaced).**
- **At load:**
  - Run the job-set detection from Design.
  - Register the K16 listener. It ignores `from:"relay"`, never claims in a job-set session, and otherwise claims as in Design.
- **`leadOn(ctx)`** decides lazily and stops there in a job-set session (lead mode off, with the notice). Otherwise it emits `{v:1, from:"relay"}` and reads only `answer?.owner`:
  - `"workflow"` → lead mode off, with a notice
  - anything else → lead mode on

The rest of S15 stays: prompt, typed "go", edit budget including the bash re-measure, action log, `/relay on|off`.

**S16. Lead tools, part 1 (two changes).**
- `relay_dispatch {brief, size?, overrides?, draft?}`. It refuses when the cwd is not in a git repo, and writes the job under the job root from Design.
- `relay_critic {brief, draft?}` returns `{draft, findings}` (see S24).

**S24. Critic loop (D7).**
- `relay_critic` counts rounds per **draft id**:
  - a call without `draft` creates a new draft
  - a call with `draft` continues that draft and increments its round
- At `caps.critic` the call returns "cap reached; decide and log", without running the critic.
- `relay_dispatch {draft, overrides}` copies the draft's `critic/round-N.md` files into the job and records the overrides. S20 lists them right after Approvals.

**S27. Resume, adoption and PR-only cleanup.** Runs only in lead mode, never in a job-set session. Inside `leadOn(ctx)`, after lead mode is on, and then every 10 min:
1. Scan `<job root>/pi/relay/*/job.json` for unfinished jobs.
   - Own job with a current lock: re-attach.
   - Stale job: `takeOver`, kill a surviving worker pid, then restart with `-c`. A job that was judging re-runs the judge.
   - One notice per job, with no prompt.
2. **PR-only cleanup.** For each `done` job that has a repo with a `pr` and `merged` not set, and whose set was kept:
   1. Run `gh pr view <pr> --json state,mergeCommit` in that repo.
   2. If the PR is `MERGED`: set `merged: true`, then send W2 `{v:1, name:<set>}` without `force`. Log the result, and report a refusal in one notice.
   3. A `gh` error is logged and retried on the next tick.

### Tests (added; each listed per stage)
**Stage 1**
- **`worktree/add-folder.test.ts`**
  - With `base`, the new worktree starts at that ref.
  - Without `base`, behaviour is unchanged (the existing tests).
- **`worktree/contracts.test.ts`, W3 cases:**
  - Adding a second repo returns `{path, branch}`, and `branch` equals `branchOf(cfg, name)`.
  - With `base`, HEAD of the new worktree equals that ref.
  - A repo already in the set gives "repo already in the set", and no worktree is created or reused.
  - A non-git folder gives "not a git repo".
  - An unknown set gives "unknown set".
- **`worktree/contracts.test.ts`, W2 case:** the listener uses its `quiet` ctx. A set that holds the lead's cwd is refused with "in use by this session".
- **`worktree/manage.test.ts`:** `kept` lists the branch in both cases, ahead of HEAD (next to `:331`) and a failing `branch -D` (spy git).
- **Workflow behaviour:**
  - A `flow:active` listener that never answers makes `relayOwns()` return `false` after 2 s (fake timers), and `startQuick` proceeds.
  - A listener answering `{error:"x"}` also counts as no claim.

**Stage 2**
- **`k16.test.ts`:**
  - A process whose cwd is inside a `.pi-set.json` folder named `r1a2b3c` (and `r1a2b3c-f1`) makes no claim when workflow emits, and `leadOn` keeps lead mode off with the notice.
  - A `{error}` answer counts as no claim.
- **`index.test.ts`:** in a job-set session:
  - `edit` is never refused for the budget
  - typed "go" passes through unchanged
  - `relay_dispatch` is refused
  - no adoption scan runs (spy)
- **`lock.test.ts`:**
  - The heartbeat rename fails with `EPERM` twice, then succeeds: written.
  - It fails 5 times: "not written", the lock is still owned, and the temp file is removed.
  - A takeover rename with `EBUSY` once still succeeds.
- **`engine.test.ts` / `index.test.ts`:**
  - `relay_dispatch` with the cwd outside any git repo is refused.
  - A two-repo job's folder is created under the cwd repo's common dir.
- **`critic.test.ts`:**
  - A first call returns a new draft id.
  - Three calls on that draft run, and a 4th returns "cap reached" without running the critic, even with a changed title.
  - A call without `draft` starts a new count.

**Stage 3** (`engine.test.ts`)
- **PR-only cleanup:** a `done` PR-only job with a kept set. The fake `gh` reports `OPEN`, then `MERGED`. The first tick changes nothing. The second sets `merged: true` and sends W2 without `force`.
- **Adoption scan:** it reads only the job root, and a job-set session never runs it.

### Commits (changed)
- **1.** Also covers `worktree/add-folder.ts` and `add-folder.test.ts` (the `base` option), plus `workspaceEnv` and `addedFolders` widening in `index.ts`.
- **6.** Also covers `relay/critic.test.ts`.

### Open question
- **D23:** use the **generation lock** for jobs: each takeover creates `owner.<n+1>.lock` with `O_EXCL`, then checks again with `isOwner()` (session, pid, host); heartbeat writes retry on Windows.
  - It replaces the tombstone takeover agreed in discussion, because that one lets two leads drive a job for up to 30 s.
  - If you'd rather keep the tombstone takeover, say so, and S10 and the `lock.test.ts` cases switch back to it.

<!-- pi-workflow:status -->
## Checklist
- [x] S1 W1 launch per request.
- [x] S2 W2 `worktree:remove`. Add a parser in `create-event.ts` and a listener next to W1.
- [x] S3 W3 `worktree:add-repo`.
- [x] S4 `read_pdf`. New file `sandbox/read-pdf.ts`, registered next to `video_frames` and modelled on `video-frames.ts`.
- [x] S5 K16 in workflow.
- [x] S6 Run the Stage 1 tests.
- [x] S7 Scaffold and config.
- [x] S8 Copy the guards and runners.
- [x] S9 `brief.ts`.
- [x] S10 `job.ts`, `mailbox.ts`, `lock.ts`.
- [x] S11 `authority.ts`.
- [x] S12 `worker.ts`.
- [x] S13 `rpc.ts`.
- [x] S14 `snapshot.ts` (D5).
- [x] S15 Lead `index.ts`, part 1.
- [x] S16 Lead tools, part 1.
- [x] S17 `steps/critic.ts`.
- [x] S18 `steps/loop.ts`.
- [x] S19 `steps/deliver.ts` (D14).
- [x] S20 `steps/report.ts` and `steps/cleanup.ts`.
- [x] S21 Commands, part 1: `/relay`, `/relay on|off`, `/relay go`, `/relay stop <job>`, `/relay model <role> <provider/id[:thinki
- [x] S22 `relay/README.md` for the core: roles, brief, Authority, files, config (including `RELAY_CONFIG`), the push rule, the ed
- [ ] S23 `relay_send {job, text, mode: "steer"|"follow_up"|"restart", reset?: "base"|"keep"}` (D9).
- [ ] S24 Critic loop (D7).
- [ ] S25 Escalation and re-plan (D8).
- [ ] S26 Stall and tool timeouts.
- [ ] S27 Resume and adoption. In `leadOn(ctx)`, after lead mode turns on:
- [ ] S28 Pause and takeover.
- [ ] S29 Follow-up on a finished job: `relay_followup {job, text}` (`steps/followup.ts`). For a job in `done`, `stopped` or `fail
- [ ] S30 Queue and overlap.
- [ ] S31 Stacked jobs (D17).
- [ ] S32 `relay_add_repo {job, folder, target}`. Emits W3. On success it adds the repo, with `base` = `origin/<target>` and the r
- [ ] S33 Widget and log.
- [ ] S34 Docs.
