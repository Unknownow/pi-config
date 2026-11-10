<!-- pi-workflow plan v1 flow=20261110-2252-stages-end-with-a-push-one-pull-request-c08e -->
## Plan: Stages end with a push; one pull request merged at the end of the flow; mid-flow merges only when planned or approved by the arbiter

**Goal:** a flow's work lands as one pull request, opened and merged at the end of the flow. A stage ends with a judge pass, a commit and a push. A merge before the end happens only at a `Deliver: merge` step you approved in the plan, or after the arbiter allows it through `request_merge`. When the arbiter can't decide, you are asked. The rule is enforced by the merge gate, not just by the prompt. Stages stay, but only to keep reviews small and give each part a fresh context.

**Non-goals:**
- No change to judge rounds, the review base, recheck or final-review logic, tags (`deliver`), `publish_packages`, or the arbiter that handles plan flaws.
- No whole-flow review at the end of the flow.

**Not staged:** the change is tightly coupled: the gate's refusal message points to `request_merge`. Also, this flow runs on the current extension, which would push for a merge at every stage end.

### User decisions
- **D1.** A stage end requires a judge pass plus commit and push. No pull request or merge is required at a stage end.
- **D2.** One pull request per flow, opened and merged by the executor at the end of the flow after the judge passes (unless `Delivery: no merge`).
- **D3.** Merges that should or must happen before the end are surfaced to you. Planned ones are `Deliver: merge` steps with a reason, listed in the plan under `Merge points:`. Unplanned ones go to an arbiter first.
- **D4.** The arbiter reviews an unplanned merge request and decides. If it decides (merge or no merge), the decision takes effect and you are told, not blocked. If it can't decide, you are asked.
- **D5.** The final pull request needs no extra judge run: the gate reuses the last pass on the same tree.
- **D6.** Stages stay, as a review and context boundary for large or dependent changes.

Two defaults I chose (you didn't answer these; say so if you want them different):
- An ASK_USER answer asks you even on autopilot.
- `stagedPlans: "onRequest"` is removed.

### Facts
- `prompts.ts:39` (`CHECKPOINTS`), `:41-47` (`planPhase`, the stage text and the `onRequest` branch), `:121` (the execute delivery bullet), `:187` (`ARBITER`, the plan-flaw arbiter prompt).
- `stages.ts:72-82`: `stageStart` says "deliver the stage yourself … (commit, push, pull request, merge)"; `nextStage` says "Stage N is delivered".
- `index.ts:2472`: on a PASS, the judge tool appends "Now deliver this exact tree: … merge it with gh pr merge".
- `index.ts:3538` `unmergedRepos` and `index.ts:3563` `stageDone`: every stage end reminds the executor to merge (`:3573-3580`).
- `index.ts:2681-2697`: the `gate` closure in the execute `tool_call` hook calls `gateCheck` for `merge` and `protected-push`.
- `index.ts:2245-2251`: the `git_task` `GitGuardSpec`. `git-guard.ts:15-45` holds the spec type and `parseGuardSpec`; its gate is at `git-guard.ts:66-72`.
- `index.ts:3424` `runArbiter`: the model for running the arbiter role (`runRole("arbiter", …)`, `view.finish`, `nextAmendmentNumber()`, `refreshChecklist`, `planMilestone`, `persist`). `parseArbiter` is at `agent-end.ts:218-237`.
- `index.ts:304` `askUser` (notifies, then `ctx.ui.select`). `index.ts:653` `currentStages()`. The open-step filter is at `index.ts:3572`.
- Tool registration model: `plan_check` at `index.ts:2404`. `FLOW_ONLY_TOOLS` is at `plan-tools.ts:24`.
- `checkpoints.ts:4` `parseDeliverStep(plan, id)` returns the text after `Deliver:`.
- `parseChecklist` gives amendment steps the stage of the last stage heading above them. So an approval must not be stored as a new step: it is stored as amendment text and parsed back.
- `config.ts:39,99,186,299`: `StagedPlans`. `pi/agent/workflow.json:49` sets `"stagedPlans": "auto"`. Tests use `planPhase("onRequest")` at `delivery.test.ts:31-40` and `prompts.test.ts:12,91`; `stages.test.ts:48` asserts the old stage text.
- Test command (from `README.md:232`): `node --experimental-strip-types --test <files>`.
- `docs/workflow-improvements.md`: the next free ID is **A40**. The Status line is at `:5`, the backlog rows are at `:60-69`, and the Effect measurement rows are at `:238-247`.

### Design
**When a merge (or protected push) is allowed before the end.** Pure function `midFlowMergeProblem(f)` in `merge-gate.ts`:

```ts
midFlowMergeProblem(f: { staged: boolean; current?: number; total?: number; openSteps: string[]; deliverMergeOpen: boolean; approved: boolean }): string | null
```

It returns null (allowed) when any of these holds:
- **(a) End of the flow:** the plan is unstaged or `current === total`, and `openSteps` is empty. `openSteps` holds the non-human unticked steps of the current stage, or of the whole plan when unstaged.
- **(b) Planned merge:** the current stage has an unticked `Deliver:` step whose text matches `/\bmerge\b/` and not `/\bno merge\b/`.
- **(c) Approved merge:** a merge approval exists for the current stage.

Otherwise it returns a refusal of this form:

> merging before the end of the flow is not planned (stage 1 of 3 / open steps S4, S5): push and continue, the pull request is merged at the end of the flow. Tick finished steps with plan_check; if a later step needs this merged now, call request_merge with the reason

The check runs after the existing `noMerge` check and before `gateCheck`. The judge-pass requirement is unchanged.

**Approvals and refusals are stored in the approved plan**, so they survive `/flow resume`. Each is one amendment:

```
## Amendment <n> (arbiter: merge)
Merge allowed in stage <k>: <reason, one line>
```

- The `<by>` part is `arbiter` or `user`.
- A refusal uses `(<by>: no merge)` and `Merge refused in stage <k>: …`.
- An unstaged plan writes `in this flow` instead of `in stage <k>`; it is parsed as stage 0 and applies to the whole flow.

Parser: `mergeDecisions(plan): { allowed: boolean; by: "arbiter" | "user"; stage: number; reason: string }[]`, in `checkpoints.ts`.

**The `request_merge` tool.** Execute phase only, and listed in `FLOW_ONLY_TOOLS`.

Parameters:
```ts
{ reason: string; repos?: string[] }
```

It goes through these checks in order:
1. If `midFlowMergeProblem` already returns null, it replies that the merge is allowed and why, and runs no arbiter.
2. If the user refused a merge in this stage, it replies that the merge is refused, with that reason, and asks no one.
3. If the arbiter refused a merge in this stage, it skips the arbiter and asks the user.
4. Otherwise it runs the arbiter role (label `merge`) with the new prompt `MERGE_ARBITER` and this context:
   - the plan (`planForJudge()`);
   - the stage line (`stage k of n: title`, or "no stages");
   - the open step IDs and text;
   - per flow repo: `git status --short` and `git log --oneline -20`;
   - the reason.

The arbiter answers `DECISION: MERGE | NO_MERGE | ASK_USER` and `Reason:`, parsed by `parseMergeArbiter` in `agent-end.ts`. Each answer leads to:

- **MERGE / NO_MERGE:** append the amendment, refresh the checklist, add a plan milestone and persist. Send a displayed chat message (`Arbiter: merge allowed|refused before the end of the flow`, then the reason) and a `ctx.ui.notify`. The tool reply:
  - allowed: "Merge allowed: <reason>. Run judge if the tree changed since the last pass, merge with gh pr merge as its own command, then continue on a new branch from the updated default branch."
  - refused: "No merge: <reason>. Keep committing and pushing to the branch and continue the plan."
- **ASK_USER, a failed run or no decision:**
  - With a UI: show the arbiter's view as a chat message, then call `askUser(ctx, "Merge before the end of the flow? <reason>", ["Allow the merge", "Don't merge"])`. This ignores autopilot. The answer is recorded as a `(user: …)` amendment, and a dismissed menu counts as "Don't merge".
  - Without a UI: record nothing and reply "no merge: nobody to ask; continue without merging".

**Rejected alternatives:**
- Pausing with `wait_for_user`: it needs a check command and a resume path. An in-tool menu is simpler and blocks the same way.
- Storing approvals as new `Deliver:` steps: amendment steps get the wrong stage (see Facts).

**Limits:**
- The open-steps rule depends on the executor ticking steps. A forgotten tick causes one refusal that names the steps.
- An approval allows any number of merges in that stage.

### Steps
**S1.** `prompts.ts:41-47` `planPhase`: remove the `staging` parameter and the `onRequest` branch. Always use the `STAGE_WHEN` and `STAGE_LIMITS` text, without "Also use them when the user asks for delivery in parts". Reword the stage paragraph:
- the workflow executes and judges a plan one stage at a time;
- each stage is reviewed on its own diff and starts with a fresh context;
- at a stage end the executor commits and pushes;
- the whole flow lands as one pull request, merged at the end.

Keep the heading format and the `Stages: 1. …` listing rule. Update `phaseSection` (`prompts.ts:134-136`) and its caller (`index.ts:2653`) to match.

**S2.** `prompts.ts:39` `CHECKPOINTS`: replace "to publish and then continue the same change; use a stage for a separate part" with a merge-points rule:
- Merges happen once, at the end of the flow.
- Add `**S<n>.** Deliver: merge — <why>` before the end only when a later step can't run until the change is on the default branch: a publish of the merged code, another repo or CI that reads the default branch, or a person who needs it there.
- List every such step in a `Merge points: S<n> (<why>), …` line right after the User decisions, so the user approves them with the plan.

Keep the rest of the rule as it is.

**S3.** `prompts.ts:121`, the execute delivery bullet:
- Commit and push as you go; a stage end needs a commit and a push, not a pull request or a merge.
- Open the pull request when you like, but merge only at the end of the flow (all steps ticked, after the final pass) or at a `Deliver: merge` step.
- If a later step really needs a merge earlier, call `request_merge` with the reason and follow its reply. Never merge around it.
- After a mid-flow merge, continue on a new branch from the updated default branch.

Add `MERGE_ARBITER` next to `ARBITER` (`prompts.ts:187`), modelled on it:
- **Rule:** the user wants one pull request at the end; a merge before that only when a later step can't be done without it.
- **Trust section:** same as `ARBITER`.
- **MERGE** when the plan or code shows such a step.
- **NO_MERGE** when pushing the branch is enough or the reason is convenience.
- **ASK_USER** when the reason depends on something it can't check, or the merge would touch a User decision.
- **Output:** `DECISION: MERGE | NO_MERGE | ASK_USER` and `Reason:` with 2-5 lines of evidence.

**S4.** `stages.ts:72-82`. `stageStart`:
- A non-last stage: once the judge passes, commit and push the stage (no merge: the pull request is merged at the end of the flow or at a planned `Deliver: merge` step), tick its steps and end the turn.
- The last stage: tick the steps, commit, push, open or update the pull request and merge it after the judge passes.

`nextStage` says "Stage N (…) is committed and pushed: <outcome>".

**S5.** `index.ts:2472`, the judge tool's PASS hint: use `midFlowMergeRefusal()` (S9).
- When a merge is allowed: keep the current "deliver this exact tree … merge" text, prefixed with "tick the finished steps with plan_check".
- Otherwise: "Now commit and push this exact tree to the flow branch (no merge: the pull request is merged at the end of the flow), tick the finished steps, then end your turn."

**S6.** `index.ts:3538-3580`, the `stageDone` / `unmergedRepos` reminder:
- Remind about an unmerged pull request only when a merge is due: unstaged or last stage, or the current stage has a `Deliver: merge` step.
- At other stage ends, remind about unpushed work instead: a changed repo with a remote whose worktree is dirty, has no upstream, or has commits ahead of `@{u}`. The reminder text: "Commit and push <repos>, then end your turn".

The classification is a pure helper `unpushedReason({ dirty, hasUpstream, ahead })` in `merge-gate.ts`, returning `"dirty" | "no upstream" | "ahead" | null`. It goes through the existing one-reminder-per-pass `stageEndAction`. When the flow ends, append the lines from `mergeDecisions(approvedPlan)` to the flow outcome text, as `mid-flow merge allowed|refused by <by> (stage k): <reason>`.

**S7.** `config.ts:39,99,186,299`: remove `StagedPlans` and `stagedPlans`; a leftover key in `workflow.json` is ignored. Remove `"stagedPlans": "auto"` from `pi/agent/workflow.json:49`.

**S8.** Add `isMergeDeliver(plan, id)`, `deliverMergeOpen(plan, checklist, stage)` (scoped like `deliverHintsBlock`, `checkpoints.ts:62`) and `mergeDecisions(plan)` (see Design) to `checkpoints.ts`. Add `mergeAmendment(n, { by, allowed, stage, reason })` next to `checkpointAmendment` (`checkpoints.ts:19`).

**S9.** In `merge-gate.ts`, add `midFlowMergeProblem` (Design). In `index.ts`, add `midFlowMergeRefusal(): string | null`. It collects:
- `currentStages()`;
- the open steps, using the filter from `index.ts:3572`;
- `deliverMergeOpen`;
- an approval in `mergeDecisions` for `state.stage ?? 0`, or for stage 0.

Call it in the `gate` closure (`index.ts:2681`) for both kinds, after the `noMerge` check. A refusal returns that text, and nothing is recorded in `judgedMerges`.

**S10.** `git-guard.ts`:
- `GitGuardSpec` gets an optional `midFlow?: string`.
- `parseGuardSpec` accepts a string there and rejects any other type.
- The guard's gate returns `spec.midFlow` when it is set and the call is not `ungated`.
- `index.ts:2245`: set `midFlow` from `midFlowMergeRefusal()` when the git task is gated.

**S11.** Add `parseMergeArbiter(text)` in `agent-end.ts`, modelled on `parseArbiter` (`agent-end.ts:225`). It returns `{ decision: "MERGE" | "NO_MERGE" | "ASK_USER"; reason: string } | null`. `NO_MERGE` must be matched before `MERGE`.

Register `request_merge` in `index.ts` next to `plan_check` (`index.ts:2404`), with the behaviour from the Design and the arbiter run modelled on `runArbiter` (`index.ts:3424-3445`). It refuses outside the execute phase with "only while a plan executes". Add it to `FLOW_ONLY_TOOLS` (`plan-tools.ts:24`).

**S12.** `README.md`:
- `:58-63`: stages as a review and context boundary; a stage end is commit and push; one pull request merged at the end. Remove the "stage's pull request is not merged → menu" sentence.
- `:96`: remove `stagedPlans`.
- Add a short "Mid-flow merges" paragraph covering `Merge points:`, `Deliver: merge`, `request_merge`, the arbiter decisions, the user prompt and the gate refusal.
- `:232`: no new test files, so the list stays.

**S13.** `docs/workflow-improvements.md`:
- New row A40: "A staged plan merged a pull request at every stage end (3 stages = 3 PRs, 3 CI waits). **Done:** stages end with a push; one PR merged at the end of the flow; mid-flow merges only at `Deliver: merge` steps or via `request_merge` (arbiter, then user); the gate enforces it (`merge-gate.ts`, `checkpoints.ts`, `stages.ts`, `prompts.ts`, `git-guard.ts`, `index.ts`); `stagedPlans` removed."
- Add A40 to the Status line.
- Effect measurement row: "PRs and merges per staged flow; `request_merge` calls and their decisions; gate refusals 'not planned'" → target "one PR per flow unless a merge point".

### Tests
New and changed tests:

| File | What it checks |
|---|---|
| `merge-gate.test.ts` | `midFlowMergeProblem`: allowed when unstaged with no open steps; refused when unstaged with S4 open (the text names S4 and `request_merge`); refused at stage 1 of 3 with nothing open; allowed at stage 3 of 3 with nothing open; allowed with `deliverMergeOpen`; allowed with `approved`. `unpushedReason` covers its four cases. |
| `checkpoints.test.ts` | `deliverMergeOpen` is scoped to the stage, ignores ticked steps, and treats `Deliver: tag v1` and `Deliver: push — no merge` as not merge steps. `mergeDecisions` reads `(arbiter: merge)` stage 2, `(user: no merge)`, and `in this flow` as stage 0. `mergeAmendment` round-trips through `mergeDecisions`. |
| `agent-end.test.ts` | `parseMergeArbiter` handles MERGE, NO_MERGE (not read as MERGE) and ASK_USER, extracts the reason, and returns null with no DECISION line. |
| `stages.test.ts:48` | Replace it: a non-last `stageStart` includes "commit and push" and "end of the flow" and not "pull request, merge". The last stage includes "merge it". |
| `prompts.test.ts`, `delivery.test.ts` | Drop the `onRequest` cases and call `planPhase()`. `planPhase()` includes "Propose stages yourself" and "Merge points" and doesn't include "delivered in parts". `MERGE_ARBITER` includes `DECISION: MERGE \| NO_MERGE \| ASK_USER`. The execute section includes `request_merge`. |
| `git-guard.test.ts` | `parseGuardSpec` keeps `midFlow` as a string, rejects a number, and returns no field when it is absent. |
| `config.test.ts` | A config with `"stagedPlans": "onRequest"` loads without error. |
| `plan-tools.test.ts` | `request_merge` is hidden in phase `off`. |

Command (fast, under a minute): `cd pi/agent/extensions/workflow && node --experimental-strip-types --test *.test.ts`. Expected: all pass, 0 failures.

**S14.** Verify: in a real staged flow (or the next one you run), check that stage 1 ends with a push and no PR merge, and that the final stage opens and merges one PR. Look for: no "merge the pull request" reminder before the last stage, and a `gh pr merge` before the end refused with the "not planned" text.

### Done when
- A non-last stage ends with commit and push, and no merge is asked for or done.
- The flow ends with one pull request, merged after the judge passes, with no extra judge run when the tree didn't change.
- A mid-flow `gh pr merge` or protected push is refused unless one of the gate's rules (a), (b) or (c) allows it. This holds in the executor's bash and in `git_task`.
- `request_merge` runs the arbiter. Its decision is recorded as an amendment, shown in chat and listed in the flow outcome. ASK_USER asks you even on autopilot.
- The planner prompt lists `Merge points:` and no longer mentions delivery in parts. `stagedPlans` is gone.
- All workflow tests pass, and the README and `docs/workflow-improvements.md` (A40) are updated.

### Risks, rollback, what not to touch
- **False refusal at the final merge** when steps aren't ticked. The refusal names them; the fix is one `plan_check` call.
- **`ctx.ui.select` inside a tool call:** if it fails, treat it as "Don't merge" and say so in the reply.
- **Rollback:** revert the two commits.
- **Don't touch:** `gateProblem`/`gateCheck` semantics, `recordJudged`, `advanceReviewBase`, the judge recheck logic, the plan-flaw arbiter flow, tags, `publish_packages`.

### Commits
1. `workflow: stages end with a push; one pull request merged at the end of the flow` (S1-S7, the S12-S13 parts for this commit): `prompts.ts`, `stages.ts`, `index.ts`, `config.ts`, `merge-gate.ts` (`unpushedReason`), `pi/agent/workflow.json`, `stages.test.ts`, `prompts.test.ts`, `delivery.test.ts`, `config.test.ts`, `merge-gate.test.ts`, `README.md`, `docs/workflow-improvements.md` (A40 added).
2. `workflow: mid-flow merges need a Deliver: merge step or request_merge (arbiter, then user)` (S8-S11, the rest of S12-S13): `merge-gate.ts`, `checkpoints.ts`, `agent-end.ts`, `git-guard.ts`, `plan-tools.ts`, `prompts.ts`, `index.ts`, their tests, `README.md`, `docs/workflow-improvements.md` (A40 finished).

Delivery: one pull request with both commits, merged after the judge passes.

## Amendment 1 (arbiter)
**S9a.** `index.ts` `midFlowMergeRefusal` (and the same open-step filter in `request_merge`'s position text, so the two agree):
- **What to change:** at the end of the flow (unstaged, or `staged.current === staged.stages.length`), build `openSteps` without the open steps that can only run after the final merge:
  - a `Deliver:` step that is not a merge (`parseDeliverStep(plan, id) !== null && !isMergeDeliver(plan, id)`);
  - a `Publish:` step (`parsePublishStep`, `registry-publish.ts:15`);
  - a `Mirror:` step (`parseMirrorStep`, `registry-publish.ts:24`).
- **Keep:**
  - Open work steps and `Wait:` steps still block.
  - Before the last stage, nothing changes.
- **Why:** these steps act on the merged code, so they can't be ticked before the merge.
- **Behaviour:**
  - Last stage, only `Deliver: tag v1` open → the merge is allowed.
  - Last stage, `S4` (a work step) and `Deliver: tag v1` open → refused, naming only `S4`.
  - Stage 1 of 3 → refused as before.
- **Do it in a pure helper:** `afterMergeStep(plan: string, id: string): boolean` in `checkpoints.ts`. It returns true for a non-merge `Deliver:`, a `Publish:` or a `Mirror:` step. `midFlowMergeRefusal` filters with it.

**S9b.** `index.ts` `stageDone`:
- **What to change:** when `mergeDue()` holds and every open step passes `afterMergeStep`, merge first. Keep the nudge's "Open steps … finish them" line, but put the unmerged-PR line ("merge the pull request") before it.
- **Why:** the executor should merge first, then run the tag, publish or mirror steps.
- **Behaviour:** with only after-merge steps open, the nudge lists the merge before those steps.

**Tests:**
- `checkpoints.test.ts`: `afterMergeStep` is true for `Deliver: tag v1`, `Publish: pkg` and `Mirror: all`. It is false for `Deliver: merge — x`, `Wait: … (check: …)` and a plain work step.
- `merge-gate.test.ts`: no change. The filtering happens before `midFlowMergeProblem`, so its contract stays the same.
- Command: `cd pi/agent/extensions/workflow && node --experimental-strip-types --test *.test.ts`. Expected: all pass.

<!-- pi-workflow:status -->
## Checklist
- [x] S1 `prompts.ts:41-47` `planPhase`: remove the `staging` parameter and the `onRequest` branch. Always use the `STAGE_WHEN` a
- [x] S2 `prompts.ts:39` `CHECKPOINTS`: replace "to publish and then continue the same change; use a stage for a separate part" w
- [x] S3 `prompts.ts:121`, the execute delivery bullet:
- [x] S4 `stages.ts:72-82`. `stageStart`:
- [x] S5 `index.ts:2472`, the judge tool's PASS hint: use `midFlowMergeRefusal()` (S9).
- [x] S6 `index.ts:3538-3580`, the `stageDone` / `unmergedRepos` reminder:
- [x] S7 `config.ts:39,99,186,299`: remove `StagedPlans` and `stagedPlans`; a leftover key in `workflow.json` is ignored. Remove 
- [x] S8 Add `isMergeDeliver(plan, id)`, `deliverMergeOpen(plan, checklist, stage)` (scoped like `deliverHintsBlock`, `checkpoint
- [x] S9 In `merge-gate.ts`, add `midFlowMergeProblem` (Design). In `index.ts`, add `midFlowMergeRefusal(): string | null`. It co
- [x] S10 `git-guard.ts`:
- [x] S11 Add `parseMergeArbiter(text)` in `agent-end.ts`, modelled on `parseArbiter` (`agent-end.ts:225`). It returns `{ decision
- [x] S12 `README.md`:
- [x] S13 `docs/workflow-improvements.md`:
## For you after the flow
- S14 Verify: in a real staged flow (or the next one you run), check that stage 1 ends with a push and no PR merge, and that t
