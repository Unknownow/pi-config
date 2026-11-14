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
| escalate | A stronger model that takes over the worker (stage 3). |

## The flow

1. You discuss with the lead. When you say "go" (typed, or `/relay go`), the lead writes the brief, runs `relay_critic` (revising up to 3 rounds), and `relay_dispatch`es it.
2. Dispatch: validate, assign a job id (`r` + 6 base36 characters), write `brief.md` and `job.json`, take the job lock, snapshot your uncommitted edits, create the set (W1 with `launch: "none"`), cherry-pick the snapshot as the job's first commit ("relay: lead edits"), revert your checkout, start the worker.
3. The worker works, asks (`ask_lead`) when it must, and finishes with `report_done`. The judge reviews `base..HEAD`. FAIL: the worker gets the findings (one notice, the lead is not woken). PASS: the lead is woken and delivery starts. At the judge cap (`caps.judge`, 3) the job stops and is reported.
4. Delivery rebases onto `origin/<target>` per repo, pushes, opens the PR (with GitHub), and merges within Authority.
5. `report.md` is written; the lead gets 3 lines and the path; `relay:job-end` is emitted; the worker exits; the set is removed if everything merged.

The lead is woken (a turn starts) only for: a worker question or approval request, the judge cap, a `[plan]` finding, a worker crash, PASS, and the final report.

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

Lock files `owner.<n>.lock` hold `{pid, sessionId, host, heartbeat}`. `acquire` creates `owner.1.lock` with `O_EXCL`. `takeOver` (adoption comes in stage 3) reads the highest generation, requires it to be stale (heartbeat older than 2 min, or the pid dead on this host; an unreadable file only by mtime), creates `owner.<n+1>.lock` through a hard link (so it fails on `EEXIST`), runs `isOwner()` again, and only then deletes lower generations; if the recheck fails it deletes its own file and reports failure. `isOwner()` needs the highest generation and the lead's `sessionId`, `pid` and `host`. The heartbeat (every 30 s) writes a temp file and renames it over the lock, with 5 retries on `EPERM`/`EBUSY`/`EACCES` (50 to 800 ms backoff); if all fail it counts as not written, and the lead loses the job only when a later `isOwner()` fails. File locks are reliable on one host only.

## Delivery and the push rule

Per repo, in Targets order: `git fetch`, then `git rebase origin/<target>`. A clean rebase with no overlap between the upstream changes and the job's files, and a passing Verify, is `passedViaRebase`. A conflict, an overlap or a failing Verify is a fix round (the rebase is aborted on a conflict) followed by a judge. A multi-repo job pushes and merges only when every repo is accepted.

- **First push:** `git push origin HEAD:<remoteBranch>`; the branch must not exist on origin (otherwise delivery stops and the lead is woken). `remoteBranch` is set to the branch name at this push.
- **Later pushes** (after a delivery rebase): `git push --force-with-lease=<remoteBranch>:<remotePushed> origin HEAD:<remoteBranch>`, only on the job's own branch, never the target or a protected branch. After each push `remotePushed` is the sha pushed. A lease failure means someone else pushed (for example you after `/wt open`): delivery stops, the lead is woken, nothing is overwritten.
- `push-guard.ts` (copy) lets these pushes through only when the delivery step passes a `lease`; the worker guard refuses every push.
- With GitHub (`gh repo view` works) a PR is created when none is open. **Merge** when Authority `merge` is yes (or approved), or when the repo's `merge` is `after-pass` and Authority is not `no`: `gateCheck` on the accepted tree, then `gh pr merge --squash --match-head-commit <sha>`; without GitHub a fast-forward `git push origin <sha>:<target>` (if the target moved, rebase again, up to 3 times). Otherwise (`pr-only`) the set is kept until the PR merges (the PR-only cleanup that removes it later is stage 3).
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
| `defaultMerge` | `"pr-only"` |
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

## Events

`v: 1` on all: `relay:job-start {v, job, title, repos}`, `relay:job-end {v, job, how: "delivered"|"stopped"|"failed", report}`, `relay:approval {v, job, category, item, by: "brief"|"lead", reason}`.

## Tools and commands

`relay_critic {brief, draft?}`, `relay_dispatch {brief, size?, draft?, overrides?}`, `relay_status {job?}`, `relay_approve {job, askId, approve, reason}`, `relay_stop {job}`, `relay_deliver {job}`. Commands: `/relay` (status), `/relay on|off` (off is refused while this lead owns running jobs), `/relay go`, `/relay stop <job>`, `/relay model <role> <spec>`.

## Copies from workflow

`subagent.ts`, `mcp-forward.ts`, `repo-diff.ts`, `merge-gate.ts` and `push-guard.ts` are copies with their tests, adapted: `subagent.ts` starts `--mode json -p --no-session -ne -ns -np` plus `-a`/`-na` from the lead's trust and spawns through `pi-bin.ts`; `merge-gate.ts` drops `midFlowMergeProblem`; `push-guard.ts` gains the `lease` option; `mcp-forward.ts` reads `PI_RELAY_MCP`. `knowledge.ts` and `folders.ts` are small copies of the agents and orchestrate helpers.

## Tests

`node --experimental-strip-types --test *.test.ts` in this folder (about 35 s). The engine tests use `RELAY_PI_BIN=test/fake-pi.mjs`, one scripted file that serves the RPC worker and the json-mode critic and judge (it switches on `--mode`), with real git repos and bare remotes. `e2e/live.mjs` runs the whole thing with real models (15-25 min): `node pi/agent/extensions/relay/e2e/live.mjs`.

## Limits

- The judge rechecks the whole diff each round (plus the previous findings), not only the delta.
- A worker crash or stall fails the job in this stage (the restart with `-c`, stall detection, adoption of a job after a lead restart, mid-run input, follow-ups, parallel and stacked jobs, add-repo and the widget come in later stages). Closing the lead session kills its workers; the jobs stay on disk.
- File locks are reliable on one host only; about 10 workers at once at roughly 300 MB per process; a diff larger than `judge.maxDiffChars` gives the judge the file list plus the diffs that fit.
- Bash is not blocked against the edit budget up front.
