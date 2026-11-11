# orchestrate

One orchestrator session splits a job into 2-4 work packages and runs each as a workflow sub-session in its own `wt` worktree (visible terminal). Each sub-session starts at the **plan** phase from a brief (no discuss). The orchestrator reviews the plans, watches progress and owned paths through git, answers questions, and accepts each result before the sub-session merges its own PR.

## Usage

1. Start pi with the workflow **off** (`startPhase: "off"` in `workflow.json`) in the repo and type `/orch` (or `/orch start [title]`). This is **orchestrator mode**, like `/flow`: a read-only discussion. The agent ends its replies with an `Agreed so far:` list.
   - A typed "go" (the `approvePattern`) moves to the **proposal**: the agent writes `## Packages: <title>`, still read-only. Other typed text revises it.
   - A second "go" on a finished proposal (a reply with a `## Packages` heading that does not end on a question) moves to **run** and unlocks `orch_run` and `orch_spawn`.
   - The guard is code, in every mode but off: `shared/readonly-tools.ts` refuses changing tools, writing bash commands and PowerShell, and `orch_run`/`orch_spawn` before run. The orchestrator stays read-only during the run too (`orch_status`, `orch_send`, `orch_review_plan`, `orch_accept` stay allowed). `/orch off` (or `/orch end`) lifts the guard. `/orch start` is refused while the workflow phase is not `off` or while a run is active in the repo. The mode is saved in the session (`orchestrate-mode` entry); `/orch watch` sets run.
2. The agent calls `orch_run` (packages: `id`, `goal`, `criteria`, `owns`, `forbids`, `dependsOn`, `decisions`) and then `orch_spawn` for the packages whose dependencies are merged (at most `maxSubs` run at once).
3. Messages arrive from the watcher (no model tokens while nothing happens): `question`, `plan-review`, `accept-request`, `flow-ended`, `drift`, `overlap`, `offline`, `stalled`. The agent answers with `orch_send`, `orch_review_plan` (the user confirms approvals when `confirmPlans` is on) and `orch_accept` (it refuses when the tree changed since the request).
4. `/orch start [title] | off | status | board | watch | merged <id> | end`. `merged` checks a PR merge with gh now; the watcher also retries it on every poll after a flow ended, so a failed gh call or a PR merged by hand still ends as `merged`. `watch` resumes watching after a restart (it takes over from a dead owner). A crashed sub-session is only reported; reopen it with `/wt open <name>`.

### Visualizer

- **Widget** in the orchestrator session (key `orchestrate`): one line `orch ▸ discuss` or `▸ propose` while discussing; during a run a header (`orch <runId> ▸ run  n/maxSubs running`) and one row per package: id, repos, state, phase and done/total, pending markers (`? question`, `plan n review`, `⚠ accept <repo> <tree7>`), changed files per repo, `drift`, `overlap`, `offline`, `stalled` and `(after a,b)` for packages not started. It is removed when the mode is off and no run is watched.
- **`view.json`** is written by the watcher (its only writer, tmp + rename) after each outbox read and git poll, only when its content changed. It holds per package the state, phase, steps, heartbeat, per-repo file counts, drift and last PR state (from the merge check), overlaps, pending items (a question until its answer, plan n until its verdict, an accept-request until a verdict with the same tree and repo) and the last 5 messages each way.
- **`/orch board`** (any session of the repo with an active run) opens an overlay that re-reads `view.json` every 2 s: list on the left, details of the selected package on the right (goal, criteria, owns, files and PR per repo, pending, accepted trees, recent messages). Keys: up/down, enter for details only, esc. Without a TUI it prints the board with `notify`. A missing `view.json` is an error; a corrupt one is reported and the last good view stays.
- **Sub-session status line** (`orch <runId>/<subId>`): adds ` · waiting for orchestrator: plan review | answer | acceptance` while a plan is under review, an `ask_orchestrator` question is open or an accept-request has no verdict.

### Several repos

When the session has added repos with `/folders add`, one run can span them. `orch_run` takes the working repo (first) and the git repos of the added folders as the run's `repos`, each with a key: the lowercased folder name (characters outside `a-z0-9._-` become `-`; two repos with one key are an error naming both paths). The propose and run prompts list the keys.
- `owns` and `forbids` are `key:glob` (`web:src/**`); a glob with no key means the working repo. Duplicate owners are checked on the canonical form (`src/**` and `api:src/**` clash when api is the working repo). The optional `repos` field of a package lists extra repo keys it only reads. A run with no added git repos is a single-repo run: plain globs, no keys (a keyed glob is refused).
- `orch_spawn` sends W1 `folders`: only the added folders of the repos the package uses (and plain folders) go into its set, and the answer's `repos` (`{ top, cwd }`) become `Sub.worktrees`. An old worktree extension that answers without `repos` leaves only the working repo watched; the spawn line says so. A needed repo missing from the answer is a warning line.
- Drift and overlap use `key:path` files, so a file in another repo counts as drift. The diff base, the default-branch fallback and the gh call are per repo.
- **Acceptance is per repo**: the accept-request carries `{ tree, repo }`, `orch_accept` takes an optional `repo` (default: the repo of the latest request) and checks the tree of that repo's worktree; `accepted.json` stores `<key>:<tree>`; the verdict carries `repo`. A merge from a worktree that is not one of the package's is refused.
- **Merged** per repo: a repo is touched when its worktree has commits since its spawn base or is dirty; a package is merged when every touched repo has a merged PR for the branch. The report names the repos that miss one.
- **Other runs**: runs are not locked against each other. `orch_run` reads the active runs of the session's other repos and, when owned paths may overlap (same repo, nested literal folders), asks "Create anyway / Cancel" (a headless session creates the run and puts the overlaps into the result as a warning). A run found from one repo is checked against the new packages' paths in every repo of this session. Detection is one-sided: a run started from another repo that includes this one is not found from here.
- Limit: a repo added inside a sub-session with `/folders add` is not watched.
- Old runs (no `repos` in `run.json`) behave as before.

Tools: `orch_run`, `orch_spawn`, `orch_status`, `orch_send`, `orch_review_plan`, `orch_accept`; in sub-sessions also `ask_orchestrator`.

## Files

Under `<git common dir>/pi/orchestra/<runId>/` (single writer per file; messages are append-only JSON lines, a last line without newline is ignored until complete):

```
run.json                  orchestrator (tmp + rename)
view.json                 orchestrator's watcher (tmp + rename; the run as data for the widget and /orch board)
<sub>/brief.md            orchestrator
<sub>/status.json         sub-session (K4 events and a 60 s heartbeat)
<sub>/outbox.jsonl        sub-session -> orchestrator: question, plan-review, accept-request, flow-ended, note
<sub>/inbox.jsonl         orchestrator -> sub-session: answer, plan-verdict, accept-verdict, directive, info
<sub>/accepted.json       orchestrator: accepted trees
<sub>/plan-<n>.md         sub-session: plan text for review
<sub>/inbox.read, outbox.read   cursors (line counts), owned by the reader
```

Ids: `runId` = `o<MMDDHHmm>-<title slug>` (30 characters at most); set name `o<MMDDHHmm>-<sub>`, branch `wt/<name>`.

## Config

`~/.pi/agent/orchestrate.json` (optional): `{ "maxSubs": 4, "pollSeconds": 60, "stallMinutes": 20, "askTimeoutMinutes": 15, "confirmPlans": true, "approvePattern": "..." }`. `approvePattern` is the regex (case-insensitive) for the typed "go"; its default is a copy of the workflow's. A bad value falls back to the default with a warning.

## Contracts used

Only public events, never imports of `../workflow` or `../worktree` (`boundary.test.ts`): workflow K4 `workflow:status`, K9 `workflow:start-plan`, K10 `workflow:plan-ready`, K11 `workflow:merge-gate` (see `workflow/README.md`); worktree W1 `worktree:create` (see `worktree/README.md`); claims through `../shared/claims.ts`.

Worktree W1 is used with its optional `folders` payload field and the `repos` answer field (both optional; the version stays 1). A sub-session is recognised at `session_start` by its git top level matching the `cwd` of a sub in an active run. `orch_review_plan` needs the plan number `n` from the `plan-review` message; a verdict counts only for that plan. A merge is refused until the orchestrator accepted the same tree the judge passed. Acceptance needs both `accepted.json` and an `accept-verdict` message naming the tree; the files are plain, so this is trust-based against a hostile sub-session agent. Drift is computed against the merge base with `origin/HEAD` on every poll. Limit: a `git_task` merge asks K11 once before its subagent starts, so accept first, then call it.

## Unity

Each worktree is its own Unity project; its first open imports every asset (slow). Backlog idea A42 (copy `Library/`).

## Tests

`cd pi/agent/extensions/orchestrate && node --experimental-strip-types --test config.test.ts paths.test.ts brief.test.ts store.test.ts monitor.test.ts inbox.test.ts boundary.test.ts mode.test.ts repos.test.ts folders.test.ts view.test.ts`

`index.ts` needs the pi runtime and has no unit test; the end-to-end check is manual (scratch GitHub repo: two packages `a`, `b` depending on `a`).
