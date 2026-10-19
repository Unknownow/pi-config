# Workflow extension: improvement backlog

Reference list for `pi/agent/extensions/workflow/`. Goal: less time, fewer tokens, more parallelism.

Status: A2, A3, A5, A7, B1, B7, B9, C2, C3, C4, D2, D3, D4 and D5 are implemented; A1 is rejected; the rest are ideas only. Found by reading the code on 2026-10-16. Nothing was measured, so every benefit below is an estimate. Line numbers are from commit `3fdc69a` and will drift.

## Keeping this file current

- Any change to `pi/agent/extensions/workflow/` that implements, rejects or adds a backlog item updates, in the same commit: the item's row (a **Done:** or **Rejected:** note with the commit or file names), the Status line, and the item's row in the "Effect measurement" table.
- A new finding gets the next free ID in its section (A, B, C or D). Rows are never renumbered.
- Line numbers in rows point at the commit named in the Status line and will drift. Fix them only when a row is edited.

## How to read the ratings

- **Benefit**: expected gain (High / Medium / Low) on the axis shown: time (T), tokens (K), or both.
- **Effort**: S (under a day, one file), M (a few files plus tests), L (design change).
- **Risk**: chance that the change makes flows worse or breaks them.
  - **Low**: pure speed-up or cache, same results.
  - **Medium**: changes what a model sees or when a step runs; quality could shift, so keep it behind a config switch.
  - **High**: changes ordering, concurrency or git state; can lose work or give wrong results.
- **Check first**: what to measure or confirm before building it.

## Pipeline recap (for context)

Plan (Opus) -> approve -> execute (Sonnet) -> judge (Opus, separate `pi` process) -> commit (Sonnet low, subagent) -> next stage. Judge, knowledge pass, arbiter, commit, explore and advisor each run as a fresh `pi` child process (`subagent.ts:144-176`). Only `explore` runs in parallel (`index.ts:1418`, concurrency 8, max 8 queries).

## A. Time and parallelism

| # | Finding | Benefit | Effort | Risk | Check first |
|---|---------|---------|--------|------|-------------|
| A1 | `knowledgePass` (`index.ts:1266`) is a second judge-model run that starts after `judgeOnce` (`index.ts:1294`). Start both at once. **Rejected:** the knowledge pass runs only when the judge skipped its knowledge step and takes the judge's findings (`index.ts:1340-1343`); running it in parallel would add an Opus run to every review. | High (T) | S | Low. The two runs are independent reads; only cost is two concurrent Opus processes. | Confirm the knowledge pass does not depend on the judge result. |
| A2 | Per-repo reads in delivery run in sequential `for` loops (`index.ts:2516`, `2554-2576`, `2069`). Parallelize the read-only parts with `Promise.all`, as `snapshotRepos` already does (`index.ts:766`). **Done:** the read-only per-repo calls in `summarizeCommit`, `finishPassed` (`prepareDelivery`) and `deliverSelfCommit` (HEAD and tree reads) run in parallel; commit and push stay sequential (`index.ts`). | Medium (T), only for multi-repo flows | S | Low for reads. Keep commit and push sequential: a failed push mid-way is easier to reason about in order. | Count how many flows actually use more than one repo. |
| A3 | `collectRepoDiff` runs 4-5 git calls per repo (`index.ts:586-619`): `diff`, `diff --name-only`, `ls-files` twice. One `diff --name-status` and one `ls-files --full-name` would do. **Done:** `collectRepoDiff` moved to `repo-diff.ts`; its independent git calls run in parallel; output is byte-identical (tested against the old algorithm). | Medium (T) | S | Low. Same output, fewer calls. Cover with a test that compares old and new output on a fixture repo. | Time the diff collection on a large repo. |
| A4 | The flow diff is rebuilt on every `reviewDiff` entry (`index.ts:2161`), in the `judge` tool (`index.ts:1537`) and in the pending plan-flaw path (`index.ts:1973`). The "same as last time" check only runs after the full diff is built and hashed (`index.ts:811-815`). Cache the result keyed by (HEAD, tree id) from `snapshotRepos`, which is cheaper than a full diff. | Medium (T) | M | Medium. A stale cache would make the judge review old code. The key must include every repo's HEAD, tree id and base. | Check how often the same state is reviewed twice. |
| A5 | Start the judge while cheap guard checks (branch, HEAD moved) run, instead of before them. **Done**, as "run the independent git calls before the judge in parallel" (`snapshotRepos`, `reviewPlan`); no guard checks exist to overlap. | Low (T) | S | Low. | Not verified that these checks are on the critical path. |
| A6 | Run independent plan steps in separate executor subagents at the same time. | High (T), only for plans with independent steps | L | High. Needs file-overlap detection, a merge story and per-step judging. Concurrent edits to the same file lose work. | Count how often steps are independent. Probably start with stages, not steps. |
| A7 | Explore: 8 queries at concurrency 4 run as two waves (`config.ts:184`). Raise concurrency to 8. **Done:** `explore.concurrency` is 8 in `config.ts` and `pi/agent/workflow.json`. | Low (T) | S | Low for correctness. Costs more simultaneous processes and may hit API rate limits. | Measure child-process boot time first (see A9). |
| A8 | Prefetch the next stage's repo reads while the current stage's commit runs. | Low (T) | M | Medium. State may change after the commit. | Not worth it unless stages are long. |
| A9 | Each subagent is a full `pi` process that loads `pi-claude-bridge` (`config.ts:203`, `subagent.ts:140-210`) and writes its system prompts to temp files every run (`subagent.ts:145-161`). Measure boot time; skip unneeded extensions for read-only roles, and cache the static prompt files. | Medium (T) if boot is more than 1-2 s | M | Medium. A role without the bridge may lose its model access if the bridge provides the model. | Measure process boot time per role. |

## B. Tokens

| # | Finding | Benefit | Effort | Risk | Check first |
|---|---------|---------|--------|------|-------------|
| B1 | A PASS on a re-review over 80k characters triggers a second full review (`index.ts:822-827`, `config.ts:189-193`). Skip it, or run it only when the delta touched files the earlier findings were not about. **Done:** `uncitedFiles` in `repo-diff.ts`, gated by `judge.finalFullReviewNewFilesOnly` (default true; false restores the old behaviour) in `index.ts`. | High (K, T) | S | Medium. Removes a safety net that catches drift across rounds. Keep it behind a config switch and compare a few flows. | Count how often the final full review finds something the delta review did not. |
| B2 | The plan (up to 60k chars, `index.ts:185`) and the full diff are re-sent to the judge, the knowledge pass (`index.ts:1270`) and the arbiter (`index.ts:2346`). Merge the knowledge pass into the judge prompt as an extra output section. Give the arbiter only the flagged findings and the files they cite. | High (K) | M | Medium. A combined prompt can lower the quality of each part. The arbiter sees less context. | Compare knowledge-pass output quality when merged. |
| B3 | The advisor receives the whole branch transcript, up to 1.5M characters, on every call (`index.ts:718-732`, `1484-1510`, `config.ts:185`). Cap at a few hundred thousand, or send the plan card plus the last N turns and the error context. | High (K) | S | Medium. The advisor may miss an earlier decision. Keep the cap configurable. | Check the sizes of real advisor transcripts. |
| B4 | The judge has the `read` tool with no limit (`index.ts:1322-1330`). Cap the number or total size of reads per run. | Medium (K) | S | Medium. A cap can stop the judge from checking a callee outside the diff. | Count how many reads judges do per run. |
| B5 | `contextGuardTokens` is 140k (`config.ts:160`) while handovers compact at 30k (`config.ts:161`). Lower the guard to about 80-100k so long executions compact before they get expensive. | Medium (K) | S | Medium. Each compaction is a summary call and loses detail; the plan card is re-sent after it (`index.ts:1790`). | Look at typical execute context sizes. |
| B6 | Nearly every handover compacts, because 30k is low (`agent-end.ts:98-101`). Each compaction is a full-context summary call. Raise the threshold, or skip compaction when the next phase starts a fresh process anyway. | Medium (K, T) | S | Medium. A larger context carries more history into the next phase. | Count how many handovers compact per flow. |
| B7 | The plan card carries the full plan when no plan file exists (`plan-doc.ts:96-115`). Always write a plan file so the card stays short. **Done:** after a handover the plan card waits up to 10 s for the plan file, so it names the file instead of carrying the plan. | Low-Medium (K) | S | Low. | Check when the no-file case happens. |
| B8 | Per-turn phase prompts (`index.ts:1586-1589`) are rebuilt each run. The code does not accumulate them, so this is not a growth bug. Shortening `EXECUTE_PHASE` and the plan prompts still saves tokens on every turn. | Low-Medium (K) | S | Medium. Prompt wording affects executor behavior; test on a few flows. | Count the prompt characters (not done). |
| B9 | `BATCH` and `PLAN_BATCH` in `prompts.ts:7-9` are near-duplicate text. **Done:** one `batchLine` in `prompts.ts`; prompt texts unchanged (`prompts.test.ts`). | Low (K) | S | Low. | None. |
| B10 | The commit step is a full Sonnet-low subagent with a bash tool (`index.ts:2640-2646`, `config.ts:156`). A scripted commit (stage the reviewed files, commit with a generated subject) needs no model for the common case. | Medium (K, T) | M | Medium. Commit messages get worse unless the plan's section 9 supplies the subject. Keep the model path for odd cases. | Check what the commit agent does beyond `git add` and `git commit`. |
| B11 | Use a cheaper model for the commit role (Haiku). | Low (K) | S | Medium-High. Weaker at git edge cases and hook failures; unmeasured. | None; probably not worth it, B10 is better. |

## C. Repeated work and caching

| # | Finding | Benefit | Effort | Risk | Check first |
|---|---------|---------|--------|------|-------------|
| C1 | `snapshotTree` runs `rev-parse --git-path` and `git add -A` over the whole tree per judge, per repo (`index.ts:742-762`). Reuse a persistent temp index so `add -A` only scans changes. | Medium (T) on big repos | M | Medium. A stale index gives a wrong snapshot. | Time the snapshot on the largest repo. |
| C2 | `loadConfig` reads and parses `workflow.json` on every call (`config.ts:225-228`; callers at `index.ts:273`, `2701`, `2952`, `3004`). Cache by file mtime. **Done:** `loadConfig` caches by file mtime/ctime/size; `saveRole` invalidates. | Low (T) | S | Low. | None. |
| C3 | `statusAt` runs one `git show` per plan ref (`plan-store.ts:153-178`). Plan refs are immutable commits, so memoize by commit SHA. **Done:** `statusAt` caches the raw `status.json` text by commit SHA (successful reads only, cleared at 1000 entries); test in `plan-store.test.ts`. | Low-Medium (T) | S | Low. | Count plan refs in a typical repo. |
| C4 | `planHousekeeping` re-reads all local statuses and refs each time (`index.ts:1050-1056`, `plan-store.ts:33-49`). Cache between calls and invalidate on write. **Done**, cheap form: one `flowRepos` call per housekeeping and a `plansDir` cache; plan statuses are not cached. | Low (T) | S | Low-Medium. Stale status after an external change. | None. |
| C5 | A stage start clears `lastJudge` (`index.ts:2008`), so the next stage always gets a full review even when the diff is small. Acceptable, since stages are committed in between. | Low | - | - | Leave as is. |
| C6 | `MAX_RESUMES` is 2 and resets per prompt (`agent-end.ts:3`, `index.ts:1814`). Cheap. | None | - | - | Leave as is. |

## D. Robustness and maintainability

| # | Finding | Benefit | Effort | Risk | Check first |
|---|---------|---------|--------|------|-------------|
| D1 | `index.ts` is 3,016 lines with almost everything in one `workflow()` closure (`index.ts:272-3016`) and no `index.test.ts`. Extract `reviewDiff`, `finishPassed`, delivery and `resumeFlow` into modules with injected dependencies, as other files already do (17 modules have tests). | Medium (safer changes) | L | Medium. Large mechanical refactor; breakage risk without tests. Do it in small steps, each with tests, before items A4, B1 or B2. | None. |
| D2 | A subagent timeout of 15 minutes (`config.ts:204`) leaves a hung judge running a long time. Add a progress-based timeout (no output for N minutes). **Done:** `subagent.idleTimeoutMs` (default 5 min, 0 = off, paused while a tool runs); error `stalled: no output for Ns`. | Low-Medium (T) on failure only | S | Low-Medium. A slow but healthy judge could be killed. | Check how long real judges take. |
| D3 | Add timing and token logging per role per flow (judge, knowledge, commit, compaction, explore), written next to the plan. This gives the numbers for every "Check first" above. **Done:** `metrics.ts` writes `metrics.jsonl` next to the flow's `plan.md` (subagent, compaction and flow lines); local only. | High (enables the rest) | S-M | Low. | None. Do this first. |
| D4 | (Line numbers at `6df1ae0`.) The executor often skips `plan_check`, so the plan card stays at "0 of N done" although the work is finished. The only instruction is one bullet in the execute prompt (`prompts.ts:79`). Nothing reminds the executor later, and the judge treats ticks as claims (`index.ts:816`). **Done:** when `judge` runs in the execute phase with steps of the current stage unticked, its result ends with `Open steps not ticked: S2, S3. Tick the finished ones with plan_check.` (`openStepsReminder` in `plan-doc.ts`, commit `6df1ae0`). It is non-blocking and never auto-ticks. | Low (progress shown matches the work) | S | Low. | None. |
| D5 | (Line numbers at `6df1ae0`.) On a protected branch (`main`, `master`, `config.ts:178`) or a detached HEAD, `prepareDelivery` (`index.ts:2472-2497`) turns a `push` delivery into `commit`. It shows only a short UI notice. The commit instruction then has no push sentence (`delivery.ts:84`), so the commit step reports that it did not push because "the instruction covered only the commit", which looks like a bug. Idea: state the reason in the commit instruction or in the flow's final report, e.g. "push skipped: `master` is protected". **Done:** `pushSkipReason` and `pushSkipped` in `delivery.ts` and `index.ts`; the commit instruction says `Don't push: <reason>` and the report reads `push skipped: <reason>`. | Low (clearer report) | S | Low. | None. |

## Effect measurement

Nothing here is measured yet. D3 (logging) is the prerequisite: it records, per flow and per role, wall time, input and output tokens, and number of model calls. Without it, the "how" column below has no data.

Method for every item:
1. **Baseline**: run the same 3-5 representative flows (one small, one multi-file, one multi-stage, one multi-repo if you use them) and record the metric. Save the numbers in `docs/workflow-baseline.md`.
2. **After**: repeat on the same inputs with the change on. Compare medians, not single runs; model runs vary.
3. **Quality guard** (for every change that alters what a model sees: B1-B6, B8, B10, A4): count judge findings per flow and whether the same known defect is still caught. A token win that loses a finding is a failure.
4. **Keep or revert**: keep only if the target metric meets the threshold and the quality guard holds.

| # | Metric | How to measure | Keep if |
|---|--------|----------------|---------|
| A1 | Wall time from end of execute to judge verdict | D3 timing of the judge phase, before and after | Phase time drops by about the knowledge-pass duration; findings unchanged |
| A2 | Delivery step wall time on a multi-repo flow | D3 timing of delivery. Implemented, not measured yet. | Faster on 2+ repos; no change on 1 repo; push order unchanged |
| A3 | Git calls and time in `collectRepoDiff` | Count `git` spawns (wrapper counter) and time per call; also diff output equal to old output | Fewer calls, identical diff text byte for byte |
| A4 | Number of full diff builds per flow, and time spent in them | Counter and timer around `collectFlowDiff` | Fewer builds on repeat reviews; never a stale diff (test: edit a file, review must see it) |
| A5 | Time from execute end to judge start | D3 timing | Start-up gap shrinks; no guard failure is missed |
| A6 | Total flow wall time on plans with independent steps; merge conflicts | Compare a sequential run to a parallel run of the same plan | Wall time drops by 30% or more with zero lost edits or conflicts |
| A7 | Explore batch wall time; rate-limit errors | Time a batch of 8 queries at concurrency 4 and 8; count errors | Faster with no rate-limit errors. Implemented, not measured yet. |
| A8 | Stage-to-stage gap | D3 timing between stage commit and next executor start | Gap shrinks by a clear margin; otherwise drop the item |
| A9 | Subagent boot time per role (spawn to first model call) | Timestamps in `runSubagent` | Boot time falls; role still reaches its model |
| B1 | Judge tokens per flow and number of full reviews | D3 token log per judge call | Tokens drop on flows with large re-reviews; no defect missed that the old final review caught. Implemented, not measured yet. |
| B2 | Total tokens of judge + knowledge + arbiter | Sum from D3 | Combined tokens drop; knowledge output as useful as before (compare by reading 3 samples) |
| B3 | Advisor input tokens per call | D3 token log | Input drops sharply; advice still cites the right earlier decision in a sample of calls |
| B4 | Judge read-tool calls and tokens per run | Count `read` calls in the judge's JSON stream | Fewer reads and tokens; no finding lost that needed a cap-blocked read |
| B5 | Peak and average context tokens during execute; number of compactions | D3 log of context size per turn | Lower average context and total tokens; executor does not lose plan detail (steps still completed correctly) |
| B6 | Compactions per flow and tokens spent on them | Count compaction calls and tokens | Fewer compaction calls; next-phase quality unchanged |
| B7 | Plan-card size in tokens | Measure the card sent after handover | Card stays short in every case |
| B8 | Tokens of the system prompt per turn; executor step success | Character/token count of the prompt; steps done correctly across the sample flows | Smaller prompt, same completion rate |
| B9 | Prompt size | Character count | Smaller; identical behavior |
| B10 | Commit step tokens and time; commit subject quality | D3 for the commit role; check subject matches plan section 9 | Near-zero commit tokens; subjects match; hook failures still reach the model path |
| B11 | Commit tokens and failure rate | D3 and count of failed commits | Not recommended; only keep if failure rate does not rise |
| C1 | `snapshotTree` time on the largest repo | Time the function | Time drops; snapshot tree id equals the old one |
| C2 | Config loads per flow and time | Counter | Fewer disk reads; config edits still take effect on the next call |
| C3 | `git show` calls per plan listing | Counter. Implemented, not measured yet. | Fewer calls; statuses identical |
| C4 | Housekeeping time per call | Timer | Faster; status never stale after a write (test) |
| C5, C6 | n/a | Leave as is | n/a |
| D1 | Test coverage of the extracted modules; behavior parity | New unit tests; run all existing tests; run 2-3 real flows before and after | All tests pass; flows behave the same |
| D2 | Time lost to hung subagents | Count timeouts and their duration in D3 | Hung runs end sooner; no healthy run is killed |
| D3 | Presence of data | Check that every role logs time, tokens and calls for a flow | Log exists for every role in a full flow |
| D4 | Share of flows whose final `status.json` has every step ticked | Count over recent plan folders before and after `6df1ae0` | Most flows end fully ticked; no extra judge rounds |
| D5 | n/a | Report wording only | n/a |

What to report after each change: baseline median, new median, percent change, and the quality-guard result, appended to `docs/workflow-baseline.md`.

## Suggested order

1. **D3** (measurement), since most ratings above are guesses without it.
2. **A1, A3, C2, C3, B7, B9**: low risk, small, no change in what a model sees.
3. **B1, B3, B4**: biggest token wins, medium risk, each behind a config switch.
4. **B2, B5, B6, B10, A4**: larger or more behavior-sensitive; do after measuring.
5. **D1 before A6 and anything that changes the flow ordering.** A6 last, and only with evidence that steps are often independent.

## Not verified

- Whether pi runs `before_agent_start` per LLM call or per agent run (assumed per run).
- Actual token counts, process boot time and git timings; nothing was run.
- Prompt character counts in `prompts.ts`.
- Whether stage isolation relies on every stage being committed before the next review.
