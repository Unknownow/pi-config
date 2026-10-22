<!-- pi-workflow plan v1 flow=20261023-0004-the-workflow-extension-publishes-judged-3c38 -->
## Plan: The workflow extension publishes judged checkpoint commits, refuses commits no judge saw, and points the executor at `deliver`

### 1. Goal and non-goals
**Goal:**
- A later `deliver` with mode `push`, `pr` or `merge` publishes this flow's judged, already-committed work: commits made earlier by a commit checkpoint, in any flow repo. So does the end of the flow or stage. Neither says "no changes to deliver" while judged commits are unpublished.
- Commits the workflow's commit step did not make, and that are on no remote, are never published. `deliver` refuses them with a recovery hint. During execution the guard refuses git commands that create commits implicitly unless they are told not to commit.
- The executor always knows which `deliver` call to make at each Deliver step, and every publish refusal names it. The executor never asks the user to push, open or merge a pull request.

**Non-goals:**
- No second review path for commit ranges: no judging of `judged-head..HEAD`.
- No change to:
  - the commit subagent's permissions (`commitAllowed` contexts keep today's rules);
  - the plan-phase read-only rules;
  - protected-branch handling;
  - how the commit step creates new branches.
- The plan file on disk is never rewritten by the annotations.
- Already-committed work on a protected branch or detached HEAD is not moved to a new branch.

### 2. User decisions
- D1: Deliver in two stages. Stage 1 makes `deliver` and the flow end publish judged commits and closes the guard gap. Stage 2 adds the executor guidance.
- D2: Publishable work means the repo's `HEAD` is a head the workflow's commit step produced in this flow (recorded), possibly followed by commits that are already on a remote.
- D3: Commits after the recorded judged head that are on no remote are refused, with a `git reset --soft <judged head>` recovery hint. Judging the commit range was rejected.
- D4: Executor commits are not made publishable by any new path. The existing `deliverSelfCommit` case (the executor committed exactly the judged tree) stays as it is.
- D5: In the execute phase the guard refuses commit-creating git commands unless they are told not to commit: `merge`, `cherry-pick`, `revert`, `pull`, `rebase`, `am`.
- D6: The extension, not the planner, tells the executor which step uses `deliver`:
  - each open Deliver step is annotated with its exact call in what the executor is shown;
  - publish refusals name the next Deliver step's call.
- D7: Deliver steps are written `**S<n>.** Deliver: <mode> — <what>`. Plans contain no raw `git push`, `gh pr create`, `gh pr merge` or `git push --delete` commands. Merges in plans use `git merge --no-commit` and are concluded by a `Deliver: commit` step.
- D8: A `deliver` call keeps `mode` explicit. It does not inherit the mode from the step.
- D9: The executor is told never to ask the user to push, open or merge a PR, or to run a refused command for it.
- D10: `docs/workflow-improvements.md` gets new rows D15, D16 and D17 (done), and updates to the Status line and the Effect measurement table, in the same commits as the code.

### 3. Facts the executor needs
**Where "no changes" comes from**
- `collectFlowDiff` (`index.ts:815-839`) diffs against `HEAD`, so it sees only uncommitted changes.
- `deliver.execute` (`index.ts:2501-2610`):
  - "no changes to deliver" at `:2537`;
  - the judge is reused or run, then `prepareAllRepos` → `runCommitSubagent` → `readOutcome` (`:2566-2575`);
  - checkpoint recording at `:2596-2601`.
- At flow end with an empty diff, `reviewDiff` (`index.ts:3349-3367`) calls `deliverSelfCommit` (`:3781`), then `noChangeTurn` → `stageWithoutChanges` (`:3205-3222`) for staged plans, or `flowWithoutChanges` (`:3187-3202`) otherwise. Both end with `checkpointOutcome`.

**Models to copy**
- `deliverSelfCommit` (`index.ts:3781-3858`) builds `commitPending` and a `committed: true` instruction for repos whose head moved. Copy it for the new publish path:
  - per-repo `moved` entries `{ root, mode, head, branch, prBefore, pushSkipped }`;
  - `prState` for `pr`/`merge`;
  - the `options()` → `deliveryInstruction` / `repoDeliveryInstruction` construction;
  - `sendCommitStep`.
- `deliveryInstruction` (`delivery.ts:96-127`) with `committed: true` says "already committed on `<b>`: don't commit again" and then gives the push/PR/merge steps.
- `repoOutcome` (`index.ts:3288-3309`) returns null ("ended without a commit") when the head did not move unless the PR is MERGED. It counts commits as `head..rev` and checks `@{u}..rev`.
  - **Therefore the `head` passed in a publish pending must be the base before this flow's first commit on that repo, not the current HEAD.**
- `readOutcome` is at `index.ts:3235-3242`. `summarizeCommit` (`:3245`) reads the outcome, merges stage checkpoints, and advances the stage or ends the flow. `commitInSubagent` (`:3886-3898`) runs the subagent, then `summarizeCommit`.
- `prState(cwd, branch)` (`index.ts:3335`). `pushSkipReason` (`delivery.ts:91`). `landedBranch` (used at `index.ts:3294`). `cfg.protectedBranches`. `repoKey` from `repos.ts`.

**State**
- `FlowState` (`index.ts:111`); `checkpoints` at `:176`.
- Snapshot into status: `waitSnapshot` (`:1308-1313`), `PlanSnap` (`:1082`), writer at `:1213`. Restore at `:1585`. Reset in `setPhase` (`:545-553`).
- The status parser is `parseStatus` (`plan-doc.ts:211-232`), and `PlanStatus` (`plan-doc.ts:151-170`) declares `checkpoints`.

**Guard**
- `push-guard.ts`:
  - `PushContext` (`:12-24`), `pushProblem` (`:36`), `shellProblem` (`:57-74`);
  - `wordsProblem` (`:80-114`) returns null for every git subcommand except `push`, `commit` and hooks config (`:110`);
  - `commitOnly` (`:116-120`), `pushOnly` (`:122`);
  - helpers `isLong` and `shortHas` (`:26-31`).
- `gitSubcommand` comes from `readonly-bash.ts` and handles `git -C …` and `-c …`.
- Executor tool hook (`index.ts:2660-2692`):
  - for non-shell `ctx_execute` code there is a regex pre-check with fixed refusal texts (`:2669-2673`);
  - shell texts go through `shellProblem`, refused with the text at `:2691`;
  - `modeOf` is defined from `state.commitPending` (`:2688`).
- The commit subagent's guard is `commit-guard.ts:64`. It uses `shellProblem` with a mode, so `commitAllowed` is true there.

**Checkpoints, plan and prompts**
- `checkpoints.ts`: `modeAllowed` (`:7-11`) and `parseDeliverStep` (`:14-20`).
- `plan-doc.ts`: `ChecklistItem` (`:5-14`), `isHuman` (`:19`), `openStepsReminder` (`:102`), `planCard` (`:113`).
- The executor sees steps in:
  - `startExecution`'s returned text (`index.ts:582-599`), and the next stage's message from `stageStart`;
  - the `plan_check` reply (`index.ts:2330-2335`);
  - the judge reply reminder (`:2409`);
  - the `deliver` reminder (`:2547`).
- `deliver` tool description: `index.ts:2486-2487`.
- Prompts:
  - planner checkpoint rules `CHECKPOINTS` (`prompts.ts:25`);
  - finalize (`prompts.ts:58-66`);
  - executor rule on `deliver` (`prompts.ts:100`).
- When the final plan is accepted, `approve` is at `index.ts:608`. The plan text is in `state.approvedPlan`.

**Tests and docs**
- Tests: node tests next to each module, run per file with `node --test <file>.test.ts` (header comment in `push-guard.test.ts:1`). The guard fixtures are `feature`, `committing`, `allowed`, … (`push-guard.test.ts:8-13`).
- `docs/workflow-improvements.md`:
  - Status line at line 5; rules "Keeping this file current" at line 7;
  - D rows end at D14 (line 103); "Effect measurement" table from line 105.
- README: `pi/agent/extensions/workflow/README.md` "Push guard" (`:79-87`) and "Checkpoints" (`:170-174`).

### 4. Design
**4.1 Judged heads (state)**
- New `FlowState` field:
  ```ts
  judgedHeads?: Record<string, { base: string; head: string; branch: string }>; // key: repoKey(root)
  ```
  - `base` is `HEAD` before this flow's first commit-step commit in that repo. It is set once and kept on later updates.
  - `head` is the latest commit the workflow's commit step produced on `branch`.
- Written by a new `recordJudgedHeads(ctx, pending)` called after every commit step:
  - in `deliver` after `readOutcome` (`index.ts:2569`);
  - in `summarizeCommit` before `state.commitPending` is cleared (`:3246`).
- For each repo of `pending` (`pending.repos`, or the working folder with `pending.branch`/`pending.head`):
  1. Resolve the landed branch with `landedBranch`, as `repoOutcome` does.
  2. Read `rev-parse <branch>`. If it fails (branch deleted after a merge) or equals `pending.head`, skip the repo.
  3. Otherwise set `{ base: existing?.base ?? pending.head, head: <new sha>, branch }`.
- Persisted:
  - `waitSnapshot` and `PlanSnap` carry `judgedHeads`, and the status writer at `:1213` includes it;
  - `PlanStatus` and `parseStatus` accept it. Validation: an object whose values each have string `base`, `head` and `branch`; otherwise the status is rejected, like `checkpoints`;
  - restored next to `checkpoints` at `:1585`, and reset in `setPhase` next to `checkpoints = undefined`.
- An old `status.json` without the field is valid and means no judged heads.

**4.2 Publish decision (pure, new file `publish.ts`)**
```ts
export type PublishFacts = { repo: string; branch: string; head: string; judged?: { base: string; head: string; branch: string };
  foreign: string[]; hasUpstream: boolean; ahead: number; pr: { state: string } | null; protectedBranch: boolean };
export type PublishDecision =
  | { kind: "publish"; base: string; branch: string }
  | { kind: "nothing"; reason: string }
  | { kind: "refuse"; judgedHead: string; commits: string[] }
  | { kind: "not-judged" };
export function publishDecision(f: PublishFacts, mode: "push" | "pr" | "merge"): PublishDecision;
```
- `foreign` holds the one-line subjects (`<sha7> <subject>`) of `git rev-list HEAD --not <judged.head> --remotes` (at most 20).
- `ahead` is `rev-list --count @{u}..HEAD`, 0 without an upstream.
- `pr` is `prState(dir, branch)`, only fetched for `pr`/`merge`.
- Rules, in order:
  1. No `judged` → `not-judged`.
  2. `foreign` non-empty → `refuse`.
  3. Detached (`branch` empty or `"HEAD"`) or `protectedBranch` → `nothing`, with reason `pushSkipReason(branch)`.
  4. Otherwise `publish` when any of these hold:
     - no upstream;
     - `ahead > 0`;
     - mode is `pr` or `merge` and `pr` is null or CLOSED;
     - mode is `merge` and `pr` is OPEN.
  5. Otherwise `nothing`: "already published", or "pull request already merged" when `pr` is MERGED.
- `base` and `branch` come from `judged`, except that `branch` is the current branch.
- The refusal text is a pure helper in the same file:
  ```ts
  export function refuseText(root: string, d: { judgedHead: string; commits: string[] }): string;
  ```
  It must contain the repo's base name, each commit line, and the exact recovery: `git -C <root> reset --soft <judgedHead>`, then call `deliver` again so the judge reviews them and the commit step commits them. It also says to run the reset only on commits the executor made itself.

**4.3 Publishing from `deliver`**
- In `deliver.execute`, the empty-diff branch (`:2537`) only says "no changes to deliver" when `mode` is `commit`.
- For `push`, `pr` or `merge`, a new `publishJudged(ctx, mode)` gathers `PublishFacts` for every repo of `flowRepos(ctx)` in parallel, then decides per repo:
  - Any `refuse` → deliver nothing. Reply with every `refuseText` joined, plus "Nothing was delivered." Don't record a checkpoint.
  - Else, if any repo is `publish`:
    1. Build `commitPending` and the instruction like `deliverSelfCommit`: per repo `{ root, mode, head: decision.base, branch, prBefore, pushSkipped: undefined }`, with `prBefore` = a non-OPEN PR's number as there.
    2. Use `committed: true`, `split: false`, `cfg.delivery.mergeMethod`, `deleteBranch` and `base`.
    3. Use `repoDeliveryInstruction` when there is more than one flow repo or the only repo is not `ctx.cwd`; otherwise `deliveryInstruction`.
    4. Run `runCommitSubagent` and `readOutcome` with that pending, then `recordJudgedHeads`.
    5. Set `acted = true` and push the outcome text, as the existing branch does.
    6. Skip the judge and do not touch `committedDiffs` or `passedDiff`.
  - Else, reply "no changes to deliver", plus each `nothing` reason ("<repo>: already published", "<repo>: push skipped: main is protected").
- Mode cap, planned/amendment handling, tags and checkpoint recording stay as they are. A tag after a successful publish still runs.

**4.4 Publishing at the end of a flow or stage**
- In `flowWithoutChanges`, after the open-steps question passes, and at the start of `stageWithoutChanges`, call the same gatherer with the stage's delivery: `stageDelivery(state.delivery ?? defaultDelivery(), stage)`. Only do this when that delivery is `push`, `pr` or `merge`.
  - If any repo is `publish` and none is `refuse`: set `state.commitPending` to the publish pending and call `sendCommitStep(ctx, <stable key>, undefined, instruction, chosen)`, then return. The existing `commitInSubagent` → `summarizeCommit` path reports, merges the checkpoints and advances or ends. The key is a string such as `publish:<head shas joined>`, so `markPassSummarized` doesn't collide with a diff hash.
  - If any repo is `refuse`: don't publish. Append the refusal text to the outcome: `{ text: "<checkpoint outcome>; not delivered: <refusal>", ok: false }`, then continue the existing ending.
  - Otherwise continue unchanged.
- Double publishing can't happen. Once published, the decision returns `nothing`.

**4.5 Guard: commit-creating subcommands (`push-guard.ts`)**
- In `wordsProblem`, before the `push`/`commit` dispatch, route these subcommands to a new `commitCreatingOnly(sub, rest, o)`.

| sub | allowed when |
|---|---|
| `merge` | `--no-commit` or `--squash` present, or `--abort`/`--quit`; `--continue` only when `commitAllowed` |
| `cherry-pick`, `revert` | `-n`/`--no-commit`, or `--abort`/`--quit`/`--skip`; `--continue` only when `commitAllowed` |
| `pull` | `--ff-only`, or both `--no-commit` and `--no-rebase` |
| `rebase`, `am` | `--abort` or `--quit`; otherwise only when `commitAllowed` |

- When `commitAllowed` is true, all of them are allowed except with `--no-verify`, which is always refused for `merge`, `pull`, `cherry-pick`, `revert`, `rebase` and `am`.
- Refusal text format, tested:
  ```
  git <sub> creates a commit no judge has seen; use <flag hint>, and the workflow's commit step concludes it after the judge passes
  ```
  Flag hints: merge `--no-commit`, cherry-pick/revert `-n`, pull `--ff-only`, rebase/am "not during execution; ask in the plan".
- Use `isLong`/`shortHas` for abbreviations.
- `index.ts:2669`, non-shell `ctx_execute` pre-check: also refuse code matching `\bgit\b` together with `\b(merge|cherry-pick|revert|rebase|pull|am)\b`. Use the same text format, with sub = the matched word.

**4.6 Executor guidance (stage 2)**
- **Deliver-step parsing.** New in `checkpoints.ts`:
  ```ts
  export function deliverStepSpec(plan: string, id: string): { mode?: "commit" | "push" | "pr" | "merge"; tag: boolean } | null;
  ```
  - null when `parseDeliverStep` is null.
  - Explicit mode: the step text matches `^(commit|push|pr|merge)\s*(—|–|-|:|$)` (case-insensitive).
  - Otherwise inferred by keyword priority: `merge` > `pr`/"pull request" > `push` > `commit`.
  - `tag`: true when the text contains the word "tag". With `tag` true and no mode keyword, `mode` is undefined.
- **Hint.** New pure helper:
  ```ts
  export function deliverHint(id: string, spec: { mode?: string; tag: boolean }, cap: string): string;
  ```
  Outputs:
  - in cap: `→ call deliver {mode: "<mode>", step: "<id>"}`, plus `, tag: …` when `tag` is true (`→ call deliver {tag: …, step: "<id>"} as the step names it` when there is no mode);
  - beyond cap: `→ beyond this flow's delivery (<cap>): call deliver {mode: "<cap>", step: "<id>"} or ask the user`;
  - cap `off`: `→ delivery is off for this flow: skip it and say so`.
- **Annotation points**, each for open (not done, not human) Deliver steps of the current stage only:
  - `plan_check` reply lines (`index.ts:2335`): append the hint to the step's line;
  - `startExecution`'s returned text, and the next-stage message from `stageStart`: append a block `Deliver steps:\n- S15 → call deliver {…}` when there is at least one;
  - after the reminders at `:2409` and `:2547`: append the same block.
  - Build the block in one pure function in `checkpoints.ts`: `deliverHintsBlock(plan, checklist, stage, cap): string | undefined`.
- **Refusal texts.** New pure helper:
  ```ts
  export function publishRefusal(problem: string, next: { id: string; hint: string } | null, delivery: string): string;
  ```
  Output:
  - starts `Refused: <problem>.`;
  - with `next`: `To publish now, call <the hint's call> (the workflow's commit step pushes, opens and merges).`;
  - without: `When the work is done, end your turn: the workflow delivers it as <delivery> after the judge passes.`;
  - always ends with `Never ask the user to run it for you.`

  Use it for the three refusals at `index.ts:2670`, `:2672` and `:2691`. `next` is the first open Deliver step of the current stage. `delivery` is the stage's delivery label (`DELIVERY_LABELS`).
- **Prompts** (exact phrases tests may check):
  - `prompts.ts:100` gains: "Never ask the user to push, open or merge a pull request, or to run a refused git or gh command for you: `deliver` publishes, and the workflow delivers at the end."
  - `CHECKPOINTS` (`:25`) and finalize (`:58-66`) require `Deliver: <mode> — <what>` with mode commit, push, pr or merge.
  - They state: no `git push`, `gh pr create`, `gh pr merge` or `git push --delete` in a plan (the merge's `--delete-branch` removes the branch); a merge is written `git merge --no-commit` and concluded by a `Deliver: commit` step.
  - The `deliver` tool description (`index.ts:2486`) adds: "Already-committed judged work is published by a later push, pr or merge call."
- **Finalize warning.** New pure function in `checkpoints.ts`:
  ```ts
  export function deliverStepWarnings(plan: string, cap: string): string[];
  ```
  It returns one line per Deliver step whose explicit or inferred mode is beyond the cap, and per Deliver step whose text contains `git push`, `gh pr create`, `gh pr merge` or `push --delete`.
  - When the final plan is accepted for execution (where `startExecution` is called from approval), notify each line as a `warning`.
  - Never block.

**4.7 Scale and failure**
- Flows have 1–5 repos. The gatherer runs about 4 git calls plus 1 `gh pr view` per repo, in parallel: under 2 s per call on a normal repo.
- `rev-list --remotes` is bounded by the commit count since the judged head (tens).
- Git failures:
  - a failed `rev-list` or upstream read is treated as no upstream / `ahead = 0`;
  - a failed `rev-parse` of the judged head (it was garbage-collected) is treated as `not-judged`;
  - `gh` unavailable → `pr` null. The existing `ghReady` notice applies.
- The design stops working if a repo's branch is rebased or rewritten outside the commit step. Then `foreign` is non-empty and `deliver` refuses, which is intended.

**4.8 Rejected**
- Judging `judged-head..HEAD` (a second review path).
- Letting the executor commit.
- Inheriting the mode from the step (D8).
- Rewriting the plan file with hints.
- Moving already-committed protected-branch work to a new branch.

### 5. Steps

### Stage 1: Publish judged checkpoint commits and refuse commits no judge saw
**S1.** Add the `judgedHeads` field and persistence (4.1):
- `FlowState` (`index.ts:111`);
- `PlanSnap` (`:1082`), `waitSnapshot` (`:1308`), the status writer (`:1213`);
- restore at `:1585`, reset at `:552`;
- `PlanStatus` and `parseStatus` validation (`plan-doc.ts:151-232`), modelled on `checkpoints`.

Add `recordJudgedHeads` and call it at `index.ts:2569` (after `readOutcome`) and in `summarizeCommit` (`:3246`, before clearing). Model the landed-branch logic on `repoOutcome` (`:3290-3297`).

**S2.** Create `publish.ts` with `PublishFacts`, `PublishDecision`, `publishDecision` and `refuseText` (4.2). Pure, no git calls.

**S3.** Add `publishJudged`-style helpers in `index.ts`:
- a gatherer that builds `PublishFacts` per flow repo, using `git` and `prState`, protected from `cfg.protectedBranches`;
- a builder that turns `publish` decisions into `commitPending` plus an instruction, modelled on `deliverSelfCommit` (`:3803-3856`).

Wire them into `deliver` as in 4.3. Leave the `mode === "commit"` behaviour unchanged.

**S4.** Wire the end-of-flow/stage publishing into `flowWithoutChanges` (`:3187`) and `stageWithoutChanges` (`:3205`) as in 4.4.

**S5.** Extend `push-guard.ts` with `commitCreatingOnly` (4.5), routed from `wordsProblem`. Update the file's header comment. Extend the non-shell pre-check at `index.ts:2669`.

**S6.** README (`pi/agent/extensions/workflow/README.md`):
- "Push guard": the new subcommand rules and flags.
- "Checkpoints": a push/pr/merge `deliver` publishes already-committed judged work, foreign commits are refused with the reset hint, and the flow/stage end publishes leftovers.

**S7.** `docs/workflow-improvements.md`:
- New row **D15**: "A commit checkpoint's commits were never published by a later push/pr/merge `deliver` or by the flow end ('no changes to deliver')." Add a **Done:** note naming `publish.ts` and `index.ts`.
- New row **D16**: "git merge, cherry-pick, revert, pull, rebase and am could create commits no judge saw during execution." Add a **Done:** note naming `push-guard.ts`.
- Status line: add D15 and D16 to the implemented list.
- Effect measurement rows:
  - D15: share of flows with a commit checkpoint whose later push/PR/merge delivery completed. Implemented, not measured yet.
  - D16: guard refusals of commit-creating subcommands per flow.

**S8.** Run the stage-1 tests (section 6), fix failures, then run the judge.

### Stage 2: Point the executor at `deliver`
**S9.** Add `deliverStepSpec`, `deliverHint`, `deliverHintsBlock`, `publishRefusal` and `deliverStepWarnings` to `checkpoints.ts` (4.6), next to `parseDeliverStep`.

**S10.** Use the hints at the annotation points: `plan_check` (`index.ts:2335`), `startExecution` (`:582-599`) and the next-stage message (`stageStart`), and the reminders at `:2409` and `:2547`. The cap is the current stage's delivery.

**S11.** Replace the refusal texts at `index.ts:2670`, `:2672` and `:2691`, and the new stage-1 pre-check text, with `publishRefusal(…)`.

**S12.** Update the prompts: `prompts.ts:100`, `CHECKPOINTS` (`:25`), finalize (`:58-66`), and the `deliver` tool description (`index.ts:2486`), with the phrases in 4.6.

**S13.** Show `deliverStepWarnings` as `warning` notices when the final plan is accepted for execution.

**S14.** README "Checkpoints": the `Deliver: <mode> — <what>` form, the annotations, and the refusal guidance. In `docs/workflow-improvements.md`:
- New row **D17**: "The executor handed pushes to the user; plans spelled out raw publish commands and Deliver steps named no mode." Add a **Done:** note naming `checkpoints.ts`, `prompts.ts` and `index.ts`.
- Status line: add D17.
- Effect measurement row: executor turns that ask the user to push or open/merge a PR, counted from flow transcripts.

**S15.** Run all workflow tests (section 6), fix failures, then run the judge.

### 6. Tests
Run from `pi/agent/extensions/workflow` with `node --test <file>.test.ts`. Every suite is fast (seconds). Full run: `node --test *.test.ts` in bash. Expected result: all pass, 0 failures.

**Stage 1**
- `publish.test.ts` (new): `publishDecision` cases:
  - no judged → `not-judged`;
  - foreign commits → `refuse`, with the commits;
  - on `main` (protected) → `nothing`, reason "main is protected";
  - detached → `nothing`, "HEAD is detached";
  - no upstream, mode push → `publish` with judged `base`;
  - `ahead` 2 → `publish`;
  - up to date, PR OPEN, mode pr → `nothing` "already published";
  - up to date, PR OPEN, mode merge → `publish`;
  - up to date, no PR, mode pr → `publish`;
  - PR CLOSED, mode pr → `publish`;
  - PR MERGED, mode merge → `nothing` "pull request already merged".
- `publish.test.ts`: `refuseText` contains the repo base name, each commit line and `git -C <root> reset --soft <sha>`.
- `plan-doc.test.ts`: `parseStatus` accepts a valid `judgedHeads`, rejects one with a non-string `head`, and accepts a status without it.
- `push-guard.test.ts`, with `feature` (execute) and `committing` (commit step):
  - refused under `feature`: `git merge origin/main`, `git -C ../x merge main`, `git cherry-pick abc`, `git revert abc`, `git pull`, `git pull --rebase`, `git rebase main`, `git am p.patch`, `git merge --continue`, `bash -c "git merge main"`;
  - allowed under `feature`: `git merge --no-commit origin/main`, `git merge --squash x`, `git merge --abort`, `git cherry-pick -n abc`, `git revert --no-commit abc`, `git pull --ff-only`, `git pull --no-commit --no-rebase`, `git rebase --abort`, `git commit -m "merge main"` under `committing`;
  - under `committing`: `git merge --continue` and `git rebase main` are allowed; `git merge --no-verify x` is refused;
  - the refusal for `git merge main` contains "creates a commit no judge has seen" and "--no-commit".
- `commit-guard.test.ts`: unchanged and passing.

**Stage 2**
- `checkpoints.test.ts`, `deliverStepSpec`:
  - "pr — push and open the PR" → pr;
  - "push and open the PR" → pr (inferred);
  - "merge (D4)" → merge;
  - "push" → push;
  - "commit the LFS change" → commit;
  - "tag unity-build/v3" → tag true, mode undefined;
  - a non-Deliver step → null.
- `checkpoints.test.ts`, `deliverHint`: in-cap text `→ call deliver {mode: "pr", step: "S15"}`; a beyond-cap merge with cap pr; cap off.
- `checkpoints.test.ts`, `deliverHintsBlock`: only open, non-human Deliver steps of the given stage; undefined when there are none.
- `checkpoints.test.ts`, `publishRefusal`: with a next step it contains its call and "Never ask the user"; without one it contains "end your turn" and the delivery label.
- `checkpoints.test.ts`, `deliverStepWarnings`: flags a step containing `git push` and a mode beyond the cap; returns no lines for a clean plan.
- `prompts.test.ts`: the executor prompt contains "Never ask the user to push"; finalize/CHECKPOINTS contain "Deliver: <mode>" and "git merge --no-commit". Adjust existing assertions that quote the changed texts.

### 7. Done when
- After a commit checkpoint, `deliver` with `push`, `pr` or `merge` pushes, opens the PR or merges the judged commits in every flow repo that has them, without rerunning the judge. A flow or stage ending with no uncommitted changes publishes them per its delivery. Neither says "no changes to deliver" while judged commits are unpublished.
- Commits after a judged head that are on no remote are refused, by `deliver` and at flow end, with the repo, the commits and the `git reset --soft` recovery. Commit-creating git subcommands are refused during execution unless they are told not to commit.
- The executor sees `→ call deliver {mode: …, step: …}` for each open Deliver step. Every publish refusal names that call, or "end your turn", and says never to ask the user. The prompts require `Deliver: <mode> — …` and forbid raw publish commands.
- README and `docs/workflow-improvements.md` (D15, D16, D17, Status line, Effect measurement) are updated in the same commits as their code. All workflow node tests pass.

### 8. Risks, rollback, what not to touch
**Risks:**
- Skipping the judge relies on recorded heads produced only by the commit step (D2). Never record a head from anywhere else.
- Guard false positives (for example `git pull` in an unrelated repo): the refusal names the allowed flag, so recovery is one retry.
- The beyond-cap hint may surface plans with a wrong mode. That is a notice only.

**Rollback:** revert the stage's commits. Old `status.json` files stay valid because `judgedHeads` is optional.

**Don't touch:**
- `selfCommitted` and `deliverSelfCommit` semantics;
- the commit subagent's guard permissions, except the `--no-verify` addition;
- plan-phase rules (`readonly-bash.ts`, `readonly-tools.ts`);
- `deliveryInstruction` texts;
- protected-branch and new-branch logic in `prepareDelivery`.

### 9. Commits
1. "Publish judged checkpoint commits on a later push, PR or merge delivery": `publish.ts`, `publish.test.ts`, `index.ts`, `plan-doc.ts`, `plan-doc.test.ts`, README (Checkpoints part), `docs/workflow-improvements.md` (D15).
2. "Refuse git commands that create commits during execution": `push-guard.ts`, `push-guard.test.ts`, `index.ts` (pre-check), README (Push guard part), `docs/workflow-improvements.md` (D16).
3. "Point the executor at deliver: Deliver-step modes, hints and refusal texts": `checkpoints.ts`, `checkpoints.test.ts`, `index.ts`.
4. "Prompts: Deliver steps name their mode; never hand pushes to the user": `prompts.ts`, `prompts.test.ts`, `index.ts` (tool description), README (Checkpoints form), `docs/workflow-improvements.md` (D17).

## Amendment 1 (arbiter)
**S2 (amended).** `publish.ts`:
- Add two fields to `PublishFacts`:
  - `descends: boolean`: true when `HEAD` contains the judged head (`git merge-base --is-ancestor <judged.head> HEAD` exits 0);
  - `pr: PrState | null`: replaces `{ state: string } | null`, so `prBefore` can read `.number` with a correct type.
- Add a rule right after the `foreign` rule (rule 2): if `!descends` or `branch !== judged.branch`, return a new `{ kind: "moved"; judgedBranch: string; judgedHead: string }`.
- Add `movedText(root, d)`. It names the repo, the judged branch and head, and the recovery: `git -C <root> switch <judgedBranch>`, then call `deliver` again. In `publishJudged` and `publishAtEnd`, treat `moved` like `refuse`: nothing is delivered and the text is reported.
- Tests in `publish.test.ts`:
  - `descends: false` → `moved`;
  - a branch other than `judged.branch` → `moved`;
  - `movedText` contains the repo name, the judged branch and the `switch` command.

**S3 (amended).** In `index.ts`, the gatherer fills `descends` (a failed git call counts as false) and `pr` as a `PrState`. Then extend `deliver`'s non-empty-diff path for `push`, `pr` and `merge`:
- Run `publishJudged` for the judged repos that are not among `diff.repos` with `changed`.
- If any of them is `refuse` or `moved`, deliver nothing. Reply with the texts and "Nothing was delivered", before the judge runs.
- Otherwise merge their `publish` entries into the pending record from `prepareAllRepos`: add them to `pending.repos`, with `head` = the judged `base`. Use `repoDeliveryInstruction` with `committed: true` for those repos. One commit step then delivers both kinds of repo. `recordJudgedHeads` already runs on the merged pending.
- Test: a pure helper that merges publish entries into a pending record and instruction gets a unit test. The case: one changed repo and one judged repo give two `repos` entries, and the judged entry has `committed: true` wording.

**S4 (amended).** At the end of a flow or stage with a non-empty diff, apply the same merge where the end-of-flow commit step builds its pending record from `prepareAllRepos`. Use the stage's delivery, and only when it is `push`, `pr` or `merge`. A `refuse` or `moved` result does not block delivering the changed repos. Its text is appended to the outcome as `not delivered: …` with `ok: false`, as in 4.4.

<!-- pi-workflow:status -->
## Checklist
- [x] S1 Add the `judgedHeads` field and persistence (4.1):
- [x] S2 Create `publish.ts` with `PublishFacts`, `PublishDecision`, `publishDecision` and `refuseText` (4.2). Pure, no git calls
- [x] S3 Add `publishJudged`-style helpers in `index.ts`:
- [x] S4 Wire the end-of-flow/stage publishing into `flowWithoutChanges` (`:3187`) and `stageWithoutChanges` (`:3205`) as in 4.4.
- [x] S5 Extend `push-guard.ts` with `commitCreatingOnly` (4.5), routed from `wordsProblem`. Update the file's header comment. Ex
- [x] S6 README (`pi/agent/extensions/workflow/README.md`):
- [x] S7 `docs/workflow-improvements.md`:
- [x] S8 Run the stage-1 tests (section 6), fix failures, then run the judge.
- [ ] S9 Add `deliverStepSpec`, `deliverHint`, `deliverHintsBlock`, `publishRefusal` and `deliverStepWarnings` to `checkpoints.ts
- [ ] S10 Use the hints at the annotation points: `plan_check` (`index.ts:2335`), `startExecution` (`:582-599`) and the next-stage
- [ ] S11 Replace the refusal texts at `index.ts:2670`, `:2672` and `:2691`, and the new stage-1 pre-check text, with `publishRefu
- [ ] S12 Update the prompts: `prompts.ts:100`, `CHECKPOINTS` (`:25`), finalize (`:58-66`), and the `deliver` tool description (`i
- [ ] S13 Show `deliverStepWarnings` as `warning` notices when the final plan is accepted for execution.
- [ ] S14 README "Checkpoints": the `Deliver: <mode> — <what>` form, the annotations, and the refusal guidance. In `docs/workflow-
- [ ] S15 Run all workflow tests (section 6), fix failures, then run the judge.
