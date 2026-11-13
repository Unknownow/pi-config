# orchestrate

One orchestrator session splits a job into 2-4 work packages and runs each as a workflow sub-session in its own `wt` worktree (visible terminal). Each sub-session starts at the **plan** phase from a brief (no discuss). The orchestrator reviews the plans, watches progress and owned paths through git, answers questions, and accepts each result before the sub-session merges its own PR.

## Usage

1. Start pi with the workflow **off** (`startPhase: "off"` in `workflow.json`) in the repo and type `/orch` (or `/orch start [title]`). This is **orchestrator mode**, like `/flow`: a read-only discussion. The agent ends its replies with an `Agreed so far:` list.
   - A typed "go" (the `approvePattern`) moves to the **proposal**: the agent writes `## Packages: <title>`, still read-only. Other typed text revises it.
   - A second "go" on a finished proposal (a reply with a `## Packages` heading that does not end on a question) moves to **run** and unlocks `orch_run` and `orch_spawn`.
   - The guard is code, in every mode but off: `shared/readonly-tools.ts` refuses changing tools, writing bash commands and PowerShell, and `orch_run`/`orch_spawn` before run. The orchestrator stays read-only during the run too (`orch_status`, `orch_send`, `orch_review_plan`, `orch_accept` stay allowed). `/orch off` (or `/orch end`) lifts the guard. `/orch start` is refused while the workflow phase is not `off` or while a run is active in the repo. The mode is saved in the session (`orchestrate-mode` entry); `/orch watch` sets run.
2. The agent calls `orch_run` (packages: `id`, `goal`, `criteria`, `owns`, `forbids`, `dependsOn`, `decisions`) and then `orch_spawn` for the packages whose dependencies are merged (at most `maxSubs` run at once).
3. Messages arrive from the watcher (no model tokens while nothing happens): `question`, `ask` (a workflow menu or wait), `idle`, `plan-review`, `accept-request`, `flow-ended`, `drift`, `overlap`, `offline`, `stalled`. The agent answers with `orch_send`, `orch_decide` (workflow menus), `orch_escalate` (what needs the user), `orch_review_plan` (the orchestrator reviews plans itself; the user confirms approvals only when `confirmPlans` is set to `true`) and `orch_accept` (it refuses when the tree changed since the request).
4. `/orch start [title] | off | status | board | watch | merged <id> | end`. `merged` checks a PR merge with gh now; the watcher also retries it on every poll after a flow ended, so a failed gh call or a PR merged by hand still ends as `merged`. `watch` resumes watching after a restart (it takes over from a dead owner). A crashed sub-session is only reported; reopen it with `/wt open <name>`.

### Visualizer

- **Widget** in the orchestrator session (key `orchestrate`): one line `orch ▸ discuss` or `▸ propose` while discussing; during a run a header (`orch <runId> ▸ run  n/maxSubs running`) and one row per package: id, repos, state, phase and done/total, pending markers (`? question`, `plan n review`, `⚠ accept <repo> <tree7>`), changed files per repo, `drift`, `overlap`, `offline`, `stalled` and `(after a,b)` for packages not started. It is removed when the mode is off and no run is watched.
- **`view.json`** is written by the watcher (its only writer, tmp + rename) after each outbox read and git poll, only when its content changed. It holds per package the state, phase, steps, heartbeat, per-repo file counts, drift and last PR state (from the merge check), overlaps, pending items (a question until its answer, plan n until its verdict, an accept-request until a verdict with the same tree and repo) and the last 5 messages each way.
- **`/orch board`** (any session of the repo with an active run) opens an overlay that re-reads `view.json` every 2 s: list on the left, details of the selected package on the right (goal, criteria, owns, files and PR per repo, pending, accepted trees, recent messages). Keys: up/down, enter for details only, esc. Without a TUI it prints the board with `notify`. A missing `view.json` is an error; a corrupt one is reported and the last good view stays.
- **Sub-session status line** (`orch <runId>/<subId>`): adds ` · waiting for orchestrator: plan review | answer | decision | acceptance` while a plan is under review, an `ask_orchestrator` question is open or an accept-request has no verdict.

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

Tools: `orch_run`, `orch_spawn`, `orch_status`, `orch_send`, `orch_review_plan`, `orch_accept`, `orch_decide`, `orch_escalate`; in sub-sessions also `ask_orchestrator`.

### Spawning and trust

- **`spawning` state.** `orch_spawn` writes `state: "spawning"` and `spawningAt` to `run.json` before it asks the worktree extension for the worktree (W1), then `spawned` (the mark is removed). On a failure the package goes back to `planned`. `spawning` counts toward `maxSubs` and shows as `spawning`. A package stuck in `spawning` (no `spawningAt`, older than 3 min, or its owner is dead) is reset to `planned` by `/orch watch` and by the orchestrator's `session_start`, with the message "reset <id> to planned; if a worktree exists use /wt open or /wt remove".
- **Auto-trust.** `orch_run` stores `originTrusted` (`ctx.isProjectTrusted()`; temporary and CLI trust count) in `run.json`. The evidence for trust is a **per-user registry**, `~/.pi/agent/orchestrate-spawned.json` (entries `{ runId, common, sub, state: spawning|spawned, at, tops }`), outside every repository. Only `orch_spawn` of a run with `originTrusted: true` writes it: a `spawning` entry before W1, then `spawned` with the worktree roots of the package, and the entry is removed when W1 fails, a stuck `spawning` package is reset, the package is merged or the run ends. A repository can ship any `run.json`, so `run.json` alone never trusts anything. A `project_trust` handler answers `{ trusted: "yes", remember: false }` only when the registry has a `spawned` entry for this git common dir whose `tops` contain the git top level, the `cwd` is that top level or inside it, and `run.json` agrees (the run is active, `originTrusted`, and the package is spawned, planning, executing or awaiting-acceptance). While a fresh (under 3 min) `spawning` entry exists it re-reads the registry every 500 ms (15 s at most), because the new session asks before the worktree is registered. Otherwise it answers `undecided` and never prompts. `trust.json` is never written, so the trust ends with the process. A `/resume` into a sub worktree is the same match. Another user or CLI extension that answers yes or no first wins. Worktrees without `.pi` or `.agents/skills` never ask for trust. Runs from before this change have no `originTrusted` and no entry: the trust prompt is shown.
- **Identity and held claims.** A sub-session is found by its worktree in `run.json`, which may be written a few seconds after its terminal opens. Until the session knows what it is (`unknown`), the K10, K11, K12 and K13 claims are held. As a sub they are handled; as anything else (no UI, no git repo, no active run, the run owner or orchestrator mode, or no match after the 15 s retry) they resolve to `null`, so the workflow shows its local menu as before. K12 and K13 have no handler yet: they resolve to `null`. Held claims also resolve at `session_shutdown` and when the run has ended.
- **`ask_orchestrator` has no timeout** and never falls back to `wait_for_user`. It ends on an answer, on an abort (the question stays open; a late answer arrives as a message) or when the run has ended (then it answers "the run ended; finish what you can without this answer").

### Decisions and escalation

A sub-session never shows a menu, a wait or an input-asking notice in its window: everything goes to the orchestrator, and only what it cannot or may not decide reaches the user, in the orchestrator session.

- **Items.** The watcher turns each outbox message of type `question`, `ask` (workflow K12: a menu with its `key`, options and `roles`, or a wait), `idle`, `plan-review` and `accept-request` into an item in `items.json` (the orchestrator session is its only writer; refs: message id, askId, `plan-<n>`, `accept-<repo>-<tree>`). States: open, escalated, answered, stale. `ask-done` closes its item; `idle-end` closes the idle item; a new accept-request of the same repo makes the older one stale. An older run has no `items.json`: it is read as empty. An unreadable file is reported once, kept as `items.json.corrupt`, and replaced by an empty one.
- **`orch_decide {id, askId, choice?, resume?, text?, userQuote?}`** answers a menu or wait. Refused: a choice that is not in the options; in `plan-menu` the roles `approve` (approve plans with `orch_review_plan`) and `discuss`; "Wait" in `stage-empty` and `steps-open` without `text`; every `stop` option without a valid `userQuote`; a `replan` ("Back to planning") over `maxReplans` without a quote; a wait's `resume` without a quote. A refused capped choice (Stop, the replan over the cap) escalates the item by itself. `text` reaches the sub-session after the choice is applied. Stale, answered and unknown items are refused.
- **`orch_escalate {id, ref, question}`** sends an open item to the user. **Escalation** also happens by timing and caps (below): a desktop notification, a `‼ you` marker in the widget and board, "n waiting for you" in the header, and a follow-up message that tells the orchestrator to show the item to the user.
- **`userQuote`.** The answer to an escalated item, by any tool (`orch_decide`, `orch_send` with `replyTo`, `orch_review_plan`, `orch_accept`), needs an exact piece (at least 8 characters, or the whole message when it is shorter) of a message the user typed in the orchestrator session after the escalation (typed text is recorded on every escalated item; messages starting with `/` and extension messages are not). The answer is saved `byUser`. This is best effort: it checks the orchestrator relays the user, it does not authenticate the user. **Waits** always need a person: they are escalated at once, and only a quote resumes one (a passing `check` still resumes it by itself).
- **Timing.** The orchestrator is reminded at 60 s, 5 min and 10 min of its own idle time (time while it works does not count) with "Still open: …". An item is escalated at 15 min of orchestrator idle time or 30 min after it was posted, whichever comes first. After a restart (`/orch watch`) the saved idle time continues and an item past its limit is escalated on the first tick.
- **Caps** (`orchestrate.json`; the answer of the user resets the count of that cap, except `maxReplans`):
  - `maxPlanRejections` (3): consecutive rejections in one planning round; the review right after the cap is escalated. An approval resets it.
  - `maxReplans` (2 per package and run): counts the orchestrator's "Back to planning" answers; it never resets and every later one needs a quote.
  - `maxAutoAnswers` (2 per package and key): the 3rd ask is escalated. The loop keys `judge-cap`, `plan-flaw`, `accept` (refusals) and `merge-early` reset only when the stage changes; without stages (an unstaged plan) they count per run, and a plan approval does not reset them. Other keys count consecutive asks and reset when the package made progress (phase, stage, steps, HEAD or working tree changed). `plan-menu` also resets when a plan reaches review.
  - `maxIdleAnswers` (3 per package): idle reports without progress; the 4th is escalated.
- **`idle` and `idle-end`.** The sub-session claims the workflow's idle notice (K13) and, 20 s later, posts an `idle` report with its last message, unless it started working again, waits on a plan review, an ask, a question or an accept request, or is not spawned, planning or executing. `agent_start` posts `idle-end`. Any `orch_send` to the package closes its open idle item. An open item suppresses the `stalled` event of that package.
- **Stale items and restarts.** A sub-session posts `session-started {instance}` when it starts. A new instance makes the open menu and plan-review items of earlier instances stale (the workflow withdraws a saved menu ask at restart; a wait is re-sent with the same id); the orchestrator is told to send the package a directive to continue.
- **Orchestrator not running.** When an item of a sub-session (question, plan review, ask, accept request) has waited over 30 min, the run owner is on the same host and its pid is dead, the sub-session shows one desktop notification per item: "orchestrator not running: open it and run /orch watch". A sub-session shows nothing else.

## Files

Under `<git common dir>/pi/orchestra/<runId>/` (single writer per file; messages are append-only JSON lines, a last line without newline is ignored until complete):

```
run.json                  orchestrator (tmp + rename)
view.json                 orchestrator's watcher (tmp + rename; the run as data for the widget and /orch board)
<sub>/brief.md            orchestrator
<sub>/status.json         sub-session (K4 events and a 60 s heartbeat)
items.json               orchestrator (tmp + rename; what the sub-sessions wait on, and the caps' counters; a missing file is empty)
<sub>/outbox.jsonl        sub-session -> orchestrator: question, ask, ask-done, idle, idle-end, session-started, plan-review, accept-request, flow-ended, note
<sub>/inbox.jsonl         orchestrator -> sub-session: answer, decision, plan-verdict, accept-verdict, directive, info
<sub>/accepted.json       orchestrator: accepted trees
<sub>/plan-<n>.md         sub-session: plan text for review
<sub>/inbox.read, outbox.read   cursors (line counts), owned by the reader
```

Ids: `runId` = `o<MMDDHHmm>-<title slug>` (30 characters at most); set name `o<MMDDHHmm>-<sub>`, branch `wt/<name>`.

## Config

`~/.pi/agent/orchestrate.json` (optional): `{ "maxSubs": 4, "pollSeconds": 60, "stallMinutes": 20, "confirmPlans": false, "maxPlanRejections": 3, "maxReplans": 2, "maxAutoAnswers": 2, "maxIdleAnswers": 3, "approvePattern": "..." }`. `approvePattern` is the regex (case-insensitive) for the typed "go"; its default is a copy of the workflow's. A bad value falls back to the default with a warning.

## Contracts used

Only public events, never imports of `../workflow` or `../worktree` (`boundary.test.ts`): workflow K4 `workflow:status`, K9 `workflow:start-plan`, K10 `workflow:plan-ready`, K11 `workflow:merge-gate`, K12 `workflow:ask` and `workflow:ask-done`, K13 `workflow:idle` (see `workflow/README.md`); worktree W1 `worktree:create` (see `worktree/README.md`); claims through `../shared/claims.ts`.

Worktree W1 is used with its optional `folders` payload field and the `repos` answer field (both optional; the version stays 1). A sub-session is recognised at `session_start` by its git top level matching the `cwd` of a sub in an active run. `orch_review_plan` needs the plan number `n` from the `plan-review` message; a verdict counts only for that plan. A merge is refused until the orchestrator accepted the same tree the judge passed. Acceptance needs both `accepted.json` and an `accept-verdict` message naming the tree; the files are plain, so this is trust-based against a hostile sub-session agent. Drift is computed against the merge base with `origin/HEAD` on every poll. Limit: a `git_task` merge asks K11 once before its subagent starts, so accept first, then call it.

## Unity

Each worktree is its own Unity project; its first open imports every asset (slow). Backlog idea A42 (copy `Library/`).

## Tests

`cd pi/agent/extensions/orchestrate && node --experimental-strip-types --test config.test.ts paths.test.ts brief.test.ts store.test.ts monitor.test.ts inbox.test.ts boundary.test.ts mode.test.ts repos.test.ts folders.test.ts view.test.ts trust.test.ts identity.test.ts items.test.ts decide.test.ts`

`index.ts` needs the pi runtime and has no unit test; the end-to-end check is manual (scratch GitHub repo: two packages `a`, `b` depending on `a`).
