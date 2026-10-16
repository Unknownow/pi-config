<!-- pi-workflow plan v1 flow=20261016-0928-stop-the-executor-from-committing-and-de-9481 -->
## Plan: Stop the executor from committing, and deliver a commit it made anyway

**1. Goal and non-goals**
- Goal: a flow can no longer get stuck in EXECUTE because the executor committed the change itself. (a) While the executor runs, `git commit` is refused unless the workflow's own commit step is running. (b) If a commit still gets through, and the judge passed exactly the content that was committed, the workflow carries on with this flow's delivery (push, PR, merge) from that commit and ends the flow normally.
- Non-goals: don't block other commands that make commits (`merge`, `rebase`, `cherry-pick`, `revert`, `am`). Don't handle a partial self-commit, where uncommitted changes are left over; that keeps today's path. Don't handle a commit made before the judge passed. Don't change the commit subagent's guard rules, how delivery modes are chosen, or the `ctx_execute` JS-code refusal at `index.ts:1612`. Add no commands.

**2. User decisions**
- D1: Refuse `git commit` in the execute phase unless the workflow's own commit step is running (`state.commitPending` set in the main session, or the commit subagent).
- D2: If a self-commit gets through anyway (HEAD moved since the passing judge round, no diff left), carry on with delivery from the existing commit. A notice alone is not enough.
- D3: Add tests for both the guard and the recovery.
- D4: This flow's delivery is commit + push.

**3. Facts the executor needs**
- `push-guard.ts:12-22`: `PushContext` (`branch`, `protectedBranches`, `pushAllowed`, `prAllowed`, `mergeAllowed`).
- `push-guard.ts:55-71`: `shellProblem` builds `PushContext` from `g.modeOf(root)`. The flags are derived from `mode` at `:63-67`.
- `push-guard.ts:110`: routes `commit` to `commitOnly(g.rest)`. `:113-116`: `commitOnly` refuses only `--no-verify` / `-n`.
- `index.ts:1601-1636`: the execute-phase `tool_call` guard. `modeOf` (`:1631`) returns `state.commitPending`'s mode, or `undefined` when no commit step is pending. Refusal text is at `:1634`.
- `commit-guard.ts:63-70`: the commit subagent's guard calls `shellProblem` with `modeOf` from its spec. Its mode is always set (`commit|push|pr|merge`), from `index.ts:2563-2568`.
- `prompts.ts:83`: the executor rule "Never commit, push … a push of your own is refused".
- `index.ts:159-167`: `LastJudge`, whose `repos?: Record<repoKey, {tree, head}>` is the snapshot of the working tree and HEAD the judge reviewed. It is set at `index.ts:1371`. The tree comes from `snapshotTree` (`:743-757`: `add -A` + `write-tree`, so untracked files are included).
- `index.ts:828-835`: `judge()` → `markPassed(hash)` sets `state.passedDiff`.
- `index.ts:2166-2180`: `reviewDiff`. When there is no diff text and the call is not manual, it calls `noChangeTurn` for a staged plan, otherwise it returns silently. This is the stall.
- `index.ts:2182-2192`: the existing "already passed → `finishPassed`" path. Model the new path on it.
- `index.ts:2486-2541`: `finishPassed`. `chosen = stageDelivery(...)` at `:2488-2491`. It sets `committedDiffs`, sets `state.commitPending` (single at `:2517`, multi at `:2523-2529`), and its tail (`:2532-2541`) sets view.stage, calls `markPassSummarized`, `persist`, then `commitInSubagent` or `handover("workflow-commit", …)`.
- `index.ts:2462-2483`: `prepareDelivery`. Unsafe branch = empty / `HEAD` / protected. `prBefore` logic is at `:2476-2480`. It returns the current HEAD as `head`.
- `index.ts:2066-2108`: `summarizeCommit` reads `state.commitPending`, runs `repoOutcome(dir, mode, head, …)` (`:2111-2127`, which counts `head..branch`), then advances the stage or ends the flow.
- `index.ts:2427-2452`: `summarizePass`. `index.ts:2421`: `markPassSummarized`. `index.ts:2448`: `committedDiffs`.
- `index.ts:666`: `flowRepos(ctx): Promise<RepoRef[]>` (`{root, dir, changed}`). The single-repo check, `refs.length === 1 && refs[0].dir === ctx.cwd`, is at `index.ts:690`.
- `delivery.ts:43-56`: `DeliveryOptions`. `:58-69`: SPLIT/SINGLE/CHAIN/CHAIN_REMOTE/RULES. `:71-103`: `deliveryInstruction`. `:128-136`: `repoDeliveryInstruction` reuses it per repo.
- `agent-end.ts:59-61`: `minorFixOpen`, the pattern for a small pure decision helper that is tested in `agent-end.test.ts`.
- `README.md:73-81` (workflow): the push-guard description.
- Tests: `node --experimental-strip-types --test <files>` from `pi/agent/extensions/workflow` (README `:185`). Node v24.

**4. Design**
- Guard: `PushContext` gains `commitAllowed: boolean`, documented as "True only while the workflow's commit step runs". `shellProblem` sets it to `mode !== undefined`. `commitOnly` takes the context. It keeps the `--no-verify` check first, then returns exactly `"committing is the workflow's job; it commits after the judge passes"` when `!o.commitAllowed`. Callers pass nothing new: the main session's `modeOf` is `undefined` outside the commit step, and the subagent's is always set.
- Recovery decision, a pure function in `agent-end.ts`:
  ```ts
  export function selfCommitted(passed: string | undefined, judged: { hash: string; verdict: "PASS" | "FAIL"; repos?: Record<string, { tree: string; head: string }> } | undefined, now: Record<string, { head: string; tree: string }>, handled: boolean): boolean
  ```
  It is true only when all of these hold: `!handled`, `passed` is set, `judged.hash === passed`, `judged.verdict === "PASS"`, `judged.repos` is set and non-empty, every key of `judged.repos` exists in `now` with `now[k].tree === judged.repos[k].tree`, and at least one key has `now[k].head !== judged.repos[k].head`. Keys in `now` that are missing from `judged.repos` are ignored.
- Recovery action: a new `deliverSelfCommit(ctx): Promise<boolean>` in `index.ts`, next to `finishPassed`. It is called from `reviewDiff`'s no-diff, non-manual branch before the staged/`noChangeTurn` handling. If it returns true, `reviewDiff` returns.
  - Inputs: for each `flowRepos(ctx)` ref, key `repoKey(ref.root)`, `head = rev-parse HEAD`, `tree = rev-parse HEAD^{tree}`. A failed git call skips that repo, so `selfCommitted` then fails on the missing key. `handled = committedDiffs.has(hash) || summarizedPasses includes hash || !!state.commitPending`.
  - When true: `chosen` is computed as in `finishPassed`. If it is `"off"`, call `summarizePass(ctx, hash)` and return true. Otherwise `committedDiffs.add(hash)` and notify (info): `workflow: the executor committed the change itself; continuing with delivery`.
  - Per moved repo, i.e. one whose HEAD differs from the judged one:
    - Read the current branch. On an unsafe branch (empty, `HEAD`, or in `protectedBranches`) the mode becomes `"commit"`; if `chosen` was more than commit, warn `workflow[ tag]: the executor committed on <branch or "a detached HEAD"> itself; push and open the pull request by hand`. No new branch is ever created.
    - Otherwise mode = `chosen`, and for `pr`/`merge` set `prBefore` as at `index.ts:2476-2480`.
    - `head` is the **judged** head, not the current one, so `repoOutcome` counts the self-commits.
  - `state.commitPending`: single-repo shape when the flow has one repo matching the `:690` check, else the multi shape with only the moved repos (top-level fields from the first).
  - If every moved repo's mode is `"commit"`: `markPassSummarized(hash)`, `persist()`, `await summarizeCommit(ctx)`, return true. No step is sent.
  - Otherwise build the instruction with `committed: true` (below) through `deliveryInstruction` (single) or `repoDeliveryInstruction` (multi). The report is `**Judge: PASS**\n\n<state.lastJudge.text>`. Send it through the same tail as `finishPassed`. Extract that tail (`index.ts:2532-2541`) into a shared helper that both functions call, so there is one copy.
- `DeliveryOptions` gains `committed?: boolean`. When true, `deliveryInstruction` behaves as follows:
  - It starts with `The judge passed. The change is already committed on \`<branch>\`: don't commit again, and don't amend or rewrite those commits.`
  - It omits the `from` line, SPLIT/SINGLE, CHAIN and the deviations block.
  - The push / PR / merge parts, CHAIN_REMOTE (when mode ≠ commit) and RULES are unchanged.
  - `repoDeliveryInstruction` keeps working, since it strips only the leading `The judge passed.`.
- Failure handling: git errors in the inputs mean no recovery and today's behaviour. Delivery failures surface through the existing `summarizeCommit` outcome.
- Alternatives rejected:
  - A notice only (D2 rules it out).
  - Creating a PR branch from a self-commit on a protected branch: that leaves the local protected branch ahead of origin, which is risky to automate.
  - Comparing diff hashes after the commit: the hash covers the uncommitted diff text and can't be rebuilt reliably. Tree ids are exact.
- Scale: a few git calls per repo per agent_end with an empty diff. That is fine for any realistic number of flow repos (under 20).

**5. Steps**

### Stage 1: Refuse executor commits
**S1.** In `push-guard.ts`, add `commitAllowed` to `PushContext` (`:12-22`), set it in `shellProblem` (`:63-67`) as `mode !== undefined`, and make `commitOnly` (`:113`) refuse with the exact message from §4 when it is false. The `--no-verify` check still comes first. Update the file's header comment (`:1-8`) to mention commits.
**S2.** In `index.ts:1634`, change the refusal reason to: `Refused: ${problem}. Do not commit, push, open or merge pull requests, or skip hooks yourself: finish the code, get the judge's pass and end your turn; the workflow commits and delivers it as this flow's delivery says.`
**S3.** In `prompts.ts:83`, change "a push of your own is refused" to "a commit or push of your own is refused". Leave the rest of the line as it is.
**S4.** In the workflow `README.md:75-77`, add that a plain `git commit` is also refused while executing, unless it is the workflow's commit step.
**S5.** Tests for Stage 1 (§6 T1-T3).

### Stage 2: Deliver a self-commit
**S6.** In `agent-end.ts`, add `selfCommitted` with the exact signature and semantics from §4, modelled on `minorFixOpen` (`:59`).
**S7.** In `delivery.ts`, add `committed?: boolean` to `DeliveryOptions` (`:43-56`) with a doc comment, and implement the `committed` branch in `deliveryInstruction` (`:71-103`) as in §4.
**S8.** In `index.ts`, extract the tail of `finishPassed` (`:2532-2541`) into one helper used by `finishPassed` and the new function. Behaviour stays the same for `finishPassed`.
**S9.** In `index.ts`, add `deliverSelfCommit` next to `finishPassed`, as in §4.
**S10.** In `reviewDiff` (`index.ts:2173-2180`), in the no-diff, non-manual branch, call `deliverSelfCommit` first and return if it returns true. Otherwise keep the existing staged / silent behaviour.
**S11.** Tests for Stage 2 (§6 T4-T5).

**6. Tests** (run from `pi/agent/extensions/workflow`)
- T1, `push-guard.test.ts`:
  - Add `commitAllowed: false` to `feature`, and `commitAllowed: true` to a new context `committing = { ...feature, commitAllowed: true }`.
  - Move `git commit -m x`, `git commit -am 'fix: thing'` and `git commit -m 'set core.hooksPath on import'` from `fine` (`:71-72`, `:76`) to `refused` under `feature`, and add them to `fine` under `committing`.
  - The `--no-verify` / `-n` cases stay refused under `committing` too: add `["git commit -nm x", committing]` to `refused`.
  - Contexts derived from `feature` (`allowed`, `prOk`, …) inherit `commitAllowed: false`. Existing push and gh cases stay as they are.
- T2, `push-guard.test.ts`, new `shellProblem: commit needs the commit step`: `single()` → `git commit -m x` matches `/workflow's job; it commits/`. `single("commit")` and `single("push")` → `null`.
- T3: `commit-guard.test.ts` is unchanged and must pass.
- T4, `agent-end.test.ts`, new `selfCommitted only when the passed tree was committed`. With J = `{hash:"h", verdict:"PASS", repos:{a:{tree:"t1", head:"c1"}}}`:
  - `now {a:{head:"c2", tree:"t1"}}` → true.
  - Same head `c1` → false.
  - Tree `t2` → false.
  - `passed` "x" → false.
  - verdict FAIL → false.
  - `repos` undefined → false.
  - `handled` true → false.
  - Missing key `a` → false.
  - Two repos where one moved with the same tree and the other is unmoved with the same tree → true.
- T5, `delivery.test.ts`, new `committed delivery pushes without committing again`, using `deliveryInstruction({ ...base, mode: "pr", committed: true, deviations: "x" })`:
  - It includes `already committed on`, `don't commit again`, `gh pr create` and RULES' `Never force-push`.
  - It excludes SINGLE's `Commit exactly the reviewed changes`, CHAIN's `git add <paths> && git commit` and the deviations block.
  - With `mode: "commit"`: no `push`. `repoDeliveryInstruction` with a committed part: the section contains `already committed`.
- Command: `node --experimental-strip-types --test agent-end.test.ts readonly-bash.test.ts readonly-tools.test.ts tokens.test.ts push-guard.test.ts knowledge.test.ts mcp-forward.test.ts subagent.test.ts delivery.test.ts repos.test.ts stages.test.ts commit-guard.test.ts flow-report.test.ts gh-path.test.ts pickers.test.ts plan-doc.test.ts plan-store.test.ts`. Expect `fail 0`.
- Typecheck: the executor runs whatever check the repo already uses, if any. Otherwise the test run (strip-types) is the gate.

**7. Done when**
- In the execute phase, the executor's `git commit` (bash, PowerShell or batch) is refused with the new message. During the workflow's commit step (main session or subagent) it is allowed.
- After a passing judge, a self-commit of exactly the judged tree no longer stalls: delivery continues (push / PR / merge per the flow's delivery, never a second commit) and the flow ends with the normal report, or advances to the next stage.
- A self-commit on a protected branch or detached HEAD ends the flow as committed, with a warning to push by hand.
- All the tests in §6 pass.

**8. Risks, rollback, what not to touch**
- Risk: a plan step that legitimately asks the executor to commit is now refused. The prompt already forbade this.
- Risk: recovery on a partially matching tree. The exact tree-id equality prevents it.
- Rollback: revert the stage's commit. The stages are independent.
- Don't touch: the `commit-guard.ts` logic, `prepareDelivery`, `summarizeCommit` / `repoOutcome`, the plan-phase guard, or the JS `ctx_execute` refusal at `index.ts:1612`.
- Running pi sessions only pick up the change after `/flow reload` or a restart.

**9. Commits**
- Stage 1: `fix(workflow): refuse git commit while executing unless the commit step runs`, covering `push-guard.ts`, `push-guard.test.ts`, `index.ts`, `prompts.ts`, `README.md`.
- Stage 2: `fix(workflow): deliver a change the executor committed itself instead of stalling`, covering `agent-end.ts`, `agent-end.test.ts`, `delivery.ts`, `delivery.test.ts`, `index.ts`.

<!-- pi-workflow:status -->
## Checklist
- [x] S1 In `push-guard.ts`, add `commitAllowed` to `PushContext` (`:12-22`), set it in `shellProblem` (`:63-67`) as `mode !== un
- [x] S2 In `index.ts:1634`, change the refusal reason to: `Refused: ${problem}. Do not commit, push, open or merge pull requests
- [x] S3 In `prompts.ts:83`, change "a push of your own is refused" to "a commit or push of your own is refused". Leave the rest 
- [x] S4 In the workflow `README.md:75-77`, add that a plain `git commit` is also refused while executing, unless it is the workf
- [x] S5 Tests for Stage 1 (§6 T1-T3).
- [ ] S6 In `agent-end.ts`, add `selfCommitted` with the exact signature and semantics from §4, modelled on `minorFixOpen` (`:59`
- [ ] S7 In `delivery.ts`, add `committed?: boolean` to `DeliveryOptions` (`:43-56`) with a doc comment, and implement the `commi
- [ ] S8 In `index.ts`, extract the tail of `finishPassed` (`:2532-2541`) into one helper used by `finishPassed` and the new func
- [ ] S9 In `index.ts`, add `deliverSelfCommit` next to `finishPassed`, as in §4.
- [ ] S10 In `reviewDiff` (`index.ts:2173-2180`), in the no-diff, non-manual branch, call `deliverSelfCommit` first and return if 
- [ ] S11 Tests for Stage 2 (§6 T4-T5).
