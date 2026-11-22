# relay

An autonomous lead / worker / judge extension for hands-off work. Your session is the **lead**: it discusses the what and the how with you, does small work itself, and hands real work to headless **workers**. A **critic** checks each brief before dispatch; a **judge** checks each result. Relay delivers within the Authority you agreed, then writes a report. "go" is the only input relay needs from you; the report is the only output you need to read.

**Relay is off by default** (`relay.json` `active: false`): `/relay on` turns lead mode on for the session (`active: true` makes it start on).

`workflow` stays installed and standalone for manual control. Relay uses the **agents** library: the judge and critic are agents roles (`runJudge`, `runCritic`; models, diff limit and reviewer knowledge in `agents.json`, set with `/agents model`), and workers load the agents extension for `explore`, `advisor` and `test_run`. Relay imports agents only through `agents/api.ts`, and the git rules (merge gate, push guard, repo diff) and the session folders from `../shared`; nothing from `workflow`, `worktree` or `sandbox` (`boundary.test.ts`). It talks to `worktree` through events.

## Roles

| Role | What it is |
|---|---|
| lead | Your session (Opus). Always on in lead mode, takes input at any time. Reads, searches, runs bash, tests and builds, commits, pushes, opens PRs, and takes sensitive actions without asking (all logged). Edits up to the **edit budget** itself. |
| critic | Agents `runCritic` (read-only, agents' `reviewer.ts`), document = the brief (or an amendment), about "relay brief", relay's brief rules as `criteria` (`reviews.ts`): completeness, efficiency at the stated scale, a path for the named extensions, fit with the repo's patterns, no duplication, Authority covered (`[authority]`), locked decisions (`[locked]`). It never asks for test runs unless the brief says the user asked, and never demands new tests. Up to 3 rounds per draft. |
| worker | A `pi --mode rpc -ne -ns -np -e worker.ts -e <agents index.ts>` process (Sonnet by default, per-job size) in a worktree set, with the agents tools `explore`, `advisor` (3 calls per job) and `test_run` (no `judge` or `critic`). Never pushes, merges or publishes. |
| judge | Agents `runJudge` in **full** mode every round: spec = the **current brief version**, `criteria` = relay's rules plus the brief's Done when, Non-goals, Decisions and Authority (`reviews.ts`: Authority gaps are blockers, `[plan]` for a brief flaw), `previousFindings` = the last round's, the diff as per-repo parts (fitted to agents.json `judge.maxDiffChars`). |
| escalate | A stronger model that takes over the worker after the judge rounds. |

## The flow

1. You discuss with the lead. When you say "go" (typed, or `/relay go`), the lead writes the brief, runs `relay_critic` (revising up to 3 rounds), and `relay_dispatch`es it.
2. Dispatch: validate, assign a job id (`r` + 6 base36 characters), write `brief.md` and `job.json`, take the job lock, snapshot your uncommitted edits, create the set (W1 with `launch: "none"`), cherry-pick the snapshot as the job's first commit ("relay: lead edits"), revert your checkout, start the worker.
3. The worker works, asks (`ask_lead`) when it must, and finishes with `report_done`. The judge reviews `base..HEAD`. FAIL: the worker gets the findings (one notice, the lead is not woken). PASS: the lead is woken and delivery starts. After `caps.judge` (3) failed rounds the worker is switched to the escalate model for `caps.escalate` (2) more; then the lead is woken to re-plan (`relay_replan`, up to `caps.replans`, 1); then the job stops and is reported.
4. Delivery rebases onto `origin/<target>` per repo, pushes, opens the PR (with GitHub), and merges within Authority.
5. `report.md` is written; the lead gets 3 lines and the path; the worker exits; the set is removed if everything merged.

The lead is woken (a turn starts) only for: a worker question or approval request, the judge cap or a re-plan wait, a `[plan]` finding, a worker crash or stall that restarting did not fix, PASS, and the final report.

## Running jobs

**Mid-run input (D9).** `relay_send {job, text, mode, reset?, from?}` always appends `## Amendment N (user|lead)` to the brief (the version goes up by one), then:
- `steer`: a running worker gets an RPC `steer`; an idle one gets a `prompt`. If the steer is still queued when the worker settles (`get_state` shows a pending message), relay does `clear_queue` and sends it as a prompt.
- `follow_up`: queued behind the worker's current turn.
- `restart`: the critic first checks only the amendment (a blocker or major finding refuses the restart and changes nothing); then the worker is aborted and stopped, with `reset: "base"` the branch is reset to its base (the lead's edits are applied again) and a new session starts with the revised brief and "previous approach dropped: <text>".
- A judge verdict is for the brief version it judged. An amendment since (other than an `approval`, which only widens Authority) discards it: the worker gets the amendment, and the judge runs again after its next `report_done`. No judge round is used.
- An amendment while delivering, before a merge, sends the job back to `working`; nothing merges until the new version gets a PASS.
- A job that is judging, delivering, paused or queued just holds the amendment; it is read when the step or worker continues.

**Critic loop (D7).** `relay_critic` counts rounds per draft id (the first call returns it; pass it back). At `caps.critic` (3) it answers "cap reached; decide and log" without running. `relay_dispatch {draft, overrides}` copies the draft's rounds into the job and records the overrides, which the report lists right after Approvals.

**Escalation and re-plan (D8).** Rounds 1..`caps.judge` go to the worker. The next `caps.escalate` rounds go to the escalate model (RPC `set_model`; a restart keeps it). Then the job pauses with reason `replan` and the lead is woken: `relay_replan {job, brief}` replaces the brief (same Targets; the old amendments, approvals included, are kept and a re-plan amendment is added), resets the round counters and starts a new session on the same worktree. After `caps.replans` the job stops.

**Stall and tool timeouts.** The watcher tracks events and running tools. A stall (`stallMin`, 10, with no events and no tool running) or a tool past its timeout (bash `bashTimeoutMin`, 60; `toolTimeouts` patterns) aborts the worker and restarts it once with `-c` in the same session folder. The next failure, or a process crash after the restart, pauses the job and wakes the lead (`relay_resume` or `relay_stop`). A restart counter resets when the worker reports done.

**Pause and takeover.** `/relay pause <job>` aborts and stops the worker and sets `paused`; work in the set with `/wt open <set>`, then `/relay resume <job>` (or `relay_resume`), which restarts the worker with `-c` (a job paused while judging runs the judge again).

**Resume and adoption.** When lead mode turns on, and every 10 min, the lead scans `<git common dir>/pi/relay/*/job.json` for unfinished jobs. A job whose lock names this lead (a reload) is re-attached at once; a job with a stale lock (heartbeat older than 2 min, or a dead pid) is taken over (`takeOver`), a surviving worker pid is killed, and the worker restarts with `-c` (a judging job re-runs the judge, a delivering job re-delivers). One notice per job, no prompt. A job whose lock is fresh belongs to a live lead and is left alone. Job-set sessions never scan. The same scan does the **PR-only cleanup**: for a `done` job with a PR that is not merged, it asks `gh pr view <pr> --json state,mergeCommit`; when the PR is `MERGED` it sets `merged` and sends W2 without `force` (a refusal is reported in one notice; a `gh` error is retried on the next scan).

**Follow-ups.** `relay_followup {job, text}` (`/relay followup <job> <text>`) continues a `done`, `stopped` or `failed` job, also one of an earlier session. It takes the lock (taking a stale one over), appends the amendment, has the critic check only the amendment, and then the `followup` step chooses the workspace:
- not merged, set present: the set and branch are reused (`remoteBranch` and `remotePushed` stay, so the push updates the same PR);
- not merged, set gone: a new set `<id>-f<N>` from `origin/<remoteBranch>` (or the local job branch); the push still goes to the same `remoteBranch` with the lease;
- merged: a new set `<id>-f<N>` from `origin/<target>`, a new branch, no `remoteBranch`: delivery opens a new PR; the old set, if still there, gets W2 without `force` (a refusal is reported); the old remote branch is left alone. A job that merged only some of its repos is refused (start a new job).

`followBase` is the worktree HEAD at the start, so the judge reviews `followBase..HEAD` only. The new worker session lives in `sessions/f<N>/`. Delivery and cleanup are the job's; the previous `report.md` is kept as `report.before-followup-<N>.md` and the new one has a `## Follow-up N` section with its own Approvals.

### Edit budget

The lead may edit up to 40 uncommitted lines or 3 files (`editBudget`), counted across its working repo and its added folders (`git diff --numstat HEAD` plus the line counts of untracked files). At the limit, `edit` and `write` are refused: "write a brief and `relay_dispatch` it (your uncommitted edits move into the job)". A commit resets the count. **Limit:** bash is never blocked up front. After each bash `tool_result` the budget is measured again; if bash pushed it over, the lead gets a notice and the next `edit` or `write` is refused.

### Lead edits move into the job

`snapshotEdits` builds a commit (parent: the lead's HEAD) over a temporary index, so new files are included and staged files are unstaged by the revert. The branch `relay/<id>/lead-edits` keeps it from garbage collection. In the new worktree `git cherry-pick <snapshot>` applies only the uncommitted edits, so the lead's unpushed commits stay out. A conflict aborts the cherry-pick, removes the new set (W2 `force`), fails the dispatch with the paths and leaves your edits untouched. Your checkout is reverted only after the cherry-pick worked, path by path and only when the file still hashes to the snapshot's blob; a path that changed since is skipped and noted in `job.notes`. The branch is deleted after delivery.

## The brief

`##` headings in `brief.md`:

- Required: `Goal`, `Done when` (bullets), `Non-goals`, `Constraints`, `Decisions (locked)`, `Design`, `Scale` (numbers; the lead assumes numbers when none are given).
- `Targets`: one line per repo, `<repo dir or name>: <branch>`. A repo that is neither the lead's repo nor one of its added folders is refused at `relay_dispatch` (add it with `/folders add <path>`, or target the session's worktree of it).
- `Authority`: one line each for `merge`, `publish`, `comments`, `delete`, `formats`, `deps`: `yes (<specifics>)`, `no` or `n/a`. A `yes` without specifics is invalid for `merge`, `publish`, `delete` and `formats`.
- Optional: `Verify` (cheap static checks or tests the user asked for, commands one per line; `<repo key>: <cmd>` runs in that repo, any other line in the first repo; by default none, and the worker runs no other tests; it may write or update tests that help the change and lists them in its report as not run), `Budget` (`wall: 120m; tokens: 8M; size: small|normal|large`), `Files` (globs, see below), `Depends on` (stage 4), `Publish` (exact commands, only with `publish: yes`).

### Files enforcement

A brief with a `## Files` section limits the job to those globs, relative to each job repo's root (no section: no limit). One line lists globs separated by commas. A line `<repo>: glob, glob` (the repo's folder name or path) applies only to that repo; a line without a repo applies to every repo. Scoped entries stay `<repo>: <glob>` strings in `files.json`, and `globsFor` keeps those whose repo equals the repo key or its folder name (case-insensitive). Dispatch writes `files.json` in the job dir: the globs plus the paths of the lead's snapshot commit, keyed by repo (the worker is never failed for files it did not change; a path snapshotted in repo A is not allowed in repo B). `relay_replan` rewrites the globs from the new brief and keeps the snapshot paths. The globs in force for a repo are the Files globs, its snapshot paths and every approved `files` item, read on every check, so an approval applies at once. An old `files.json` with a flat snapshot list applies to every repo.

- `worker-guard` refuses an `edit`/`write` of a path outside the globs and tells the worker to `ask_lead` with `approval {category: "files", item: <glob>, why}`.
- After each worker `bash` call, the changed paths (`git status --porcelain -uall` per job repo) outside the globs are appended to the tool result as a warning.
- Before the judge runs, a job diff with paths outside the globs fails the round without a judge call; the paths are the round's finding (`judge/round-N.md`, so the next judge sees them) and the round counts as a judge round.

`files` is an approval category only (`APPROVAL_CATEGORIES`), never an Authority line: the brief's Authority keeps its six categories.

Amendments are appended as `## Amendment N (lead|user|approval): ...`; the version is 1 plus the number of amendments. An approval is an amendment, so the judge sees it. `validateBrief` refuses an incomplete brief at dispatch.

## Authority

Sensitive categories: `merge` (merge or push to a protected branch), `publish`, `comments` (`gh issue|pr comment|close|review`, issue writes through `gh api`), `delete` (`git branch -D`, `push --delete`, `rm -rf` outside the set), `formats` (CI, schemas, migrations, secrets: `sensitivePaths`), `deps` (installs, manifests and lockfiles). `authority.ts` classifies commands and paths; `allowed` is true when the brief's Authority or an approval covers the item.

- The worker's guard (`worker-guard.ts`, in `worker.ts`) always refuses `git push`, any `gh` write, publishing, branch deletion, and checkout/switch/reset to a ref other than the job's branch or base. It refuses dependency installs and edits of sensitive paths unless Authority or an approval covers them. Every refusal says to use `ask_lead`.
- `ask_lead {question, approval?: {category, item, why}}` appends to `outbox.jsonl` and polls `inbox.jsonl` once a second. `category` is one of the six or `files` (a path outside `## Files`).
- The lead answers with `relay_approve {job, askId, approve, reason}` (for a plain question `reason` is the answer). A category in `askUser` is refused ("ask the user first"). An approval adds an amendment, updates `approvals`. The report starts with an Approvals section.
- Default sensitive paths: `**/package.json`, `**/package-lock.json`, `**/pnpm-lock.yaml`, `**/*.csproj`, `**/Packages/manifest.json`, `.github/workflows/**`, `**/.env*`.

## Files

`<git common dir of the lead's cwd repo>/pi/relay/<id>/`: `brief.md`, `job.json`, `owner.<gen>.lock`, `outbox.jsonl`, `inbox.jsonl` (+ cursors), `log.jsonl`, `critic/round-N.md` (+ `round-N.json` with its `weightedCost`), `judge/round-N.md`, `guard.json`, `files.json` (with a `## Files` section), `agents-usage.jsonl` (the worker's agents-tool runs), `sessions/`, `report.md`. Critic drafts live in `.../pi/relay/drafts/<draft>/`. `lead-actions.jsonl` is in the same root (or `<agent dir>/relay/` outside a git repo). `relay_dispatch` and `relay_critic` refuse outside a git repo. Other Target repos are referenced from `job.json` by path.

| File | Responsibility |
|---|---|
| `index.ts` | Entry; inert when `RELAY_ROLE` is set. The logic is in `lead.ts` (testable with a fake `pi`): `leadOn`, the prompt, typed "go", edit budget, action log, tools, commands. |
| `worker.ts`, `worker-guard.ts` | Worker entry (`ask_lead`, `report_done`, the guard) and its pure checks. |
| `reviews.ts` | Relay's `criteria` for the agents judge and critic (brief rules, `[plan]`, `[locked]`, `[authority]`). |
| `files.ts`, `usage.ts` | `## Files` globs (`files.json`); the token sources read from files (`agents-usage.jsonl`, draft critic rounds). |
| `config.ts` | `relay.json`: defaults, validation, warnings, `repoPolicy`. |
| `pi-bin.ts` | `piCommand(args)`; `RELAY_PI_BIN` for tests. |
| `brief.ts`, `job.ts`, `lock.ts`, `mailbox.ts` | Brief parse/validate/amend, `job.json` store, the generation lock, JSONL mailboxes with cursors. |
| `engine.ts`, `types.ts`, `steps/*` | The step runner and the steps: `dispatch`, `work`, `judge`, `deliver`, `report`, `cleanup` (+ `critic`). A new step is one module plus one entry in `engine.ts` `STEPS`. |
| `rpc.ts` | The RPC client (strict LF JSONL on bytes, responses by id). |
| `snapshot.ts`, `budget.ts`, `authority.ts`, `events.ts` | Lead-edit snapshot, edit/job budgets, categories, lead-mode activation. |
| `prompts/{lead,worker}.md` | Prompts (the judge and critic base prompts are agents'). |
| `test/fake-pi.mjs`, `e2e/live.mjs` | The scripted pi and the live test. |

### Step contract

```ts
interface Step { name: StepName; run(job: Job, ctx: StepCtx): Promise<StepName | "wait" | "end"> }
```

The engine persists `job.state` before each step. `"wait"` parks the job until something resumes it: an outbox message, a worker settle, or a lead tool call. A job in `working` is re-driven by the watcher (every second); the other states move only on events and tool calls. Ownership (`isOwner()`) is checked before every step that drives the job.

## The job lock (generation lock)

Lock files `owner.<n>.lock` hold `{pid, sessionId, host, heartbeat}`. `acquire` creates `owner.1.lock` with `O_EXCL`. `takeOver` (adoption: see Running jobs) reads the highest generation, requires it to be stale (heartbeat older than 2 min, or the pid dead on this host; an unreadable file only by mtime), creates `owner.<n+1>.lock` through a hard link (so it fails on `EEXIST`), runs `isOwner()` again, and only then deletes lower generations; if the recheck fails it deletes its own file and reports failure. `isOwner()` needs the highest generation and the lead's `sessionId`, `pid` and `host`. The heartbeat (every 30 s) writes a temp file and renames it over the lock, with 5 retries on `EPERM`/`EBUSY`/`EACCES` (50 to 800 ms backoff); if all fail it counts as not written, and the lead loses the job only when a later `isOwner()` fails. File locks are reliable on one host only.

## Delivery and the push rule

Per repo, in Targets order: `git fetch`, then `git rebase origin/<target>`. A clean rebase with no overlap between the upstream changes and the job's files, and (when `verifyAfterRebase` is true) a passing Verify, is `passedViaRebase`. A conflict, an overlap or (when `verifyAfterRebase` is true) a failing Verify is a fix round (the rebase is aborted on a conflict) followed by a judge. A multi-repo job pushes and merges only when every repo is accepted.

- **First push:** `git push origin HEAD:<remoteBranch>`; the branch must not exist on origin (otherwise delivery stops and the lead is woken). `remoteBranch` is set to the branch name at this push.
- **Later pushes** (after a delivery rebase): `git push --force-with-lease=<remoteBranch>:<remotePushed> origin HEAD:<remoteBranch>`, only on the job's own branch, never the target or a protected branch. After each push `remotePushed` is the sha pushed. A lease failure means someone else pushed (for example you after `/wt open`): delivery stops, the lead is woken, nothing is overwritten.
- `../shared/git/push-guard.ts` lets these pushes through only when the delivery step passes a `lease`; the worker guard refuses every push.
- With a GitHub `origin` relay checks it with `gh repo view <owner/name> --json name` and creates a PR when none is open. When that check fails (auth, network, CLI change) or no PR could be opened, delivery stops with an error (`relay_deliver` retries); it never falls back to a direct push to the target. **Merge** when Authority `merge` is yes (or approved), or when the repo's `merge` is `after-pass` and Authority is not `no`: `gateCheck` on the accepted tree, then `gh pr merge --squash --match-head-commit <sha>`; only when `origin` is not GitHub at all, a fast-forward `git push origin <sha>:<target>` (if the target moved, rebase again, up to 3 times). Merging after PASS is the default (`defaultMerge` is `after-pass`), also for `merge: n/a`. To opt out put `merge: no` in a brief, or `pr-only` for the repo in relay.json `repos`. Otherwise (`pr-only`, or Authority `no`) the set is kept until the PR merges; the PR-only cleanup (below) removes it later.
- After all merges the `Publish` commands run, only with `publish: yes`.

## Config: `relay.json`

The path is `RELAY_CONFIG`, or else `<agent dir>/relay.json`. Invalid keys fall back to their defaults with a warning.

| Key | Default |
|---|---|
| `active` | `false`: lead mode starts off; `/relay on` turns it on (`true` starts it on) |
| `roles` | escalate: Opus 5.5 high; worker `{small: Haiku 5.5, normal: Sonnet 5.5, large: Opus 5.5}` medium. The judge and critic are agents roles (`agents.json`, `/agents model judge|critic`) |
| `editBudget` | `{lines: 40, files: 3}` |
| `maxJobs` | `3` |
| `caps` | `{critic: 3, judge: 3, escalate: 2, replans: 1}` |
| `budget` | `{wallMin: 120, tokens: 8000000, graceMin: 30, graceTokenShare: 0.1}`; see "Token cap" |
| `stallMin`, `bashTimeoutMin` | `10`, `60` |
| `toolTimeouts` | `[]` (`[{pattern, minutes}]`); a pattern longer than the wall budget warns on load, and a job whose Verify or Design matches gets at least timeout x 2 + 60 min |
| `worker.extensions` | `[]` (the worker's `-e` list is `worker.ts`, the agents extension, these, plus `builtin:mcp` and agents' `mcp-forward.ts` only when the knowledge server is registered) |
| `repos` | `{"<path glob or owner/name>": {merge: "after-pass"\|"pr-only", protectedBranches, sensitivePaths}}` |
| `defaultMerge` | `"after-pass"` (`"pr-only"` opts out for all repos; a brief with `merge: no` opts out for one job) |
| `verifyAfterRebase` | `false` (`true` reruns the brief's Verify commands after a delivery rebase that changed the tree) |
| `askUser` | `[]` (categories the lead must ask you about before approving) |
| `knowledge` | `{server: "knowledge", tools: [search, get_entry, get_rule_pack, get_schema, status], env: {KNOWLEDGE_OFFLINE: "1"}}`: the **worker's** knowledge tools only (the judge's and critic's come from agents.json `knowledge`) |
| `approvePattern` | as in `workflow.json` |

Moved to agents.json: `roles.judge`, `roles.critic`, `reviewer`, `judge.maxDiffChars`, `tokenWeights`, `knowledge.roles`, `knowledge.judgeCheck`. An old relay.json with any of them loads with one warning and they are ignored.

`/relay model <role> <provider/id[:thinking]>` (roles: escalate, worker.small, worker.normal, worker.large) rewrites the file; for the judge and critic it points to `/agents model`.

**Token cap.** `job.used.tokens` is agents `costOf` units (weighted tokens x the model's agents.json `modelCost` multiplier: Haiku 0.2, Sonnet 0.6, Opus 1.0) and counts every source: the worker (priced by the model it runs on, the escalate model once escalated), every judge run, every critic run of the job (restart and follow-up amendments), the `relay_critic` rounds of the dispatched draft (each round's `weightedCost` in `critic/round-N.json`, added at dispatch), and the worker's agents-tool runs (`weightedCost` of each line of `agents-usage.jsonl`; the counted byte offset is `job.json` `usageOffset`, so no line counts twice, also after a lead takeover). The default cap is 8M (`budget.tokens`, or the brief's `Budget`).

**Worker tools.** The worker process loads the agents extension with `PI_AGENTS_TOOLS=explore,advisor,test_run`, `PI_AGENTS_USAGE_FILE=<job dir>/agents-usage.jsonl` and `PI_AGENTS_ADVISOR_CAP` = 3 minus the advisor runs already in that file (failed ones too), so the cap holds per job across restarts and escalation (a run killed mid-flight leaves no line: a restart may overshoot by one). The worker prompt says when to use each.

The numbers are starting values, to be tuned after first use.

## Contracts

- **W1 `worktree:create`** with `launch: "none"`: relay's dispatch sends `{v:1, name: <job id>, launch:"none", bases: {<repo top>: "origin/<target>"}, folders}` (`folders`: the lead's added folders that are Targets). The reply carries `branch`, `cwd` and `repos: [{top, cwd}]`; relay never builds a branch name itself.
- **W2 `worktree:remove`** `{v:1, name, force?}`: used after a merge (no force) and to undo a failed dispatch (force). Never shows a dialog; refuses in-use or broken sets; a refusal or a kept branch is reported.
- **K1 `session-folders`**: the lead's added folders, written by the `workspace` extension into the session entries and read from there.
- **Relay and flow are switched by hand.** Relay does not ask workflow, and workflow does not ask relay. Lead mode is decided by `relay.json` `active` (default off), `RELAY_ROLE` and the worktree-set rule; `/relay on|off` switch it. Both can be on in one session, and a typed "go" is then handled by both (relay's kickoff and workflow's plan approval), so turn one of them off first.
- **Worktree-set sessions.** A session whose cwd is inside any folder that holds a `.pi-set.json` (a job's set such as `r1a2b3c`, or a user's set; a worker, a `/wt open` takeover) keeps lead mode off: no edit budget, no "go" hook, no dispatch, and `/relay on` refuses. Run the lead from the main checkouts. Workers get a Workspace section in every prompt (start, restart, re-plan, follow-up) listing each repo of the job with worktree, branch, target, base and its `AGENTS.md`/`CLAUDE.md` (path and size).

## Parallel and stacked jobs, add-repo, widget and log

**Queue.** `maxJobs` (3) jobs run at once; the rest are `queued` and start in creation order when a slot frees (a worker slot is held only by a job that started). Two jobs whose `Files` (or the paths named in backticks in Design) overlap, in a repo with the same name, get a notice and an `overlap` log entry each at dispatch; relay does not serialise them.

**Stacked jobs (D17).** `## Depends on` names a job id of this repo. The dependent stays `queued` (holding no slot) until its predecessor is `done`, or `delivering` with every repo pushed; its set starts at the head of the predecessor's pushed branch (`origin/<remoteBranch>`), its judge diff is `base..HEAD` of its own work, and its PR is opened against the predecessor's branch and is not merged. A predecessor that already merged means a plain job on the target. Once the predecessor merged (the PR-only scan sets `merged`, or an after-pass delivery did), the dependent is delivered again: `git rebase --onto origin/<target> <predecessor head>` (this also drops a squash-merged predecessor), the D14 rules (overlap, Verify, `passedViaRebase`), `gh pr edit --base <target>`, then a push with the lease against `remotePushed`. If the predecessor stops or fails, its dependents stop with that reason. An unknown predecessor is refused at dispatch.

**Add a repo.** `relay_add_repo {job, folder, target, askId?}` emits W3: a worktree of `folder` joins the job's set on `origin/<target>`; the repo is added to the job (judge diff, delivery, guard paths), the worker is told with a steer and, with `askId`, its ask is answered. Only a working or paused job.

**Dock and log.** The right column of the shared dock below the editor (worktree's session list is the left one) shows the unfinished jobs of this session, published every 2 s as `dock:lines {v:1, key:"relay", side:"right", lines}` (`Engine.dockLines`; nothing is read from disk). Per job a header: id, state, round (`e` once escalated), wall minutes used/budget, tokens used, `<- dependsOn`; under it, always (also when collapsed), the model line `  <role> <model id>[:thinking]` (provider dropped) of who works on the job now: `critic` or `judge` while they review, else `worker` (`worker (escalated)` with the escalate model; the running worker's own model when it was started with another one) (`Engine.activeModel`). While `working`: the judge's latest verdict (`judge round N: PASS|FAIL (k findings)`) until the worker's next tool call, then the last 3 worker tool calls, newest first (`▸ tool arg 6m12s` running, `· tool arg` finished). While `judging`: `judge reviewing round N`. Other states: the header only; with more than 2 unfinished jobs every job is its header only. With lead mode on and no unfinished job the column is one line, `relay lead · no jobs running`; it leaves when lead mode goes off. Relay publishes full lines; the dock truncates (layout rule in `../shared/README.md`). It attaches the dock at `session_start` when the session has a UI. **Footer status** (key `relay`): `relay ready` from `session_start` until lead mode is decided (at the first prompt) when it can still come on, then `relay lead` while lead mode is on, with ` · n jobs` for the unfinished jobs this lead owns; set when lead mode is decided or toggled (`/relay on|off`), refreshed every 2 s, cleared at `session_shutdown`. `/relay log <job> [n]` shows the last n lines of `log.jsonl` (tool names with a short first argument, verdicts, amendments, approvals, overlaps, restacks) and the job's paths.

## Tools and commands

`relay_critic {brief, draft?}`, `relay_dispatch {brief, size?, draft?, overrides?}`, `relay_status {job?}`, `relay_approve {job, askId, approve, reason}`, `relay_stop {job}`, `relay_deliver {job}`, `relay_send {job, text, mode, reset?, from?}`, `relay_replan {job, brief}`, `relay_resume {job}`, `relay_followup {job, text}`, `relay_add_repo {job, folder, target, askId?}`. Commands: `/relay` (status), `/relay on|off` (off is refused while this lead owns running jobs), `/relay go`, `/relay stop <job>`, `/relay pause <job>`, `/relay resume <job>`, `/relay followup <job> <text>`, `/relay log <job> [n]`, `/relay model <role> <spec>`.

## Dependencies

- **agents** (`../agents/api.ts` only): `runJudge`, `runCritic` (relay passes `timeoutMs` 30 min, `idleTimeoutMs` 10 min, the lead's trust, the registered MCP servers and, in tests, `EngineDeps.runReviewer` as the runner), `costOf`, the knowledge helpers, `AGENTS_EXTENSION`, `FORWARD_EXTENSION`, `FORWARD_ENV` and the `PI_AGENTS_*` env names. The RPC worker (`rpc.ts`) stays relay's own.
- **shared**: `git/merge-gate.ts`, `git/push-guard.ts` (with the `lease` option), `git/repo-diff.ts`, `session-folders.ts` (`newestFolders`), findings, tokens, roles, dock, claims, the bash parser.

## Tests

`node --experimental-strip-types --import ../agents/test-hooks.ts --test *.test.ts` in this folder (about 2 min; agents' hooks stub the pi packages and point `getAgentDir` at a temp folder, so no test reads your `agents.json`; `running.test.ts` covers the running-job behaviour with a fake clock where time matters; `stage4.test.ts` the queue, stacked jobs with a faked `gh`, add-repo, widget and log). The engine tests use `RELAY_PI_BIN=test/fake-pi.mjs` as the scripted RPC worker, and `test/env.ts` `scriptedReviewer` as the agents runner that plays the script's judge and critic replies, with real git repos and bare remotes. `e2e/live.mjs` runs the whole thing with real models (15-25 min): `node pi/agent/extensions/relay/e2e/live.mjs`.

## Limits

- The judge rechecks the whole diff each round (full mode, plus the previous findings), not only the delta.
- Closing the lead session kills its workers; the jobs stay on disk and the next lead session adopts them (after 2 min if the pid is alive, at once if the pid is dead or the session is the same). Killing a surviving worker by pid assumes the pid was not reused.
- A restart or follow-up critic check costs one model run; a critic failure twice refuses the change rather than skipping the check.
- Escalation switches the model with `set_model`; the thinking level of the escalate role is not applied to a running worker.
- File locks are reliable on one host only; about 10 workers at once at roughly 300 MB per process; a diff larger than agents.json `judge.maxDiffChars` gives the judge the file list plus the diffs that fit.
- Stacking needs GitHub: the predecessor counts as merged when its PR is `MERGED` (the PR-only scan) or relay merged it; without a PR a stacked job stays stacked.
- A stacked job assumes the predecessor's branch is not rewritten after the dependent started; if it is, the plain rebase onto it can conflict and becomes a fix round. Overlap detection is by file names and globs only, per repo name.
- Bash is not blocked against the edit budget up front.

## Completions

`/relay ` offers the subcommands with a one-line description (`commands.ts`). `stop`, `pause`, `resume`, `followup` and `log` then list **this session's jobs** (from memory, with the state), and `model` walks role → models with auth → thinking level (`provider/id:<level>`). The table in `commands.ts` also builds the description and the tests.
