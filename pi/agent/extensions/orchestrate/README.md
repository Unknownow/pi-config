# orchestrate

One orchestrator session splits a job into 2-4 work packages and runs each as a workflow sub-session in its own `wt` worktree (visible terminal). Each sub-session starts at the **plan** phase from a brief (no discuss). The orchestrator reviews the plans, watches progress and owned paths through git, answers questions, and accepts each result before the sub-session merges its own PR.

## Usage

1. Start pi with the workflow **off** (`startPhase: "off"` in `workflow.json`) in the repo, and discuss the job with the agent.
2. The agent calls `orch_run` (packages: `id`, `goal`, `criteria`, `owns`, `forbids`, `dependsOn`, `decisions`) and then `orch_spawn` for the packages whose dependencies are merged (at most `maxSubs` run at once).
3. Messages arrive from the watcher (no model tokens while nothing happens): `question`, `plan-review`, `accept-request`, `flow-ended`, `drift`, `overlap`, `offline`, `stalled`. The agent answers with `orch_send`, `orch_review_plan` (the user confirms approvals when `confirmPlans` is on) and `orch_accept` (it refuses when the tree changed since the request).
4. `/orch status | watch | end`. `watch` resumes watching after a restart (it takes over from a dead owner). A crashed sub-session is only reported; reopen it with `/wt open <name>`.

Tools: `orch_run`, `orch_spawn`, `orch_status`, `orch_send`, `orch_review_plan`, `orch_accept`; in sub-sessions also `ask_orchestrator`.

## Files

Under `<git common dir>/pi/orchestra/<runId>/` (single writer per file; messages are append-only JSON lines, a last line without newline is ignored until complete):

```
run.json                  orchestrator (tmp + rename)
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

`~/.pi/agent/orchestrate.json` (optional): `{ "maxSubs": 4, "pollSeconds": 60, "stallMinutes": 20, "askTimeoutMinutes": 15, "confirmPlans": true }`. A bad value falls back to the default with a warning.

## Contracts used

Only public events, never imports of `../workflow` or `../worktree` (`boundary.test.ts`): workflow K4 `workflow:status`, K9 `workflow:start-plan`, K10 `workflow:plan-ready`, K11 `workflow:merge-gate` (see `workflow/README.md`); worktree W1 `worktree:create` (see `worktree/README.md`); claims through `../shared/claims.ts`.

A sub-session is recognised at `session_start` by its git top level matching the `cwd` of a sub in an active run. A merge is refused until the orchestrator accepted the same tree the judge passed. Limit: a `git_task` merge asks K11 once before its subagent starts, so accept first, then call it.

## Unity

Each worktree is its own Unity project; its first open imports every asset (slow). Backlog idea A42 (copy `Library/`).

## Tests

`cd pi/agent/extensions/orchestrate && node --experimental-strip-types --test config.test.ts paths.test.ts brief.test.ts store.test.ts monitor.test.ts boundary.test.ts`

`index.ts` needs the pi runtime and has no unit test; the end-to-end check is manual (scratch GitHub repo: two packages `a`, `b` depending on `a`).
