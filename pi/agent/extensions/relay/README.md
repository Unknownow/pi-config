# relay

An autonomous lead / worker / judge extension for hands-off work. Your session is the **lead**: it discusses the what and the how with you, does small work itself, and hands real work to headless **workers**. A **critic** checks each brief before dispatch; a **judge** checks each result. Relay delivers within the Authority you agreed, then writes a report. "go" is the only input relay needs from you; the report is the only output you need to read.

`workflow` stays installed and standalone for manual control. Relay imports nothing from `workflow`, `orchestrate`, `worktree`, `agents` or `sandbox` (`boundary.test.ts`); it talks to `worktree` through events and uses `../shared` only.

## Roles

| Role | What it is |
|---|---|
| lead | Your session (Opus). Always on in lead mode, takes input at any time. Reads, searches, runs bash, tests and builds, commits, pushes, opens PRs, and takes sensitive actions without asking (all logged). Edits up to the **edit budget** itself. |
| critic | One-shot, read-only (`reviewer.ts`). Reads the brief against the code: efficiency at the stated scale, a path for the named extensions, fit with the repo's patterns, no duplication, neither under- nor over-engineered, Authority covered. Up to 3 rounds per draft. |
| worker | A `pi --mode rpc -ne -ns -np -e worker.ts` process (Sonnet by default, per-job size) in a worktree set. Never pushes, merges or publishes. |
| judge | One-shot, read-only. Judges the diff against the **current brief version**. Any change Authority does not cover is a blocker. |
| escalate | A stronger model that takes over the worker after the judge rounds. |

## The flow

1. You discuss with the lead. When you say "go" (typed, or `/relay go`), the lead writes the brief, runs `relay_critic` (revising up to 3 rounds), and `relay_dispatch`es it.
2. Dispatch: validate, assign a job id (`r` + 6 base36 characters), write `brief.md` and `job.json`, take the job lock, snapshot your uncommitted edits, create the set (W1 with `launch: "none"`), cherry-pick the snapshot as the job's first commit ("relay: lead edits"), revert your checkout, start the worker.
3. The worker works, asks (`ask_lead`) when it must, and finishes with `report_done`. The judge reviews `base..HEAD`. FAIL: the worker gets the findings (one notice, the lead is not woken). PASS: the lead is woken and delivery starts. After `caps.judge` (3) failed rounds the worker is switched to the escalate model for `caps.escalate` (2) more; then the lead is woken to re-plan (`relay_replan`, up to `caps.replans`, 1); then the job stops and is reported.
4. Delivery rebases onto `origin/<target>` per repo, pushes, opens the PR (with GitHub), and merges within Authority.
5. `report.md` is written; the lead gets 3 lines and the path; `relay:job-end` is emitted; the worker exits; the set is removed if everything merged.

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

- Required: `Goal`, `Done when` (bullets), `Non-goals`, `Constraints`, `Decisions (locked)`, `Design`, `Scale` (numbers; the lead assumes numbers when none are given), `Verify` (commands, one per line; `<repo key>: <cmd>` runs in that repo, any other line in the first repo).
- `Targets`: one line per repo, `<repo dir or name>: <branch>`.
- `Authority`: one line each for `merge`, `publish`, `comments`, `delete`, `formats`, `deps`: `yes (<specifics>)`, `no` or `n/a`. A `yes` without specifics is invalid for `merge`, `publish`, `delete` and `formats`.
- Optional: `Budget` (`wall: 120m; tokens: 4M; size: small|normal|large`), `Files` (globs), `Depends on` (stage 4), `Publish` (exact commands, only with `publish: yes`).

Amendments are appended as `## Amendment N (lead|user|approval): ...`; the version is 1 plus the number of amendments. An approval is an amendment, so the judge sees it. `validateBrief` refuses an incomplete brief at dispatch.

## Authority

Sensitive categories: `merge` (merge or push to a protected branch), `publish`, `comments` (`gh issue|pr comment|close|review`, issue writes through `gh api`), `delete` (`git branch -D`, `push --delete`, `rm -rf` outside the set), `formats` (CI, schemas, migrations, secrets: `sensitivePaths`), `deps` (installs, manifests and lockfiles). `authority.ts` classifies commands and paths; `allowed` is true when the brief's Authority or an approval covers the item.

- The worker's guard (`worker-guard.ts`, in `worker.ts`) always refuses `git push`, any `gh` write, publishing, branch deletion, and checkout/switch/reset to a ref other than the job's branch or base. It refuses dependency installs and edits of sensitive paths unless Authority or an approval covers them. Every refusal says to use `ask_lead`.
- `ask_lead {question, approval?: {category, item, why}}` appends to `outbox.jsonl` and polls `inbox.jsonl` once a second.
- The lead answers with `relay_approve {job, askId, approve, reason}` (for a plain question `reason` is the answer). A category in `askUser` is refused ("ask the user first"). An approval adds an amendment, updates `approvals` and emits `relay:approval`. The report starts with an Approvals section.
- Default sensitive paths: `**/package.json`, `**/package-lock.json`, `**/pnpm-lock.yaml`, `**/*.csproj`, `**/Packages/manifest.json`, `.github/workflows/**`, `**/.env*`.

## Files

`<git common dir of the lead's cwd repo>/pi/relay/<id>/`: `brief.md`, `job.json`, `owner.<gen>.lock`, `outbox.jsonl`, `inbox.jsonl` (+ cursors), `log.jsonl`, `critic/round-N.md`, `judge/round-N.md`, `guard.json`, `sessions/`, `report.md`. Critic drafts live in `.../pi/relay/drafts/<draft>/`. `lead-actions.jsonl` is in the same root (or `<agent dir>/relay/` outside a git repo). `relay_dispatch` and `relay_critic` refuse outside a git repo. Other Target repos are referenced from `job.json` by path.

| File | Responsibility |
|---|---|
| `index.ts` | Entry; inert when `RELAY_ROLE` is set. The logic is in `lead.ts` (testable with a fake `pi`): K16 listener, `leadOn`, the prompt, typed "go", edit budget, action log, tools, commands. |
| `worker.ts`, `worker-guard.ts` | Worker entry (`ask_lead`, `report_done`, the guard) and its pure checks. |
| `reviewer.ts` | Critic and judge entry; refuses every non-reading tool. |
| `config.ts` | `relay.json`: defaults, validation, warnings, `repoPolicy`. |
| `pi-bin.ts` | `piCommand(args)`; `RELAY_PI_BIN` for tests. |
| `brief.ts`, `job.ts`, `lock.ts`, `mailbox.ts` | Brief parse/validate/amend, `job.json` store, the generation lock, JSONL mailboxes with cursors. |
| `engine.ts`, `types.ts`, `steps/*` | The step runner and the steps: `dispatch`, `work`, `judge`, `deliver`, `report`, `cleanup` (+ `critic`). A new step is one module plus one entry in `engine.ts` `STEPS`. |
| `rpc.ts` | The RPC client (strict LF JSONL on bytes, responses by id). |
| `snapshot.ts`, `budget.ts`, `authority.ts`, `events.ts` | Lead-edit snapshot, edit/job budgets, categories, K16 and `relay:*` payloads. |
| `subagent.ts`, `mcp-forward.ts`, `repo-diff.ts`, `merge-gate.ts`, `push-guard.ts` | Copies of the workflow modules, adapted (see below). |
| `prompts/{lead,critic,worker,judge}.md` | Prompts. |
| `test/fake-pi.mjs`, `e2e/live.mjs` | The scripted pi and the live test. |

### Step contract

```ts
interface Step { name: StepName; run(job: Job, ctx: StepCtx): Promise<StepName | "wait" | "end"> }
```

The engine persists `job.state` before each step. `"wait"` parks the job until something resumes it: an outbox message, a worker settle, or a lead tool call. A job in `working` is re-driven by the watcher (every second); the other states move only on events and tool calls. Ownership (`isOwner()`) is checked before every step that drives the job.

## The job lock (generation lock)

Lock files `owner.<n>.lock` hold `{pid, sessionId, host, heartbeat}`. `acquire` creates `owner.1.lock` with `O_EXCL`. `takeOver` (adoption: see Running jobs) reads the highest generation, requires it to be stale (heartbeat older than 2 min, or the pid dead on this host; an unreadable file only by mtime), creates `owner.<n+1>.lock` through a hard link (so it fails on `EEXIST`), runs `isOwner()` again, and only then deletes lower generations; if the recheck fails it deletes its own file and reports failure. `isOwner()` needs the highest generation and the lead's `sessionId`, `pid` and `host`. The heartbeat (every 30 s) writes a temp file and renames it over the lock, with 5 retries on `EPERM`/`EBUSY`/`EACCES` (50 to 800 ms backoff); if all fail it counts as not written, and the lead loses the job only when a later `isOwner()` fails. File locks are reliable on one host only.

## Delivery and the push rule

Per repo, in Targets order: `git fetch`, then `git rebase origin/<target>`. A clean rebase with no overlap between the upstream changes and the job's files, and a passing Verify, is `passedViaRebase`. A conflict, an overlap or a failing Verify is a fix round (the rebase is aborted on a conflict) followed by a judge. A multi-repo job pushes and merges only when every repo is accepted.

- **First push:** `git push origin HEAD:<remoteBranch>`; the branch must not exist on origin (otherwise delivery stops and the lead is woken). `remoteBranch` is set to the branch name at this push.
- **Later pushes** (after a delivery rebase): `git push --force-with-lease=<remoteBranch>:<remotePushed> origin HEAD:<remoteBranch>`, only on the job's own branch, never the target or a protected branch. After each push `remotePushed` is the sha pushed. A lease failure means someone else pushed (for example you after `/wt open`): delivery stops, the lead is woken, nothing is overwritten.
- `push-guard.ts` (copy) lets these pushes through only when the delivery step passes a `lease`; the worker guard refuses every push.
- With GitHub (`gh repo view` works) a PR is created when none is open. **Merge** when Authority `merge` is yes (or approved), or when the repo's `merge` is `after-pass` and Authority is not `no`: `gateCheck` on the accepted tree, then `gh pr merge --squash --match-head-commit <sha>`; without GitHub a fast-forward `git push origin <sha>:<target>` (if the target moved, rebase again, up to 3 times). Merging after PASS is the default (`defaultMerge` is `after-pass`), also for `merge: n/a`. To opt out put `merge: no` in a brief, or `pr-only` for the repo in relay.json `repos`. Otherwise (`pr-only`, or Authority `no`) the set is kept until the PR merges; the PR-only cleanup (below) removes it later.
- After all merges the `Publish` commands run, only with `publish: yes`.

## Config: `relay.json`

The path is `RELAY_CONFIG`, or else `<agent dir>/relay.json`. Invalid keys fall back to their defaults with a warning.

| Key | Default |
|---|---|
| `active` | `true` (`false` makes relay inert) |
| `roles` | critic, judge, escalate: Opus 5.5 high; worker `{small: Haiku 5.5, normal: Sonnet 5.5, large: Opus 5.5}` medium; critic and judge also take `prompt` and `tools` |
| `editBudget` | `{lines: 40, files: 3}` |
| `maxJobs` | `3` |
| `caps` | `{critic: 3, judge: 3, escalate: 2, replans: 1}` |
| `budget` | `{wallMin: 120, tokens: 4000000, graceMin: 30, graceTokenShare: 0.1}` |
| `stallMin`, `bashTimeoutMin` | `10`, `60` |
| `toolTimeouts` | `[]` (`[{pattern, minutes}]`); a pattern longer than the wall budget warns on load, and a job whose Verify or Design matches gets at least timeout x 2 + 60 min |
| `reviewer.extensions` | `[]`; the critic and judge load these next to `reviewer.ts` (normally the model provider, e.g. `~/.pi/agent/npm/node_modules/pi-claude-bridge/src/index.ts`) |
| `worker.extensions` | `[]` (the worker's `-e` list is `worker.ts` plus these, plus `builtin:mcp` and `mcp-forward.ts` only when the knowledge server is registered) |
| `repos` | `{"<path glob or owner/name>": {merge: "after-pass"\|"pr-only", protectedBranches, sensitivePaths}}` |
| `defaultMerge` | `"after-pass"` (`"pr-only"` opts out for all repos; a brief with `merge: no` opts out for one job) |
| `askUser` | `[]` (categories the lead must ask you about before approving) |
| `knowledge` | as in `workflow.json` |
| `judge.maxDiffChars` | `400000` |
| `tokenWeights`, `approvePattern` | as in `workflow.json` |

`/relay model <role> <provider/id[:thinking]>` (roles: critic, judge, escalate, worker.small, worker.normal, worker.large) rewrites the file.

The numbers are starting values, to be tuned after first use.

## Contracts

- **W1 `worktree:create`** with `launch: "none"`: relay's dispatch sends `{v:1, name: <job id>, launch:"none", bases: {<repo top>: "origin/<target>"}, folders}` (`folders`: the lead's added folders that are Targets). The reply carries `branch`, `cwd` and `repos: [{top, cwd}]`; relay never builds a branch name itself.
- **W2 `worktree:remove`** `{v:1, name, force?}`: used after a merge (no force) and to undo a failed dispatch (force). Never shows a dialog; refuses in-use or broken sets; a refusal or a kept branch is reported.
- **K1 `session-folders`**: the lead's added folders, read from the session entries.
- **K16 `flow:active`**: one owner per session with workflow. `{v:1, from:"workflow"|"relay", claim}`; each extension ignores its own `from`. Relay's listener is registered at load; while its activation is undecided it claims `{owner:"relay"}` when `active` is true. `leadOn(ctx)` decides once, on the first of `input`, `before_agent_start` or any relay tool or command: it emits `{from:"relay"}`; an `owner:"workflow"` answer keeps lead mode off with a notice, anything else (nobody, a timeout, `{error}`) turns it on. A restored workflow flow wins; otherwise relay wins over workflow's `startPhase`. `/relay on` asks again and refuses while workflow claims.
- **Job-set sessions.** A session whose cwd is inside a `.pi-set.json` folder named like a job set (`r1a2b3c`, `r1a2b3c-f1`) (a worker, a `/wt open` takeover) never claims and keeps lead mode off: no edit budget, no "go" hook, no dispatch.

## Parallel and stacked jobs, add-repo, widget and log

**Queue.** `maxJobs` (3) jobs run at once; the rest are `queued` and start in creation order when a slot frees (a worker slot is held only by a job that started). Two jobs whose `Files` (or the paths named in backticks in Design) overlap, in a repo with the same name, get a notice and an `overlap` log entry each at dispatch; relay does not serialise them.

**Stacked jobs (D17).** `## Depends on` names a job id of this repo. The dependent stays `queued` (holding no slot) until its predecessor is `done`, or `delivering` with every repo pushed; its set starts at the head of the predecessor's pushed branch (`origin/<remoteBranch>`), its judge diff is `base..HEAD` of its own work, and its PR is opened against the predecessor's branch and is not merged. A predecessor that already merged means a plain job on the target. Once the predecessor merged (the PR-only scan sets `merged`, or an after-pass delivery did), the dependent is delivered again: `git rebase --onto origin/<target> <predecessor head>` (this also drops a squash-merged predecessor), the D14 rules (overlap, Verify, `passedViaRebase`), `gh pr edit --base <target>`, then a push with the lease against `remotePushed`. If the predecessor stops or fails, its dependents stop with that reason. An unknown predecessor is refused at dispatch.

**Add a repo.** `relay_add_repo {job, folder, target, askId?}` emits W3: a worktree of `folder` joins the job's set on `origin/<target>`; the repo is added to the job (judge diff, delivery, guard paths), the worker is told with a steer and, with `askId`, its ask is answered. Only a working or paused job.

**Widget and log.** A widget under the editor shows one line per unfinished job: id, state, round (`e` once escalated), wall minutes used/budget, tokens used. `/relay log <job> [n]` shows the last n lines of `log.jsonl` (tool names with a short first argument, verdicts, amendments, approvals, overlaps, restacks) and the job's paths.

## Events

All payloads are `v: 1`. Fields marked optional are additive.

**Emitted**

- `relay:job-start {v, job, title, repos, tag?}`
- `relay:job-progress {v, job, tag?, state, round, used: {tokens, wallMs}}`: emitted whenever a job is saved with a `(state, round)` different from the last one emitted for it, never before that job's `relay:job-start`. Order per job: `job-start` -> `job-progress`* -> `job-end`. A follow-up is its own cycle: it emits `job-start` again when its worker starts, then progress, then `job-end`. A job adopted or restacked by a new lead already had its `job-start`, so it emits progress and `job-end` only.
- `relay:job-end {v, job, how: "delivered"|"stopped"|"failed", report, tag?, used?: {tokens, wallMs}, repos?: [{key, pr?, merged}], reason?}`: `used.tokens` is weighted, as in job.json; `reason` is the job's `endReason` (e.g. `budget: ...`, `stopped by the lead`) when it has one.
- `relay:approval {v, job, category, item, by: "brief"|"lead", reason, tag?}`

**The tag.** `tag: {run, package}` is given at `relay:dispatch`, stored in job.json and echoed in the events above. Every wake text of a tagged job starts with `[<package>] `.

**Contracts relay answers** (claim pattern, `shared/claims.ts`: the listener calls `claim(promise)` synchronously; the answer is `{error}` on refusal). Relay unsubscribes them at `session_shutdown`.

- `relay:dispatch {v:1, brief, size?, tag?: {run, package}, claim}` -> `{id, queued}` or `{error}`. Dispatches exactly like `relay_dispatch`. Answers `{error}` in a job-set session, in a relay worker/reviewer, outside a git repo, when lead mode is refused (K16) and before the first `session_start` (no session context).
- `relay:control {v:1, job, action: "stop"|"followup", text?, claim}` -> `{ok: true, job, n?, queued?}` or `{error}`. Runs the same code as `relay_stop` / `relay_followup`; `n` and `queued` come with a follow-up (the job id stays the same); `followup` requires `text`.
- `relay:job-query {v:1, ids: string[], claim}` -> `{jobs: [{id, state, tag?, used: {tokens, wallMs}, repos: [{key, pr?, merged}], report?, reason?}]}` or `{error}` (no session context, or not a git repo). Jobs are found in memory or in their job.json (earlier sessions and adopted jobs included); an id neither knows has `state: "unknown"`. `report` is the report.md path when it exists (the same value as `relay:job-end.report`); `reason` is the job's `endReason`. Lead mode is not needed; an engine is started if there is none.
- `relay:hosted {v:1, on: boolean, claim?}`: hosted mode for a session an orchestrator drives. While on, relay decides lead mode at once (engine, wakes and K16 ready), the typed "go" hook passes input through and the lead prompt section is not added; tools, engine, wakes, adoption and the edit budget keep working. Off restores the prompt section and the "go" hook. With a `claim` the answer is `{on, mode: "on"|"off", reason?}` (e.g. workflow owns the session). Before the first `session_start` the flag is set, the answer is `{on, mode: "off", reason: "no session context"}` and lead mode is decided at `session_start`.

## Tools and commands

`relay_critic {brief, draft?}`, `relay_dispatch {brief, size?, draft?, overrides?}`, `relay_status {job?}`, `relay_approve {job, askId, approve, reason}`, `relay_stop {job}`, `relay_deliver {job}`, `relay_send {job, text, mode, reset?, from?}`, `relay_replan {job, brief}`, `relay_resume {job}`, `relay_followup {job, text}`, `relay_add_repo {job, folder, target, askId?}`. Commands: `/relay` (status), `/relay on|off` (off is refused while this lead owns running jobs), `/relay go`, `/relay stop <job>`, `/relay pause <job>`, `/relay resume <job>`, `/relay followup <job> <text>`, `/relay log <job> [n]`, `/relay model <role> <spec>`.

## Copies from workflow

`subagent.ts`, `mcp-forward.ts`, `repo-diff.ts`, `merge-gate.ts` and `push-guard.ts` are copies with their tests, adapted: `subagent.ts` starts `--mode json -p --no-session -ne -ns -np` plus `-a`/`-na` from the lead's trust and spawns through `pi-bin.ts`; `merge-gate.ts` drops `midFlowMergeProblem`; `push-guard.ts` gains the `lease` option; `mcp-forward.ts` reads `PI_RELAY_MCP`. `knowledge.ts` and `folders.ts` are small copies of the agents and orchestrate helpers.

## Tests

`node --experimental-strip-types --test *.test.ts` in this folder (about 2 min; `running.test.ts` covers the running-job behaviour with a fake clock where time matters; `stage4.test.ts` the queue, stacked jobs with a faked `gh`, add-repo, widget and log). The engine tests use `RELAY_PI_BIN=test/fake-pi.mjs`, one scripted file that serves the RPC worker and the json-mode critic and judge (it switches on `--mode`), with real git repos and bare remotes. `e2e/live.mjs` runs the whole thing with real models (15-25 min): `node pi/agent/extensions/relay/e2e/live.mjs`.

## Limits

- The judge rechecks the whole diff each round (plus the previous findings), not only the delta.
- Closing the lead session kills its workers; the jobs stay on disk and the next lead session adopts them (after 2 min if the pid is alive, at once if the pid is dead or the session is the same). Killing a surviving worker by pid assumes the pid was not reused.
- A restart or follow-up critic check costs one model run; a critic failure twice refuses the change rather than skipping the check.
- Escalation switches the model with `set_model`; the thinking level of the escalate role is not applied to a running worker.
- File locks are reliable on one host only; about 10 workers at once at roughly 300 MB per process; a diff larger than `judge.maxDiffChars` gives the judge the file list plus the diffs that fit.
- Stacking needs GitHub: the predecessor counts as merged when its PR is `MERGED` (the PR-only scan) or relay merged it; without a PR a stacked job stays stacked.
- A stacked job assumes the predecessor's branch is not rewritten after the dependent started; if it is, the plain rebase onto it can conflict and becomes a fix round. Overlap detection is by file names and globs only, per repo name.
- Bash is not blocked against the edit budget up front.
