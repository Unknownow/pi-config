<!-- pi-workflow plan v1 flow=20261114-1246-fix-the-orchestrator-s-merge-bugs-then-m-fd35 -->
## Plan: Fix the orchestrator's merge bugs, then make the judges, the orchestrator and autopilot run without the user

### 1. Goal and non-goals
**Goal:**
- An orchestrated package's PR gets merged with no manual help.
- The judges stop looping on minor and late findings.
- An orchestrated run needs the user only for the three reserved actions.
- A standalone flow on autopilot handles its own judge cap, error retries and `fix: user` plan findings.

**Non-goals:**
- No metrics for the proposal judge.
- No change to `wait_for_user` manual waits.
- `confirmPlans` stays off.
- No re-check item for PR #243. The cause is found and already fixed (see §3).
- Never stage the user's uncommitted edits in `pi/agent/orchestrate.json` and `pi/agent/workflow.json`.

### 2. User decisions
- **D1. Stage order:** the merge fixes come first, as Stage 1.
- **D2. Acceptance wait:** a pending acceptance (merge, protected push or publish) holds the sub-session's flow. While it holds, there is no stage-end menu, no steps-open menu and no flow end.
  - It sends no K12 ask and is not re-sent on restart.
  - Three things end it: the orchestrator's verdict, a message the user types (under the existing wait rule), or `/orch merge`.
  - On restart, it looks for a verdict that has already arrived.
- **D3. Verdicts:**
  - Accepted: the sub-session merges or pushes itself, with its own workflow settings.
  - Refused: the executor gets the reasons.
- **D4. When the orchestrator merges:** only in two cases.
  - (a) The sub-session no longer works on the package: its flow ended or its session closed, and the PR for an accepted tree is still open. The watcher merges it.
  - (b) The user runs `/orch merge <id> [--force]`, or the model calls `orch_merge`. This works only when the sub-session isn't running or is in an acceptance wait.
  - Every orchestrator merge is pinned with `--match-head-commit` and recorded in `merges.json` with its PR number and merge commit.
- **D5. `/orch merge <id> [--force]`** replaces `/orch merged <id> --force`.
  - Without `--force`, the PR head's tree must be accepted.
  - `--force` skips acceptance but still pins the head commit. Whether failing CI blocks the merge depends on the repo's branch protection.
  - If the PR is already merged, the command only marks the package merged.
  - The model's `orch_merge` has no force option.
- **D6. Merge settings:** the orchestrator merges with the sub-session's own delivery settings. With none recorded, it uses the global `workflow.json` `delivery`. No new keys go into `orchestrate.json`.
- **D7. Finding PRs:** a package's PRs are found by head branch on any base. The branches come from the `accept-request` `branch` field and a `branches` list in `status.json`.
- **D8. Worktree bases:** worktrees are created from the run target. The base is stored in `.pi-set.json`, and status, remove, update and the delivered check read it. Older worktrees fall back to `findBase`.
- **D9. `/orch go`:** it reports each target and where the target came from. It asks the user when a package names a different base.
- **D10. Plan approval notes:** `orch_review_plan` takes approval notes. They are appended to the approved plan, so an approved plan is never re-planned.
- **D11. No messages during plan review:** no directive or info reaches a sub-session while its plan is under review. `orch_send` refuses them, and the sub-session holds any that arrive anyway.
- **D12. Minors never trigger a re-review:**
  - Plan-judge minors become notes for the executor in the plan.
  - Code-judge minors are fixed after a PASS. A check with no model call confirms the fix touched only the cited files.
- **D13. Rechecks:** a recheck blocks only on findings from earlier rounds that are still not fixed, or on a new blocker or major in the lines the fix changed. Any other new finding is reported as "late".
- **D14. Severity:** the prompts define "major". A broken `required` knowledge rule is major. A broken `recommended` rule is a note.
- **D15. Gaps:** a gap fails the discussion, plan or proposal judge only when it needs the user's decision or risks data loss or a visible break. Fix the discussion gate reviewing a stale `Agreed so far:` list.
- **D16. Run charter:** the user approves a run charter at "go". The charter and a decision log go into every brief.
- **D17. Limits:** a reached limit goes to the orchestrator (step back, advisor, replan, split or narrow). No user quote is needed.
- **D18. Questions:** the orchestrator answers them as reversible assumptions. Each one is logged and listed in the final report, marked with the packages that build on it.
- **D19. Only these wait for the user:** stopping or dropping a package, changing the goal or scope, and an irreversible action that no plan covers. Only that package is parked.
- **D20. Person-only checks:** they go to the final report. `confirmPlans` stays off.
- **D21. Standalone autopilot:**
  - First judge cap: ask the advisor once. Second cap: stop.
  - Each error gets one automatic retry.
  - A plan-judge `fix: user` finding is settled with the recommended option and recorded as an assumption.
  - All assumptions appear on the final card.
- **D22. Metrics:** `metrics.jsonl` records each judge verdict with its finding counts.
- **D23. Tests:** no new tests. Existing tests whose expected behaviour changes are updated.

Merge points: none. The flow lands as one PR, merged at the end.

**Design choice not decided by you:** a `[late]` **blocker** still fails a review. Blockers mean security, data loss or a broken build.

**Stages:**
1. Merge fixes: the acceptance wait, orchestrator fallback merges, `/orch merge`, PR lookup, worktree bases.
2. Plan-review loop: approval notes, holding messages during review.
3. Judge rules: severity, late findings, minors as notes, the gap rule, the stale-list fix, metrics.
4. An orchestrator that runs without the user: charter, decision log, step-back, reserved actions.
5. Standalone autopilot: judge cap, retries, `fix: user` assumptions, final card.

### 3. Facts the executor needs (line numbers are at HEAD of `master`)

**PR #243 (why it showed as not merged).** The cause is found and needs no fix:
- The orchestrator session loaded its code at 13:37Z, before commit `48ec5d9` (14:55Z) existed.
- That older code ran `gh pr list --head` without `-R`. In `city-bus-flow`, gh resolved that to the `upstream` remote (`Annamites/game-template`).
- The PR itself was merged at 15:07:26Z, and its head tree is the accepted tree `58338ce5`.
- Current code passes `-R <slug>` (`orchestrate/index.ts:1195, 1226`).
- The workflow still runs `gh pr view <n>` without `-R` at `workflow/index.ts:2555, 4235, 4309`. That is the same bug, and S10 fixes it.

**The merge-gate path today:**
- **Workflow side.** The gate closure is at `workflow/index.ts:3010-3028`. It calls `acceptanceProblem` (`:3057-3059`), which uses `acceptanceRefusal` in `hooks.ts:34-42`.
  - The K11 site kinds are merge, protected-push and publish.
  - `judgedMerges` is recorded only after a pass (`:3020-3026`). It is read by `unmergedRepos` (`:4305-4320`) and `judgedMergeHead` (`:2550-2560`).
- **Sub-session side** (orchestrate). `handleMergeGate` is at `orchestrate/index.ts:369-401`.
  - `mergeGateDecision` (`delivery.ts:28-51`) builds the refusal text at `:50`.
  - The `accept-request` data is `{tree, repo, kind, ask}`.
  - `requestedTrees` is kept in memory only.
- **Waits.** `state.waiting` is typed at `workflow/index.ts:177` and already has `waitKind?: "external"`.
  - `setWaiting` is at `:2139`, `clearWait` at `:2129`, `resumeWait` at `:2205`, `waitTick` at `:2227`.
  - When the user types a message during a wait, the wait ends at `:3217-3246` (`finishWait`).
  - `onAgentEnd` returns early while a wait is set (`:3462`).
  - `restoreAsks` (`asks.ts:123`) re-sends only waits that have an `askId`.
  - `session_start` calls `startWaitTimer` for any saved wait (`:4474`).
- **K4.** `emitStatus` is at `workflow/index.ts:563-583`. The sub-session writes it to `status.json` (`orchestrate/index.ts:184-207`; type `Status` at `store.ts:21-35`). The sub-session's status line is at `:458-478`.
- **Delivery config.** `workflow/config.ts:25-31`, defaults at `:202` (`mergeMethod "merge"`, `deleteBranch true`).
- **Merge check.**
  - `checkSub`: `orchestrate/index.ts:1246-1290`.
  - `listMerged` (filters by base): `:1222-1243`.
  - `ghMerged`: `:1193-1202`.
  - `lastDelivery` and `deliveryMerged`: `delivery.ts:83-147`.
  - `merges.json`: `store.ts:184-202`, built from outbox `merge-pass` messages (`delivery.ts:57-72`).
  - `checkEnded` and `checkRound1`: `index.ts:1293-1298`.
  - `pidAlive` is used at `:362, 867`.
- **Merge commands and tools.**
  - `orch_accept`: `index.ts:1815-1850`.
  - `/orch merged`: `:1951-1956`, with `parseMergedArgs` at `delivery.ts:173-178`. Completions: `:1913-1915`.
  - The `ALWAYS` tool list is at `orchestrate/mode.ts:40`.
  - `toolRefusal` returns null when the mode is `off` (`mode.ts:44`). The orchestrator's bash otherwise goes through the read-only check, which refuses `gh pr merge`.
  - The tool_call hook is at `index.ts:631-634`.
- **Inbox delivery.** `deliverInbox` is at `index.ts:407-446`. `plan-verdict` resolves `k10` (`:427-429`). Directive, info and accept-verdict messages go to the model (`:443-446`).
- **Worktrees.**
  - The `worktree:create` payload is built at `orchestrate/index.ts:1677-1687`. Run targets come from `:1590-1613`; with no target given, the upstream `@{u}` is used.
  - `parseCreate` is at `worktree/create-event.ts:4-14`, and the listener at `worktree/index.ts:885-909`.
  - `createAndLaunch` is at `worktree/index.ts:268`; `writeMeta` is called at `:242`.
  - `SetMeta` is defined at `worktree/meta.ts:6-11`.
  - In `worktree/git-ops.ts`: `repoInfo` at `:49-67` and `findBase` at `:69-77` both use `findBase`. Targets are `<setRoot>/<dir>` (`:98`), `createAll` is at `:107-110`, and `baseOf`/`baseRefOf` at `:187-198`.
  - Callers of `baseOf`/`baseRefOf`: `manage.ts:75, 188, 313`, `update.ts:37, 59`, `git-ops.ts:267` and `clean.ts:128` (on the main repo).
- **Judges.**
  - Code verdict: `workflow/index.ts:2051`.
  - `countFindings`: `:271`. `fixableFindings`: `agent-end.ts:219-225`.
  - Minor rounds: `agent-end.ts:8-10, 119-121`; `fixMinorFindings` at `index.ts:4196-4211`; `minorFixMessage` at `prompts.ts:16`.
  - `JUDGE_RECHECK` is used at `index.ts:1986-2008` and defined at `prompts.ts:245`.
  - `passedTrees`: `index.ts:1152`.
  - `isClean`: `shared/findings.ts:50-52` (PASS and no findings at all). It is used by `planGateAfterVerdict` (`gates.ts:97-103`), `discussionGateAfterVerdict` (`gates.ts:180-184`) and `proposalGateAfterVerdict` (`orchestrate/proposal-gate.ts:27-31`).
  - Findings are parsed in `shared/findings.ts:8-18`, and `lastAgreedList` is at `:76-83`.
  - Gate menus: `planReadyJudge` and `menuJudgeLines` (`gates.ts:112-127`); `judgeSection` and `planReviewJudgeLine` (`orchestrate/plan-judge.ts:29-50`).
  - Discussion gate: `index.ts:3842-3963`.
  - Prompts in `workflow/prompts.ts`: `JUDGE` `:136`, `JUDGE_DISCUSSION` `:161`, `JUDGE_DISCUSSION_RECHECK` `:184`, `DISCUSSION_FIX` `:195`, `JUDGE_PLAN` `:198`, `JUDGE_PLAN_RECHECK` `:221`, knowledge rules `:289-317`.
  - Orchestrate prompts: `DISCUSS` `:5`, `PROPOSE` `:12`, `RUN` `:16-24`, `RUN_KICKOFF` `:29`, `JUDGE_PROPOSAL` and its recheck `:46-61`.
- **Autopilot.** `autopilotOn()` is at `index.ts:420`.
  - Judge-cap menu: `:4040-4058`, with `escalate` at `:814`.
  - Judge-error menu: `:4009`. Executor-error menu: `:3464`.
  - Autopilot skips waits at `:2328-2334`.
- **Orchestrator internals.**
  - `renderBrief` and `kickoffText`: `orchestrate/brief.ts:193-250`.
  - Limit checks: `items.ts:182, 188, 193, 214-215`.
  - User-quote checks: `decide.ts:40, 50, 51`.
  - Escalation actions become messages around `index.ts:935`.
- **Reports and metrics.** `metrics.ts:19-40`; `flow-report.ts:38-67`.
- **Test commands:**
  - `orchestrate/README.md:136`
  - `workflow/README.md:252`
  - `worktree/README.md:182`
- **Free IDs:**
  - Contract: K15.
  - Backlog: A50, B16, D52.

### 4. Design

#### Contracts
- **K11 answer:** `{ problem: string; pending?: true }`. `pending` means an acceptance request is waiting for the orchestrator.
- **K4 payload** gains two optional fields:
  - `acceptance?: { tree: string; repoRoot: string; kind: "merge"|"protected-push"|"publish"; since: string }`, sent while an acceptance wait is set.
  - `delivery: { mergeMethod; deleteBranch }`, always sent.
- **K15 `workflow:acceptance`.** Orchestrate (in the sub-session) emits it; the workflow listens. Payload: `{ v: 1, tree: string, accept: boolean, merged?: { pr: number; mergeCommit?: string }, text: string }`. The workflow ignores it unless an acceptance wait for the same tree is set.
- **`accept-request` data** gains `branch: string`.
- **`accept-verdict` data** gains `merged?: { pr, mergeCommit? }`. Every merge the orchestrator makes appends an `accept-verdict` with `accept: true` and `merged`.
- **`status.json`** gains three optional fields; readers ignore them when they are missing:
  - `acceptance?: { tree, since }`
  - `delivery?: { mergeMethod, deleteBranch }`
  - `branches?: string[]` (unique, newest last, at most 20)
- **`merges.json` records** gain optional `pr?: number`, `mergeCommit?: string` and `forced?: boolean`.
- **`worktree:create`** gains `bases?: Record<string, string>`.
  - The key is the source repo's top-level folder (forward slashes, as in `run.repos[].top`).
  - The value is a remote ref such as `origin/feat/x`.
  - A ref that doesn't resolve is an error: `base <ref> not found in <top>`.
- **`SetMeta.repos[]`** gains `base?: string`.
- **`orch_review_plan`** gains `notes?: string` (approve only). The K10 answer becomes `{ approve: true, notes? }`.
- **Run charter files:** `charter.md` and `decisions.md` in the run folder.
  - Decision line format: `- <ISO> [<id>|run] <kind>: <text>`, with an optional ` (ASSUMPTION; affects: <ids>)` suffix.
  - Only the orchestrator writes `decisions.md`, and only by appending.
- **Findings:** a finding head may carry the tag `[late]` after the severity. The code verdict is recomputed whenever finding lines parse: FAIL if there is any blocker, or any major without `[late]`. With no finding lines, the `VERDICT:` line decides, as today.
- **`isClean`** becomes: PASS and no blocker or major finding.
- **New workflow state:**
  - `minorFix?: { trees: Record<key,string>; cited: string[] }`
  - `lateFindings?: string[]`
  - `autoCaps?: number`
  - `autoRetries?: Record<string, number>`
- **Metric event:** `{ kind:"judge", at, flowId, gate:"code"|"plan"|"discussion", round, verdict, blocker, major, minor, late }`.

#### "The sub-session is not running"
Any one of these makes it true:
- The last outbox `flow-ended` is newer than the last `session-started`.
- `pidAlive(status.pid)` is false.

"In an acceptance wait" means `status.json.acceptance` is set.

#### Failure handling
- **Fallback merge fails** (conflict, a required check, or no matching PR): the error goes to the orchestrator's watcher report. The watcher tries each tree only once.
- **Message typed during an acceptance wait:** the gate keeps refusing until a verdict arrives or someone runs `/orch merge`. The next attempt sets the wait again.
- **Messages held during plan review** are kept in memory only, so they are lost on a restart. This is rare, because `orch_send` already refuses them.

#### Scale
- 2-4 sub-sessions per run.
- 1-3 branches per package.
- Each branch listing returns fewer than 50 PRs.

#### Rejected alternatives
- **The orchestrator always merges:** this needs two sets of settings, and the sub-session would keep working on a deleted branch.
- **Saving held messages to disk:** it duplicates verdict handling.
- **Fixing the loops with prompts alone:** `isClean` is what causes the loop.

### 5. Steps

### Stage 1: Merge fixes
**S1.** Make the merge gate report a pending acceptance. In `orchestrate/index.ts:386-401` (`handleMergeGate`):
- Return `{ problem, pending: true }` whenever the decision posts a request or the request is already pending (`dec.request` or `requestedTrees` has the token).
- Add `branch` (`git rev-parse --abbrev-ref HEAD` in `dir`) to the request data.

Change the refusal text at `delivery.ts:50` to:

> Acceptance pending for tree X: end your turn and do not retry; the workflow resumes you when the orchestrator answers.

**S2.** Hold the flow while acceptance is pending (workflow).
1. `hooks.ts:34-42`: `acceptanceRefusal` returns `{ text, pending }`. Update the caller at `index.ts:3057`.
2. In the gate closure (`index.ts:3018`), on a pending refusal, call a new `setAcceptanceWait(kind, tree, root)`:
   - It sets `state.waiting` with `waitKind: "acceptance"`, a reason, the `step`/`stage` taken from the current state, `since: now` and `planned: false`.
   - It sets no `askId`, sends no K12 ask and starts no wait timer.
   - It calls `persist`, `updateStatus` and `emitStatus`.
3. Exclude acceptance waits from these:
   - `waitTick` (`:2227`)
   - `startWaitTimer` in `session_start` (`:4474`)
   - autopilot's wait skip (`:2328`)
4. `emitStatus` (`:563`) adds the `acceptance` and `delivery` K4 fields.
5. When the user types a message that ends an acceptance wait (`:3245`), append this to the text:
   > (The orchestrator's acceptance is still pending: a merge stays refused until it answers or the user runs /orch merge.)

**S3.** Add the K15 listener (workflow). It acts only when `state.waiting?.waitKind === "acceptance"` and the tree matches. It clears the wait and sends a `workflow-wait` message to the executor (follow-up, triggers a turn; model on `resumeWait`, `:2223-2224`):
- **Merged:** set `state.judgedMerges[repoKey(root)] = { pr: String(n), tree, stage }`, then say:
  > The orchestrator merged PR #n (its branch may be deleted). If plan steps remain, fetch, start a new branch from the updated target and continue; otherwise tick the Deliver step and end your turn.
- **Accepted:**
  > Accepted: retry the <merge|push|publish> now, as its own command.
- **Refused:** the verdict text, then:
  > Fix it, rerun the judge, then retry.

**S4.** Emit K15 and write the new status fields (orchestrate, in the sub-session).
- In `deliverInbox` (`:443-446`), on an `accept-verdict`: emit K15 from its data, then pass the text to the model only when no acceptance wait is set. The workflow's K15 message replaces it.
- When a K4 arrives with `acceptance`, scan the inbox for `accept-verdict` messages for that tree with `ts >= since`. If one exists, emit K15 from the newest. This covers both a restart and a verdict that arrived before the wait was set.
- `writeMyStatus` (`:184`) writes `acceptance`, `delivery` and `branches`:
  - On each K4 and each gate call, add the current branch to `branches`.
  - At start-up, restore `branches` from the existing `status.json`.
- `updateSubStatus` uses `acceptance` to show "waiting for orchestrator: acceptance".

**S5.** Merge from the orchestrator (`orchestrate/index.ts`). Add `mergePackage(id, { force, auto, repo? })`.
1. **Refuse while the package is busy:** unless the sub-session is not running or is in an acceptance wait (§4), refuse with "package <id> is still working".
2. **Pick the PR for each repo:**
   - Branches to try: the newest `accept-request` branch, then `status.branches` (newest first), then `sub.branch`.
   - Already-merged PR: if `gh pr list -R <slug> --head <b> --state merged` finds a PR whose head tree is the delivered tree, only mark the package merged, with `checkEnded(true, [id], true)`.
   - Open PR: otherwise, list open PRs with `--state open --json number,headRefOid`.
     - Without force: take the PR whose head tree (`treeOfSha`) is in `accepted.json`. If none matches, refuse.
     - With force: take the only open PR. If there are several, refuse and list them.
3. **Settings:** use `status.json.delivery`. If it is missing, use the global `workflow.json` `delivery` from the folder that holds `orchestrate.json` (defaults `merge`/`true`).
4. **Merge:** run `gh pr merge <n> -R <slug> --<method> [--delete-branch] --match-head-commit <sha>`.
5. **On success:**
   - Append a `merges.json` record with `pr`, `mergeCommit` and `forced`.
   - Append an `accept-verdict` with `merged` (S3 resumes a waiting sub-session).
   - Run `checkEnded(true, [id], force)`.
6. **On failure:** return the gh error.

Then wire it up:
- `/orch merge <id> [--force]` replaces `merged` at `:1951-1956`, with the completion at `:1913`. Reuse `parseMergedArgs`.
- Add the tool `orch_merge { id, repo? }` (never force) to `ALWAYS` in `mode.ts:40`.
- **Watcher fallback:** in the check round, when a sub-session is not running, its delivery is a merge, the delivered tree is accepted and the check is not ok, call `mergePackage(id, { auto: true })`. Do this once per tree (an in-memory set). A failure becomes a report line.

**S6.** Find merged PRs by head branch. In `checkSub` (`:1246-1290`):
- A `merges.json` record with `pr` for the delivered tree counts as merged.
- Otherwise, replace `listMerged`'s base filter with one listing per branch (the branches from S5): `gh pr list -R <slug> --head <b> --state merged --json number,headRefOid,mergedAt`. Keep the `run.created` filter, the tree index and the cache, keyed `slug|branch`.
- `ghMerged` uses the same branch set.
- `deliveryMerged`'s "into <base>" wording drops the base.

**S7.** Refuse `gh pr merge` in the orchestrator session. In the tool_call hook (`index.ts:631`), before the `mode === "off"` return: when this session owns a run that has a package not merged or stopped, refuse bash commands matching `gh … pr merge` or `gh api … /merge`. Message:

> merges in a run go through /orch merge <id> (user) or orch_merge

**S8.** Worktree bases.
1. `create-event.ts`: accept `bases` (an object of strings, otherwise an error).
2. `repoInfo` (`git-ops.ts:49`) takes an optional base. After the fetch, it verifies the base with `git rev-parse --verify --quiet` and returns it as `baseRef`. Without a base, it uses `findBase`, as today.
3. `preflight` and `createAndLaunch` pass the base for each repo, keyed by the source top.
4. `writeMeta` (`index.ts:242`) stores `base` per repo.
5. `baseOf` (`git-ops.ts:187`) reads `readMeta(path.dirname(wt))` and uses the matching repo's `base` (matched by `dir === basename(wt)`). It falls back to `findBase`. Callers need no change. `clean.ts:128` stays as it is.
6. Update the W1 contract in `worktree/README.md`.

**S9.** Targets in the orchestrator.
- **Spawn** (`index.ts:1677`): send `bases`, mapping each repo top to `run.targets[key]`. For a single repo, map the working top to `targets[""]`.
- **`orch_run`** (`:1590-1613`):
  - Each target line names its source: `(given)` or `(upstream of <branch>)`.
  - `PackageInput` gains optional `base`, the branch the package starts from and merges into, as written in the proposal.
  - If a package's `base` differs from its repo's target, ask with `ctx.ui.select` ("Use <target>", "Use <base>", "Cancel"). Without a UI, refuse.
- **`PROPOSE` prompt** (`prompts.ts:12`): the model writes each package's base and passes it to `orch_run`.

**S10.** Name the repo in the workflow's gh calls. `gh pr view` at `workflow/index.ts:2555, 4235, 4309` passes `-R <owner/name>`, parsed from the `origin` remote URL. If the URL can't be parsed, keep the current call. Model it on orchestrate `pickGhRepo` (`index.ts:1190`).

**S11.** Docs and backlog.
- `orchestrate/README.md`: K11 `pending`, K15, the status fields, `/orch merge`, `orch_merge`, the fallback, the bash refusal and targets.
- `workflow/README.md`: the acceptance wait and K15.
- `docs/workflow-improvements.md`: add these rows, each **Done**:
  - D52: the acceptance wait.
  - D53: fallback merge, `/orch merge`, `orch_merge` and the bash refusal.
  - D54: worktree base from the target and the target source.
  - D55: PR lookup by head branch.
  - D56: the workflow's gh calls name the repo.
- Update the Status line and the Effect-measurement row. The measure is hand merges per run, which should be 0.

### Stage 2: Plan-review loop
**S12.** Add approval notes to `orch_review_plan` (`orchestrate/index.ts:1778-1810`).
- Add `notes` (approve only) and put it into the `plan-verdict` data.
- New tool description: approve with notes for anything extra; reject only for a blocker or major problem; never send a directive to change an approved plan.
- In the sub-session (`:427-429`), resolve `k10` with `{ approve: true, notes }`.

**S13.** Append the notes to the plan (workflow K10). In `hooks.ts:23-29`, `index.ts:3637-3640` and `approve` (`:800`): when there are notes, append `## Orchestrator notes\n<notes>` to the plan before approval. Add a line to `EXECUTE_PHASE` (`prompts.ts:105`) telling the executor to apply that section.

**S14.** Hold messages during review.
- `orch_send` (`:1743-1767`) refuses `directive` and `info` while the package has a live `plan-review` item, with the message: "use orch_review_plan notes or reasons". Answers to questions stay allowed.
- `deliverInbox` (`:443`) queues `directive` and `info` messages while `k10` is set and sends them in order after `k10` resolves.
- Update the `RUN` prompt to match.

**S15.** Docs and backlog: K10 notes in both READMEs, and row A50 **Done**. The measure is plans per package, which should be 1-2.

### Stage 3: Judge rules
**S16.** Severity helpers in `shared/findings.ts`.
- `isClean`: PASS and no blocker or major.
- The parser (`:8-18`) reads `[late]` into `late: boolean`.
- Add `blockingFindings` (blocker, or major that is not late) and `minorFindings`.
- The discussion and proposal gates pause only on a blocking `fix: user` finding.
- The plan gate (`gates.ts:97-103`) runs a fix round only for blocking findings marked `fix: auto`.

**S17.** Minors become notes.
- **Plan:** when the plan is offered (`index.ts:3629-3660`), append the last run's minors as `## Notes for the executor`.
- **Menus:** `planReadyJudge`, `menuJudgeLines`, `judgeSection` and `planReviewJudgeLine` list only blocking findings, plus a count of notes.
- **Discussion:** minors go into the plan kickoff on move and move-open (`index.ts:3937`).
- **Proposal:** minors go into the run kickoff (`orchestrate/index.ts:694-698`).

**S18.** Fix code minors without a re-review.
1. After a PASS that has minors (`index.ts:4036`, `fixMinorFindings` `:4196`), store `state.minorFix`: the passed tree and the cited files, parsed as in `repo-diff.ts:16-22`.
2. `minorFixMessage`: "only the cited files; any other file goes back to the judge".
3. In `reviewDiff` (`:3967`) and the merge/push gate (`:3016`): if `git diff --name-only <passed> <current>` lists only cited files in every repo, add the tree to `passedTrees`, clear `minorFix` and continue without the judge. Otherwise run the judge with `JUDGE_MAJOR_ONLY`.
4. `maxMinorRounds` still applies.

**S19.** Rechecks and late findings.
- Rewrite `JUDGE_RECHECK` (`prompts.ts:245`) to report earlier findings that are still not fixed, plus new problems in the changed lines or in code those lines break. Any other new finding is tagged `[late]`.
- Recompute the verdict at `index.ts:2051` (§4).
- `fixableFindings` skips non-blocker late findings.
- `countFindings` counts late findings separately.
- `state.lateFindings` collects them without duplicates.
- The final card shows them (`flow-report.ts`).
- The merge reminder (`:4348`) asks for a "Late findings (not fixed)" section in the PR body.

**S20.** Define severity in `JUDGE`, the knowledge section (`:289-317`) and `JUDGE_PROPOSAL`.
- **blocker:** security, data loss, a crash or a broken build.
- **major:** a visible bug, a failing test, a broken contract, going against a User decision, or breaking a `required` rule.
- **minor:** everything else, including `recommended` rules.

Add the gap rule to the six discussion, plan and proposal judge prompts. A finding is blocker or major only when one of these holds:
- it needs a decision from the user
- a false claim about the code changes the design
- two decisions contradict each other
- it risks data loss or a visible break

Any other gap is minor.

**S21.** Stale-list fix. Before any discussion review (`index.ts:3842-3870`, and the manual `/flow judge` path in `discussion-review.ts`): if a review already ran and no `Agreed so far:` list has been written since, don't call the judge. Send the discuss model `DISCUSSION_RESTATE`:

> Restate the whole conclusion under `Agreed so far:`; only that heading is reviewed.

Add the same requirement to `DISCUSSION_FIX`.

**S22.** Metrics. Add `judgeMetric` to `metrics.ts`, modelled on `:19`. Write a `judge` event where the code (`:2051`), plan (`~:3768`) and discussion (`~:3906`) verdicts are parsed.

**S23.** Docs and backlog: README gate rules (`workflow/README.md:148-161`), plus these rows, each **Done**:
- B16: minors as notes, minor fixes without review.
- B17: recheck scope, late findings, severity and gaps.
- D57: the stale list.
- D58: judge metrics.

The measures are judge runs per flow and FAIL streaks.

### Stage 4: An orchestrator that runs without the user
**S24.** The run charter.
- `DISCUSS` asks the user until the charter can be written.
- `PROPOSE` requires a `## Charter` section with Goal, User decisions, Non-goals, Priorities, Target, Standing orders and Reserved for the user (the D19 actions).
- `JUDGE_PROPOSAL` reports anything the charter leaves unsettled as `fix: user`.
- `orch_run` requires a `charter` string. It writes `charter.md` and an empty `decisions.md`, with path helpers next to `store.ts:212, 225`.
- `RUN_KICKOFF` passes the charter on.
- `renderBrief` embeds the charter and the path to `decisions.md`. `kickoffText` tells the sub-session to read both before asking anything.

**S25.** The decision log.
- `orch_send` gains `assumption` and `affects`.
- These entries are appended to `decisions.md` (§4 format, up to 600 characters each):
  - answers and directives
  - `orch_review_plan` notes and reasons
  - `orch_accept` refusals
  - `orch_decide` choices
  - `orch_merge` and `/orch merge` merges
- The all-done report (`index.ts:1354-1363`) and `/orch end` list every assumption with the packages it affects. `/orch status` shows the count.

**S26.** Step back instead of escalating.
- The limits at `items.ts:182, 188, 193` return `{ type: "step-back", item, why }`, and the item stays open.
- The watcher (`index.ts:~935`) sends the orchestrator: re-read the brief, the plan and the log, ask the advisor, then replan, split or narrow. Stopping a package is reserved for the user.
- The timeouts at `:214-215` become reminders plus a UI notice.
- `decide.ts:51` drops the quote requirement for replans. Keep the requirement at `:40` and `:50`.

**S27.** Prompts.
- `RUN`: decide from the charter, the log and the code. An unsettled question gets the most reversible option, using the advisor when the choice has consequences, and is answered with `assumption: true`. Escalate only the reserved actions and keep the other packages running. Person-only checks go to the final report.
- The `orch_escalate` description (`:1889`) says it is for reserved actions only.

**S28.** Docs and backlog: README, plus row A51 **Done**. The measure is escalations per run, which should be only reserved ones.

### Stage 5: Standalone autopilot
**S29.** Judge cap on autopilot (`:4040-4058`).
- First cap in the flow (`autoCaps === 0`): take "Escalate and keep fixing" and add "ask the advisor about the open findings first".
- Second cap: stop.
- Notify both times.

**S30.** Error retries. On autopilot, the first judge-error (`:4009`) or executor-error (`:3464`) in a row is retried automatically, counted in `autoRetries`. The next one in a row shows the menu. A success resets the count.

**S31.** Plan-judge `fix: user` findings. On autopilot, blocking `fix: user` findings go to the planner (`:3768-3781`) with `PLAN_ASSUME`:

> Pick the recommended option, apply it, and record it as `A<n>: <finding> → <choice>` under `Assumptions:`.

**S32.** Final card. `flow-report.ts` gains an "Autopilot decisions" section listing:
- the plan's `Assumptions:`
- skipped waits
- S29 and S30 choices

**S33.** Docs and backlog: the README autopilot section (`:184`), plus row A52 **Done**. The measure is menus shown per flow on autopilot.

### 6. Tests
No new tests (D23). Update the existing tests whose expectations change:
- `delivery.test.ts` (refusal text, `parseMergedArgs`, the "into" wording)
- `items.test.ts` (step-back)
- `gates.test.ts` and `proposal-gate.test.ts` (`isClean`)
- `create-event.test.ts` (`bases`)
- `asks.test.ts`, if present

Run each suite; all must pass, and each runs in under 2 minutes:
- `cd pi/agent/extensions/workflow && node --experimental-strip-types --test *.test.ts`
- `cd pi/agent/extensions/orchestrate && node --experimental-strip-types --test *.test.ts`
- `cd pi/agent/extensions/worktree && node --experimental-strip-types --test *.test.ts`
- `pi/agent/extensions/shared`, the same command if it has tests

### 7. Done when
**Stage 1:**
- A refused merge keeps the flow open. After "accepted", the executor's retry merges.
- A protected push and a publish wait the same way.
- A sub-session restarted during the wait resumes on a verdict that has already arrived, including "merged" from a fallback merge.
- The watcher merges the accepted open PR of a flow that has ended.
- `/orch merge` merges an accepted PR. `--force` merges an unaccepted one. Both refuse a busy package.
- `gh pr merge` in the orchestrator's bash is refused, even with `/orch off`, while a run is live.
- New worktrees start at the run target, and `/wt status` compares against it.
- A package's PR merged into any base is found.

**Stages 2-5:**
- An approval with notes produces no new plan.
- A PASS with only minors never starts another judge run in any gate.
- Late non-blocker findings are listed and don't block.
- Limits message the orchestrator, not the user.
- Autopilot handles the cap, retries and `fix: user` findings, and its decisions appear on the card.

**Always:**
- All §6 suites pass.
- The backlog rows, the Status line and the Effect-measurement rows are updated in the same commits.

### 8. Risks, rollback, what not to touch
**Risks:**
- A minor fix that touches only the cited files skips review (D12).
- Late majors ship unfixed, but they are listed (D13).
- The fallback merge uses the orchestrator's gh login, pinned by the head commit.
- Held messages are lost if the sub-session restarts during a plan review.
- A K15 that arrives with no wait set is ignored. The scan on the next K4 covers it.

**Rollback:** each stage is its own set of commits, so a stage can be reverted on its own.

**Don't touch:**
- `pi/agent/orchestrate.json` and `pi/agent/workflow.json`
- the push-guard and commit-guard rules
- `wait_for_user` manual waits

### 9. Commits
1. `fix(orchestrate,workflow): hold the flow while acceptance is pending` (S1-S4, D52)
2. `feat(orchestrate): fallback merge, /orch merge and orch_merge, PR lookup by head branch` (S5-S7, D53, D55)
3. `fix(worktree,orchestrate): create worktrees from the run target and report its source` (S8-S9, D54)
4. `fix(workflow): name the repo in gh pr view` (S10, D56)
5. `feat(orchestrate,workflow): approval notes and held messages during plan review` (S12-S15)
6. `feat(workflow,orchestrate): minors as notes, late findings, severity and gap rules` (S16-S20, B16, B17)
7. `fix(workflow): discussion review asks for a restated list instead of rejudging an old one` (S21, D57)
8. `feat(workflow): judge verdict metrics` (S22, D58)
9. `feat(orchestrate): run charter, decision log, step-back instead of escalation` (S24-S28)
10. `feat(workflow): autopilot handles judge cap, retries and fix-user plan findings` (S29-S33)

I settled the judge's four open findings in the plan:
- `/orch off` still refuses `gh pr merge` while a run is live (S7).
- A typed message ends the wait, but the gate keeps refusing until a verdict arrives (S2).
- On restart, the sub-session checks for verdicts already received, including "merged" (S4).
- `status.json` now records the acceptance wait (S4).

I also found why PR #243 showed as not merged. The orchestrator session was running code from before `48ec5d9`, and that code ran `gh pr list` without `-R`, so gh looked at the `upstream` repo. The current code already passes `-R`, so no re-check item is needed. The workflow's own `gh pr view` calls have the same gap; S10 fixes them.

One choice of mine needs your OK: a `[late]` **blocker** still fails a review. Say if you want late blockers not to block. Otherwise, approve and Stage 1 starts.

## Plan changes

**§3 Facts (corrections):**
- `pickGhRepo` is at `orchestrate/delivery.ts:195`.
- The `gh pr view` calls without `-R` are at:
  - `workflow/index.ts:2555`
  - `workflow/index.ts:4231`
  - `workflow/index.ts:4313`
  - `workflow/merge-gate.ts:133` (`recordJudged`, used by `git_task`)

  `gateCheck` already passes `-R` when it is given a repo (`merge-gate.ts:72`).
- `findBase` is at `worktree/git-ops.ts:65`.
- `ALWAYS` is at `orchestrate/mode.ts:39`.
- `handleMergeGate` starts at `orchestrate/index.ts:370`. It resolves the tree at `:390`.
- Three places call `acceptanceProblem`, and each needs the new result:
  - `:2427`, `publish_packages`: K11 site `publish`, which asks `gate`, with tree `null`.
  - `:2478`, `git_task`: site `git-task`, which asks `pre` and is never pending.
  - `:3018`, the shell gate: sites `merge` and `protected-push`.

  `K11_SITES` is at `hooks.ts:62-71`.
- When the run is marked merged, `checkRound1` sets `s.state = "merged"` and calls `unregister` (`orchestrate/index.ts:1347-1352`). `endDecision` with `manual` set and `ok` true returns `"merge"` (`delivery.ts:160-162`).
- `orchestrate/wiring.test.ts:24-26` checks that `judging:` appears within 900 characters of `function writeMyStatus(`.

**§4 Contract change:** the K11 answer becomes `{ problem: string; pending?: true; tree?: string }`. When `pending` is set, `tree` is the tree the sub-session resolved.

**S1 (changed):** `handleMergeGate` returns `{ problem, pending: true, tree }` with the resolved tree (`orchestrate/index.ts:390`). This covers publish, where the workflow sends no tree. All other parts of S1 stay as they were.

**S2 (changed):**
- `acceptanceRefusal` (`hooks.ts:34-42`) returns `{ text, pending, tree } | null`, and `acceptanceProblem` passes it through. Update all three callers:
  - **`:3018` shell gate:** on `pending`, call `setAcceptanceWait(kind, tree ?? res.tree, dir)` and return `text`.
  - **`:2427` publish:** on `pending`, call `setAcceptanceWait("publish", tree, root)`, with `held` set to "Call publish_packages again with step <n>." Then reply with the text plus "Nothing published."
  - **`:2478` `git_task`:** uses only `text`. Its `pre` question is never pending.
- A pending answer without a tree is treated as a plain refusal with no wait.
- In `writeMyStatus`, add the new status fields **after** `judging:`, so `wiring.test.ts:24-26` still passes without changes.

The rest of S2 is unchanged.

**S3 (changed):** after an accepted verdict, the resume message names the retry for each kind:
- merge or protected push: "retry the merge/push as its own command"
- publish: "call publish_packages again with step <n>"

**S5 (changed: steps 2 and 5):**
- **Step 2, PR already merged:** first append a `merges.json` record with its `pr`, `mergeCommit` and tree. That makes the check in S6 confirm the merge. Then call `checkEnded(true, [id], false)`, so the package is never marked as forced.
- **Step 5, after a merge succeeds:** always append the `merges.json` record, and append the `accept-verdict` with `merged`. Then branch on the sub-session's status:
  - **In an acceptance wait** (`status.json.acceptance` is set): do **not** call `checkEnded`. The package stays registered while its flow resumes. After `flow-ended`, the normal end check marks it merged.
  - **Not running:** call `checkEnded(true, [id], force)`.

**S10 (changed):** add `-R <owner/name>` at `workflow/index.ts:2555, 4231, 4313` and at `workflow/merge-gate.ts:133`:
- `recordJudged` gets an optional `repo` option, the same way `gateCheck` does at `:72`.
- The workflow derives the repo from the `origin` URL once per repo root, and passes it to `recordJudged` and `gateCheck`.

**§6 (added):** besides the tests already listed, check that `orchestrate/wiring.test.ts` still passes after S4. If a source check there breaks because of moved code, update that check.

**§7 (added): manual checks for Stage 1.** These need a person. Run them on a throwaway run in a scratch repo with a GitHub remote.

1. **Refused merge keeps the flow open.** In a sub-session, run `gh pr merge` before acceptance.
   - Look for: the refusal says "Acceptance pending". `status.json` has `acceptance.tree`. No stage-end or steps-open menu appears after the turn ends.
   - Then run `orch_accept` with accept=true and look for: a "retry" message in the sub-session, and the retried merge succeeds.
2. **Protected push and publish also wait.** Push to a protected branch, or call `publish_packages` on a publish step, before acceptance.
   - Look for: the same wait, and `acceptance.kind` is `protected-push` or `publish` in the K4/`status.json`.
3. **Restart during the wait.** Close the sub-session while it waits. Accept in the orchestrator, then reopen the sub-session with `/flow resume`.
   - Look for: the resume message arrives without anything typed.
4. **Watcher fallback.** Let a sub-session's flow end while an accepted PR is still open.
   - Look for: the PR is merged on the next watcher round, `merges.json` has `pr` and `mergeCommit`, and the package is marked merged.
5. **`/orch merge` in the three cases:**
   - **During an acceptance wait:** the sub-session gets the "merged … start a new branch" message, and `/orch status` still shows the package as running.
   - **With a stopped sub-session and an unaccepted tree:** plain `/orch merge` is refused, and `--force` merges and records `forced`.
   - **With the PR already merged:** the package is marked merged, and not as forced.
   - **On a busy package:** the merge is refused with "still working".
6. **Bash guard.** In the orchestrator session, run `/orch off`, then let the model run `gh pr merge 1`.
   - Look for: it is refused with "use /orch merge".
7. **Worktree base.** Start a run whose target is `origin/<feature branch>`.
   - Look for: `git -C <wt> merge-base HEAD origin/<feature>` equals the target's tip when the run starts. `.pi-set.json` lists `base`. `/wt status` counts commits against that branch.
8. **PR lookup on any base.** Merge a package's PR into a branch that is not the target.
   - Look for: the merge check finds it, by head branch.
9. **gh calls name the repo.** In a repo that has an `upstream` remote, merge a PR from a flow.
   - Look for: the stage report shows the PR state from `origin`.

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 Make the merge gate report a pending acceptance. In `orchestrate/index.ts:386-401` (`handleMergeGate`):
- [ ] S2 Hold the flow while acceptance is pending (workflow).
- [ ] S3 Add the K15 listener (workflow). It acts only when `state.waiting?.waitKind === "acceptance"` and the tree matches. It c
- [ ] S4 Emit K15 and write the new status fields (orchestrate, in the sub-session).
- [ ] S5 Merge from the orchestrator (`orchestrate/index.ts`). Add `mergePackage(id, { force, auto, repo? })`.
- [ ] S6 Find merged PRs by head branch. In `checkSub` (`:1246-1290`):
- [ ] S7 Refuse `gh pr merge` in the orchestrator session. In the tool_call hook (`index.ts:631`), before the `mode === "off"` re
- [ ] S8 Worktree bases.
- [ ] S9 Targets in the orchestrator.
- [ ] S10 Name the repo in the workflow's gh calls. `gh pr view` at `workflow/index.ts:2555, 4235, 4309` passes `-R <owner/name>`,
- [ ] S11 Docs and backlog.
- [ ] S12 Add approval notes to `orch_review_plan` (`orchestrate/index.ts:1778-1810`).
- [ ] S13 Append the notes to the plan (workflow K10). In `hooks.ts:23-29`, `index.ts:3637-3640` and `approve` (`:800`): when ther
- [ ] S14 Hold messages during review.
- [ ] S15 Docs and backlog: K10 notes in both READMEs, and row A50 Done. The measure is plans per package, which should be 1-2.
- [ ] S16 Severity helpers in `shared/findings.ts`.
- [ ] S17 Minors become notes.
- [ ] S18 Fix code minors without a re-review.
- [ ] S19 Rechecks and late findings.
- [ ] S20 Define severity in `JUDGE`, the knowledge section (`:289-317`) and `JUDGE_PROPOSAL`.
- [ ] S21 Stale-list fix. Before any discussion review (`index.ts:3842-3870`, and the manual `/flow judge` path in `discussion-rev
- [ ] S22 Metrics. Add `judgeMetric` to `metrics.ts`, modelled on `:19`. Write a `judge` event where the code (`:2051`), plan (`~:
- [ ] S23 Docs and backlog: README gate rules (`workflow/README.md:148-161`), plus these rows, each Done:
- [ ] S24 The run charter.
- [ ] S25 The decision log.
- [ ] S26 Step back instead of escalating.
- [ ] S27 Prompts.
- [ ] S28 Docs and backlog: README, plus row A51 Done. The measure is escalations per run, which should be only reserved ones.
- [ ] S29 Judge cap on autopilot (`:4040-4058`).
- [ ] S30 Error retries. On autopilot, the first judge-error (`:4009`) or executor-error (`:3464`) in a row is retried automatical
- [ ] S31 Plan-judge `fix: user` findings. On autopilot, blocking `fix: user` findings go to the planner (`:3768-3781`) with `PLAN
- [ ] S32 Final card. `flow-report.ts` gains an "Autopilot decisions" section listing:
- [ ] S33 Docs and backlog: the README autopilot section (`:184`), plus row A52 Done. The measure is menus shown per flow on autop
