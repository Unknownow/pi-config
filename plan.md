<!-- pi-workflow plan v1 flow=20261023-1055-drop-the-forced-commit-step-the-executor-2460 -->
## Plan: Drop the forced commit step; the executor delivers itself, and merge and publish are judge-gated

### 1. Goal and non-goals

**Goal:**
- During execution, the executor commits, pushes to non-protected branches and opens pull requests freely.
- It merges, pushes to a protected branch and publishes only after a judge PASS on the exact tree being merged, pushed or published.
- It never hands delivery work to the user.
- It can delegate routine git work to a cheap `commit` subagent through a new `git_task` tool, which returns in the same turn.
- The workflow no longer runs a commit step after a PASS, and no longer asks about delivery at plan approval.

**Non-goals:**
- No change to the judge or arbiter prompts, plan approval apart from the delivery menu, the test runners and `test_run`, wait and verify, `tags.ts`, or the plan-store refs `refs/pi/plans/*`.
- No scripted, model-free commit step (backlog B10).
- No new kind of check beyond the tree check described below.

### 2. User decisions

- **D1:** Remove the forced commit step: `sendCommitStep`, `commitPending`, the commit handover, the delivery in `finishPassed`, and `delivery.runner`.
- **D2:** `git commit`, `git push` to a non-protected branch and `gh pr create` are free, with no judge needed.
- **D3:** `gh pr merge`, a push to a protected branch and `publish_packages` need a judge PASS on that exact tree. A commit after the pass that changes the tree needs another pass.
- **D4:** These bans stay: force or delete or mirror pushes, `+`/`:` refspecs, `--all`, `--no-verify`, `GIT_CONFIG_*`, hooksPath changes, `gh pr merge --admin`/`--auto`, `gh pr review --approve`, and the existing registry and `npm publish` refusals.
- **D5:** No delivery question at approval. Merge is allowed by default; a plan line `Delivery: no merge` turns merge, protected pushes and publish off for that flow.
- **D6:** A new `git_task` tool delegates commit, push, PR or merge work to the `commit` role, whose default becomes `claude-bridge/claude-haiku-5-5` with thinking `medium`. It returns in the same turn, runs under the same guard and gate, and failures come back to the executor.
- **D7:** No refusal text or prompt tells the executor to ask the user to push, open a PR, merge or publish. The only allowed hand-offs are failing CI, a required human review, and missing credentials or a missing registry token.
- **D8:** Drop the D16 refusals of commit-creating subcommands (`merge`, `pull`, `cherry-pick`, `revert`, `rebase`, `am`), apart from their `--no-verify` ban.
- **D9:** When `origin/<base>` has been merged into the branch, move the review base forward with an in-memory `git merge-tree`. If that fails, keep the base and add a focus note to the judge.
- **D10:** The review base is a per-flow local ref `refs/pi/review-base/<flowId>`. It is never pushed, it is deleted at flow end, and the plan-store prune removes leftovers.
- **D11:** In `docs/workflow-improvements.md`:
  - New rows A35 (this change) and D20 (D16 contradicts free commits).
  - A13 (its delivery modes), D14, D15 and B10 are marked superseded by A35; tags are unchanged.
  - B11 is marked implemented by `git_task`.
  - The Status line and the Effect-measurement rows are updated.

### 3. Facts the executor needs

**State and persistence (`index.ts`):**
- The state fields to remove: `commitPending` (`:139`), `judgedHeads` (`:183`) and `mergedHeads` (`:185`). Their persistence is at `:1172-1173`, `:1305-1306`, `:1401-1407`, `:1451-1452` and `:1683-1684`; the reset is at `:580-584` and `:1999`.
- `planDoc.flowId` is the flow id (`index.ts:155`).

**The execute guard and push-guard:**
- The execute `tool_call` guard is at `index.ts:2967-3000`. `modeOf` is at `:2994`, and `shellProblem` is called at `:2996`.
- `push-guard.ts`:
  - `PushContext` with its flags: `:15-27`.
  - `pushProblem`: `:38`. `ShellGuard`: `:48-57`. `shellProblem`: `:59-77`. `wordsProblem`: `:83-117`.
  - The D16 code: `COMMIT_CREATING`, `commitCreatingOnly`, `commitCreatingText` at `:120-147`.
  - `commitOnly`: `:149-153`. `pushOnly`: `:155-176`. `ghOnly` is further down.
  - The tests are run with `node --test push-guard.test.ts`.

**The commit-step machinery to remove:**
- `finishPassed`: `index.ts:4065-4096`. `sendCommitStep`: `:4099-4111`.
- `recordJudgedHeads`: around `:4115`. `publishAtEnd`/`publishJudged`: `:4190-4205`. `deliverSelfCommit`: `:4207-4280`.
- `runCommitSubagent`: `:4282-4310`. `commitInSubagent`: `:4312-4325`.
- `summarizeCommit`: `:3569-3611`. `readOutcome`: `:3559`. `repoOutcome`: `:3614`. `summarizePass`: `:3952-3987`. `committedDiffs`: `:3990`.
- `prepareDelivery`: `:3994`. `prepareAllRepos`: `:4025`.
- The callers on the agent-end path: `:3450`, `:3513`, `:3528`, `:3686`, `:3702-3708`, `:3759`, `:3931`.

**The delivery menu:**
- `defaultDelivery`/`menuDefault`: around `index.ts:714-730`.
- The approval menu: `index.ts:3376-3380`, using `deliveryChoices`, `deliveryMenuLabel` and `fixedDeliveryLabel`.
- The finalize prompt is given `DELIVERY_LABELS[state.delivery]` at `:687` and `:3270`.

**The `deliver` tool:**
- Registered at `index.ts:2755`. Its `mode` path is `:2807-2880`.
- `stageCheckpoints`: `:1069`. `deliverHintsText`: `:653`. The next-hint logic: `:673`.
- In `checkpoints.ts`: `modeAllowed` (`:6`), `parseDeliverStep`/`DeliverMode` (`:59-70`), `deliverHint` (`:73`), `deliverHintsBlock` (`:81`) and the publish route text (`:94-97`).

**Diffs and snapshots:**
- `collectDiff(cwd, base = "HEAD")` (`index.ts:817`) and `collectFlowDiff` (`:886-890`) already take a `base`.
- `collectRepoDiff` in `repo-diff.ts:46` covers tracked changes against `base` plus untracked files.
- `snapshotTree` (`index.ts:943`) and `snapshotRepos` (`:965-978`) give each repo's worktree tree and `HEAD`.
- `reviewPlan` (`:981-990`) compares `prev.base !== diff.base`.
- `state.passedDiff` is set at `:1053`, and `state.lastJudge` at `:1840`.
- `judge(ctx, diff, focus, …)`: `:1014`. The `judge` tool: `:2654`.

**Publishing:**
- `publish_packages`: `index.ts:2467-2490`.
- `runPublish` reads `state.mergedHeads` at `:2555-2558`.
- `readMergedItems`, `dryRunPublish` and `taggedOnOrigin` sit just above `runPublish`.

**Subagents, stages and the flow end:**
- `runSubagent(opts)`: `subagent.ts:198`. The guard extension is loaded through `extensions:` and `env:` (`index.ts:4300-4301`).
- `COMMIT_GUARD_EXTENSION` path: `index.ts:222`. `commit-guard.ts` is 73 lines; its spec parse is at `:26-45`.
- `startNextStage`: `index.ts:3470`. `endFlow`: `:429`. `summarizeFlow`/metrics: `:407-423`.
- `stageDelivery`: `stages.ts:57`. Stage headings with `(delivery: …)` are parsed in `stages.ts`.
- `agent-end.ts`: `minorFixOpen` (`:58-61`), `selfCommitted` (`:63-75`), `afterPass` (`:78-80`) and `handoverAction` (`:97-100`).
- The view stage `"commit"`: `view.ts:28` and `view.ts:81`. It stays, and is used while `git_task` runs.

**Config:**
- `config.ts`: the roles (`:17`), the `DeliveryConfig` docs (`:44-55`) and the default `commit` role (`:227`, Sonnet low).
- Delivery defaults: `:246`. `test.delivery`: `:106-107` and `:266`. Validation: `:352-355` and `:382`.
- `pi/agent/workflow.json`: `commit` is already haiku-5-5 medium (`:28-31`), `delivery` is at `:62-71`, and `test.delivery` is at `:111`.

**Plan store:**
- Plan refs are `refs/pi/plans/<flowId>` (`plan-store.ts:84`). Only that namespace is fetched (`:141`) and pushed (`pushRef`, `:131`).
- `deleteRef`: `:201`. The prune loop is `index.ts:1485` (`pruneIds`, with `keepDays`/`keepCount`), with ref deletion at `:1506`.

**Prompts:**
- `prompts.ts`: `planPhase` (`:28-56`), `finalize` (`:72-98`, with the stage delivery text at `:81`) and `EXECUTE_PHASE` (`:102-118`).
- In `EXECUTE_PHASE`, the bullet to replace starts "Never commit, push, or open or merge a pull request through your own shell"; the `Publish:` bullet stays.

**Docs:**
- `README.md` sections: "Hands-off run" (`:33`), "Wait points, checkpoints and tags" (`:152`) and "Several repos" (`:386`).
- `docs/workflow-improvements.md`: the highest IDs are A34, B14, C6 and D19. Its rules are under "Keeping this file current" (`:9-11`).

### 4. Design

**Components:**
- **`push-guard.ts`:** the pure, text-based guard.
  - It now permits commit, a non-protected push and `gh pr create`.
  - For `gh pr merge` and a protected push, it reports the action through `ShellGuard.gate`, which is async and returns `string | null`.
  - The D16 refusals are removed (D8).
- **`merge-gate.ts`** (new): decides whether a merge, protected push or publish is judged. It is pure, apart from the `git`/`gh` runners passed in.
- **`git-guard.ts`:** renamed from `commit-guard.ts`. The subagent-only extension that loads `shellProblem` and the gate from an env spec.
- **`index.ts`:**
  - The review base, passed trees and judged merges.
  - The gate wiring in the execute guard.
  - `stageDone`, which replaces the commit step.
  - The `git_task` tool; `deliver` keeps tags only; `publish_packages` reads `judgedMerges`.

**Contracts:**

The gate interface:
```ts
export type GateKind = "merge" | "protected-push" | "publish";
export interface GateFacts { noMerge: boolean; passedTrees: string[]; tree: string | null; diffNames?: string[]; what: string }
export function gateProblem(kind: GateKind, f: GateFacts): string | null;
export function noMerge(plan: string): boolean; // /^\s*(?:[-*]\s+)?Delivery:\s*no merge\b/im
```

The guard callback:
```ts
// ShellGuard (push-guard.ts) gains:
gate(kind: "merge" | "protected-push", root: string | undefined, target: string | undefined): Promise<string | null>;
```

- **Merge target:** for `gh pr merge`, `target` is its first positional argument (a PR number, URL or branch), or `undefined` for the current branch.
- **Protected-push source:** for a protected push, `target` is the source ref: the left side of `<src>:<dst>`, else the refspec itself, else `HEAD`.
- **Refusal wording:** `gateProblem` returns null when `tree` is in `passedTrees`. Otherwise it returns `"<what> is not judged: run judge, then retry"`, followed by `"; differs from the last passed tree in: a, b, c"` when `diffNames` has entries (at most 10 names, then `"…"`).
  - With `noMerge`: `"this plan says Delivery: no merge; <what> is not allowed"`.
  - Neither ever contains the word "user".
- **New state fields** (`FlowState`, persisted in `status.json`):
```ts
reviewBase?: Record<string, string>;      // repoKey -> commit sha the judge diffs from
passedTrees?: Record<string, string[]>;   // repoKey -> snapshot trees of every PASS this flow
judgedMerges?: Record<string, { pr?: string; commit?: string; tree: string }>;
```
- **Review-base ref:** `refs/pi/review-base/<flowId>`, one per repo, local only.
- **The `git_task` tool:** parameters `{ task: string; repo?: string }`. It returns text: the subagent's report, then lines `<repo>: branch <b>, <n> commits since review base, PR #<n> <STATE> <url>`.
- **The subagent guard env:** `PI_WORKFLOW_GIT_GUARD`, holding `{ roots: string[]; protectedBranches: string[]; passedTrees: Record<string,string[]>; noMerge: boolean }`.

**Review base:**
- **On entering execute:** for every flow repo, `reviewBase[key] = HEAD`. When a repo joins later (the edit hook at `index.ts:3061`, `/folders`), it gets its `HEAD` at that time.
- **Judge diffs:** every judge diff uses `collectRepoDiff(dir, reviewBase[key] ?? "HEAD")`. So `diff.base` becomes a per-repo value; for `reviewPlan` (`:987`), compare a joined `key=sha` string.
- **After a stage passes:**
  - Create `git commit-tree <passedTree> -p HEAD -m "workflow review base"`.
  - Write it to `refs/pi/review-base/<flowId>` with `git update-ref`.
  - Set `reviewBase[key]` to it.
  - On failure, keep the old base and show the warning `workflow: review base not moved (<reason>)`.
- **Merged-main check (D9), run per repo before every judge run:**
  - Let `<base>` be `cfg.delivery.base`, or `origin/HEAD`'s target, or `main`.
  - If `origin/<base>` is an ancestor of `HEAD` and not of `reviewBase`, run `git merge-tree --write-tree <reviewBase> origin/<base>`.
  - If it exits 0, its first output line is a tree: commit it with `commit-tree` (parent `reviewBase`), update the ref, and use it as the base.
  - If it exits non-zero (conflict, or git older than 2.38 with an unknown option), keep the base and append to the judge `focus`: `This diff includes changes merged from origin/<base>; review only this flow's changes.`
- **Flow end:** delete the ref in every repo.
- **Prune:** the plan-store prune at `index.ts:1485-1506` also deletes `refs/pi/review-base/<id>` for each pruned id, plus refs whose `<id>` has no local plan.
- **Resume:** a flow resumed from `status.json` reads `reviewBase` back. If a sha no longer resolves (`git cat-file -e`), fall back to `HEAD` with a warning.

**Passed trees:** on every PASS (where `passedDiff` is set, `:1053`), append each repo's snapshot tree from `lastJudge.repos` to `passedTrees[key]` (no duplicates). The list is cleared at flow end.

**The gate in the main session** (in the execute guard):
- **Merge:** run `gh pr view [<target>] --json headRefOid,state` in the repo, then `git rev-parse <oid>^{tree}`.
- **Protected push:** run `git rev-parse <source>^{tree}`.
- **Diff names:** `diffNames` is `git diff --name-only <last passed tree> <tree>`.
- **Failures:** if `gh` fails, refuse with `"cannot read the pull request (<stderr line>)"`. If `rev-parse` fails, `tree` is null and the result is a refusal.
- **Allowed:** record `judgedMerges[key] = { pr: target ?? <current branch>, tree }` for a merge, or `{ commit: <sha of source>, tree }` for a protected push.
- **Multi-repo:** the existing `repoTexts` grouping picks the root (`push-guard.ts:62`).

**Stage end (replaces the commit step):**
- `stageDone` runs at `agent_end` when all of these hold:
  - the last judge verdict is PASS;
  - the current snapshot trees equal the passed trees;
  - `afterPass(...) === "done"`;
  - no plan flaw is pending.
- **Open steps:** if the current stage has unticked, non-human checklist items, first send once per pass hash: `Open steps S5, S6: finish them (merge, publish), tick them with plan_check, then end your turn.` (`triggerTurn: true`). On the next `agent_end` with the same hash, run `stageDone` anyway.
- **What `stageDone` does:**
  - Builds the outcome per changed repo: `<root?>: <branch>, <n> commits since the review base` (`git rev-list --count <base>..HEAD`), plus `, PR #<n> <STATE> <url>` from `gh pr view --json number,state,url` when one exists. When `gh` fails, there is no PR part.
  - `ok` is true.
  - Then: in a test flow, start the retest (old `:3579-3583`). With stages left, `startNextStage` (honouring the `stageAdvance` logic of old `:3587-3600`). Otherwise `summarizeFlow` and `endFlow`.
  - It resets `minorRounds` and `minorSentFor`.
- **Knowledge unavailable at a pass:** only the notice `workflow: judge passed without the knowledge check: <reason>`. The askUser is removed.
- **Knowledge deviations:** if the knowledge check returned deviations, the PASS text the judge tool returns ends with `End the pull request body (or the last commit message if there is no pull request) with this block, unchanged:` and the `deviationBlock`.

**`git_task`:**
- Registered only for the execute phase.
- Calls `runSubagent` with role `commit`, the tools `bash` and `read`, extension `git-guard.ts`, and env `PI_WORKFLOW_GIT_GUARD`.
- The instruction is the task plus fixed rules:
  - Work only in the named repos.
  - Never force-push, use `--no-verify`, `--admin` or `--auto`.
  - Chain dependent steps with `&&`.
  - Stop at the first failure and report the command and its error.
  - Report each commit subject, branch and PR URL.
- The view stage is `commit` while it runs, then `execute`.
- After it ends, for each repo with a `gh pr view` result in state MERGED whose `headRefOid^{tree}` is in `passedTrees`, record `judgedMerges`.
- Errors, a timeout or an abort come back as the tool result text (`git_task failed: …`); there is no hand-off.
- Metrics use the existing subagent metrics (role `commit`).

**`publish_packages`:**
- If `noMerge` is set, refuse.
- Otherwise the head comes from `judgedMerges[key]`:
  - with `pr`: `gh pr view <pr> --json state,mergeCommit` must give `MERGED`, and the head is `mergeCommit.oid`;
  - with `commit`: `git branch -r --contains <commit>` must be non-empty, and the head is that commit.
- Otherwise refuse with `No judged merge is recorded for the unity-packages repo: merge the judged PR first (gh pr merge after a judge PASS). Nothing published.`
- The rest is unchanged: `readMergedItems`, the dry run, the waits.

**`deliver`:** only `tag` stays (create or move, the logic is unchanged). `mode` is removed from the parameters and the description. The description says commit, push, PR and merge are done with git, gh or `git_task`. `Deliver:` steps are plain checklist items: `deliverHint` and `deliverHintsBlock` no longer give `→ call deliver` hints for modes (tags only).

**Config compatibility:**
- Removed keys: `delivery.ask`, `delivery.default`, `delivery.runner` and `test.delivery`. `merge` drops them silently; `parseConfig` deletes them so they don't show in the loaded config.
- Kept as guidance in the prompts: `splitCommits`, `mergeMethod`, `deleteBranch`, `base` and `branchPrefix`.
- An old `status.json` carrying `commitPending`, `judgedHeads` or `mergedHeads` loads, and those fields are ignored.

**Failures:**
- `gh` is missing: merges are refused with the reason. CI fails or a review is required: the executor reports it (D7).
- A ref write fails: the warning above, and the review is bigger.
- `merge-tree` has a conflict: the focus note.
- A session crashes: the ref is left behind until the prune removes it.

**Scale:**
- A gate check costs 2–3 git or gh calls (under 2 s), only on merge, protected push or publish.
- The merged-main check costs 2 `merge-base --is-ancestor` calls per repo per judge run (about 50 ms each), plus one `merge-tree` only when `main` was merged in.
- `passedTrees` holds under 20 entries per repo per flow.
- The design stops working if a flow merges `main` repeatedly with conflicts. Then every review includes `main`'s changes, though the review is still correct.

**Rejected:**
- merge-base with `origin/main` as the base: it breaks stage isolation and needs a fetch every time.
- A scripted commit step: it keeps "only the workflow may push".
- Keeping the delivery picker: it's a stop on every flow.
- Keeping D16: it contradicts free commits and only adds refusals.
- A single shared `refs/workflow/review-base`: two flows in one repo would clash.

### 5. Steps

### Stage 1: Judge-gated self-delivery replaces the commit step

**S1.** `push-guard.ts`: rework the guard (D2, D4, D8).
- Change `PushContext` (`:15-27`): drop `pushAllowed`, `prAllowed`, `mergeAllowed` and `commitAllowed`.
- `commitOnly` (`:149`) refuses only `--no-verify` and `-n`.
- `pushOnly` (`:155-176`):
  - Keep every force, delete, mirror, `+`/`:` and `--all` refusal, and the detached-HEAD refusal.
  - Pushes to non-protected branches return null.
  - For protected destinations, and for a no-refspec push while on a protected branch, return a marker that `shellProblem` turns into a `gate("protected-push", root, source)` call. Source is the refspec's left side, the refspec itself, or `HEAD`.
- `ghOnly`:
  - `gh pr create` is allowed.
  - `gh pr merge` with `--admin`/`--auto` is still refused; otherwise it is marked for `gate("merge", root, firstPositional)`.
  - `gh pr review --approve` is still refused.
- Remove `COMMIT_CREATING`, `commitCreatingOnly` and `commitCreatingText` (`:120-147`). Keep a `--no-verify` refusal for those subcommands.
- Add pure exports `mergeTarget(args)` and `pushSource(refspec)`.
- `ShellGuard`: replace `modeOf` with `gate`. `shellProblem` awaits `gate` for the marked commands.
- Update the header comment (`:1-11`).
- Model the async flow on `branchOf` in `shellProblem` (`:59-77`).

**S2.** New `merge-gate.ts`: `gateProblem`, `noMerge` and the refusal texts exactly as in Design.
- Model it on `publish.ts` (pure decisions with text).
- `what` texts: `"merging pull request <target or 'of <branch>'>"`, `"pushing <source> to protected branch <dest>"` and `"publishing <packages>"`.

**S3.** `index.ts` state and the review base (D9, D10).
- Add `reviewBase`, `passedTrees` and `judgedMerges` to `FlowState` and persist them the way `judgedHeads` was (`:1305`, `:1683`).
- Remove `commitPending`, `judgedHeads`, `mergedHeads` and `delivery` from state and from persistence.
- Set `reviewBase` when entering execute (the `setPhase(ctx, "execute")` call sites at `:690`, `:1665`, `:3272`, `:3349`; do it in one helper) and when a repo joins (`:3061`).
- `collectDiff`/`collectFlowDiff` use the per-repo base, and `reviewPlan` compares the joined base string.
- Add the merged-main check and `merge-tree` move before each `judge(...)` call, in one helper `refreshReviewBase(ctx, refs) → focusNote | undefined`. Append the note to `focus`.
- Append to `passedTrees` where `passedDiff` is set (`:1053`).
- Delete the refs at flow end (`endFlow`, `:429`). Add the ref sweep to the prune at `:1485-1506`.
- The resume fallback is as in Design.

**S4.** `index.ts` execute guard (`:2967-3000`).
- Remove `modeOf`.
- Pass `gate`, which:
  - collects the facts as in Design (`gh pr view` or `git rev-parse` in that repo's dir);
  - calls `gateProblem` with `noMerge(state.approvedPlan)` and `passedTrees[key]`;
  - on allow, records `judgedMerges` and persists.
- Refusals still go through `publishRefuse`. Check that its wrapper text says nothing about the user or the commit step; if it does, reword it to `Refused: <problem>.`

**S5.** `agent-end.ts` and the agent-end path in `index.ts` (D1).
- In `agent-end.ts`:
  - `afterPass` returns `"fix" | "done"`.
  - `minorFixOpen(s: { summarized: boolean; sentFor?: string; hash: string })`.
  - `handoverAction` drops `commit` (an aborted run returns `"hold"`).
  - Remove `selfCommitted`.
- In `index.ts`, add `stageDone` and the open-steps nudge as in Design, and remove:
  - `finishPassed`, `sendCommitStep` and `commitInSubagent`;
  - `summarizeCommit`, `summarizePass`, `readOutcome` and `repoOutcome`;
  - `deliverSelfCommit`, `prepareDelivery` and `prepareAllRepos`;
  - `recordJudgedHeads`, `publishJudged`, `publishAtEnd` and `committedDiffs`.
- Rewire every caller listed in Facts to `stageDone`.
- Moving the review base after a stage pass (Design) happens in `stageDone` before `startNextStage`.
- Remove the knowledge askUser and put the notice in its place.
- Add the deviations text to the judge tool's PASS reply (`:2654-2690`).
- Keep `branchName` and `combineOutcomes` from `delivery.ts` if they are still used; delete what isn't.

**S6.** Remove the delivery menu (D5).
- The approval menu (`index.ts:3376-3380`) shows a single `Approve` entry. The arbiter, show and back entries stay.
- Remove `defaultDelivery`, `menuDefault`, `state.delivery` and every `stageDelivery` use.
- `stages.ts`: stage headings no longer parse `(delivery: …)`. Ignore it if present, so old plans still parse.
- `finalize(commits, delivery, staging)`: drop the `delivery` parameter and its call sites (`:687`, `:3270`).

**S7.** `deliver` (`index.ts:2755-2880`) keeps only `tag`.
- Remove `mode` from the parameters, the description and the code.
- The description becomes: `Create or move a tag on the remote default branch (tag), inside the plan. Commit, push, pull requests and merges are done with git and gh directly or with git_task.`
- `checkpoints.ts`:
  - Remove `modeAllowed` and the mode parsing.
  - `deliverHint` and `deliverHintsBlock` emit hints only for tag steps.
  - Remove the route text at `:94-97`.
  - `parseDeliverStep` still recognises `Deliver:` steps, so they show as checklist items.
- `index.ts:653-680`: follow the change.

**S8.** `publish_packages`/`runPublish` (`index.ts:2467`, `:2555`): the `noMerge` check, and the head from `judgedMerges` as in Design. Keep the rest.

**S9.** Config (D6).
- `config.ts`:
  - Remove `ask`, `default` and `runner` from `DeliveryConfig` and the defaults (`:246`), and `test.delivery` (`:106-107`, `:266`, `:382`).
  - `parseConfig` deletes those keys if present (`:352-355`).
  - The `commit` role default (`:227`) becomes `{ model: "claude-bridge/claude-haiku-5-5", thinking: "medium" }`.
- `pi/agent/workflow.json`: remove `delivery.ask`, `delivery.default`, `delivery.runner` and `test.delivery`.
- `delivery.ts`: remove `DELIVERIES`, the labels and the menu helpers once they are unused.

**S10.** `prompts.ts` (D7).
- In `EXECUTE_PHASE`, replace the "Never commit, push…" bullet with this text (its content must match; wording can be tightened):

  > Delivery is your job. Commit as you go (one commit per function when the plan has a Commits section), on a new branch `<branchPrefix><slug>` when you are on a protected branch. Push it and open the pull request with `gh pr create` (`--base <base>` when one is configured). Before merging, call `judge`. A merge, a push to a protected branch and `publish_packages` are refused until the exact tree has passed, so after any later change call `judge` again. Merge with `gh pr merge --<mergeMethod>` (plus `--delete-branch` when configured). Use `git_task` for routine commit, push, PR or merge work; it runs on a cheaper model and returns its report. If it fails, do the work yourself. Never ask the user to commit, push, open or merge a pull request, or publish. Stop and report only for failing CI, a required human review, or missing credentials.

- Fill the config values in from `cfg.delivery` through the phase-section builder (`:178`).
- `planPhase`/`finalize` (`:28-98`):
  - Drop the stage `(delivery: …)` text and the flow's delivery label.
  - Add: `Write a line "Delivery: no merge" only when the user asked not to merge.`
  - Keep `CHECKPOINTS`, but edit its text: `Deliver:` steps name what to publish, the executor publishes them with git, gh or `git_task`, and `deliver` is for tags.
- `delivery.ts`: delete the commit-step texts (`:76-130`) that are no longer used.

### Stage 2: The `git_task` tool, the subagent guard and the docs

**S11.** Rename `commit-guard.ts` to `git-guard.ts`.
- `GIT_GUARD_ENV = "PI_WORKFLOW_GIT_GUARD"`, with the spec shape from Design.
- `parseGuardSpec` validates it; a missing or invalid spec means every git or gh command is refused with `Refused: the git guard's settings are missing.`
- The `tool_call` handler runs `shellProblem`, with a `gate` that runs the same fact collection (via `child_process` git/gh in the subagent's cwd) and `gateProblem`, without recording.
- Share the fact collection: move it into `merge-gate.ts` as `async function gateFacts(run, kind, dir, target, passedTrees)`, where `run` is a git/gh runner. Both the main session and `git-guard.ts` call it.
- Update `COMMIT_GUARD_EXTENSION` (`index.ts:222`) to point at `git-guard.ts`.

**S12.** Register `git_task` in `index.ts`, next to `publish_packages`.
- Behaviour as in Design. Model it on the old `runCommitSubagent` (`:4282-4310`) and the `deliver` view-stage handling (`:2817-2829`).
- Only in the execute phase. Otherwise: `git_task works only while executing an approved plan. Nothing changed.`
- Add it to `OWN_TOOLS` if that set lists the workflow's tools.
- Add a `promptSnippet`: `git_task: delegate commit/push/PR/merge work to a cheap model; returns its report`.

**S13.** `README.md`: rewrite the parts about the commit step, the delivery menu and the checkpoint modes in "Hands-off run" (`:33`), "Wait points, checkpoints and tags" (`:152`) and "Several repos" (`:386`). Describe:
- the free commit, push and PR;
- the judge gate on merge, protected push and publish;
- `Delivery: no merge`;
- `git_task` and the `commit` role default;
- the review base, the merged-main behaviour and the `refs/pi/review-base/<flowId>` ref;
- the removed config keys.

**S14.** `docs/workflow-improvements.md` (D11):
- Add **A35** (this change) and **D20** (the D16 refusals contradict free commits), each with a **Done:** note naming the files.
- Edit **A13** (delivery modes superseded by A35; tags kept), **D14**, **D15** and **B10** (each `**Superseded:** by A35`) and **B11** (`**Done:** git_task, commit role haiku-5-5 medium`).
- Update the Status line.
- Effect-measurement rows:
  - A35: user hand-offs per flow (target zero), gate refusals per flow, and `commit` vs `execute` tokens from the D3 metrics.
  - D20: refusals of merge or pull (target zero).
  - Update the A13, D14, D15, B10 and B11 rows to match.

### 6. Tests

All suites are fast. Run them in `pi/agent/extensions/workflow`.

**`push-guard.test.ts`** (update):
- These are allowed: `git commit -m x`, `git push -u origin flow/x` on branch `flow/x`, `gh pr create --title t --body b`, `git pull`, `git merge origin/main`, `git rebase main`, `git cherry-pick abc`.
- `gh pr merge 12 --merge` calls `gate("merge", undefined, "12")`. A stub returning `"no"` gives the refusal `no`; a stub returning null allows it.
- `gh pr merge --merge` calls the gate with target `undefined`.
- `git push origin HEAD:main` calls `gate("protected-push", _, "HEAD")`. `git push` while on `main` calls the gate with `HEAD`. `git push origin feature:master` calls it with `feature`.
- Still refused: `git push --force`, `git push -f`, `git push origin +x`, `git push origin :x`, `git push --all`, `git commit --no-verify`, `git commit -n -m x`, `git merge --no-verify x`, `GIT_CONFIG_COUNT=1 git push`, `gh pr merge 1 --admin`, `gh pr merge 1 --auto`, `gh pr review 1 --approve`, `git -c core.hooksPath=x commit`.
- `mergeTarget(["merge", "12", "--merge"]) === "12"`. `pushSource("a:main") === "a"`. `pushSource("main") === "main"`.

**`merge-gate.test.ts`** (new):
- With `tree` in `passedTrees`, the result is null.
- With `tree` not in it and `diffNames` `["a.ts", "b.ts"]`, the result contains `run judge, then retry` and `a.ts, b.ts`, and does not match `/user/i`.
- With `tree` null, the result is a refusal.
- With `noMerge`, all three kinds are refused with `Delivery: no merge`.
- `noMerge("## Plan\nDelivery: no merge\n")` is true, and `noMerge("- Delivery: no merge")` is true. `noMerge("we do not merge here")` and `noMerge("Delivery: merge")` are false.
- `gateFacts`, with a stub runner that returns `headRefOid` `abc`, then tree `t1` for `abc^{tree}`, gives `tree: "t1"`. A `gh` failure gives a refusal text naming the stderr line.
- In a temp repo, review-base moves (S3), via an exported helper `mergedBase(run, dir, base, upstream)`:
  - Init a repo, commit on `main`, branch `flow/x`, commit `f.txt`, commit `g.txt` on `main`, merge `main` into `flow/x`. The helper returns a commit whose `git diff --name-only <it> HEAD` equals `["f.txt"]`.
  - When `main` and the branch conflict on the same line, it returns null.
  - This test is skipped if `git merge-tree --write-tree` is unsupported.

**`agent-end.test.ts`:** `afterPass(1, 0, 1) === "fix"` and `afterPass(0, 0, 1) === "done"`. `minorFixOpen` and `handoverAction` are updated to their new shapes (an aborted run gives `"hold"`). Remove the `selfCommitted` tests.

**`config.test.ts`:** a config with `delivery: { ask: true, default: "merge", runner: "main" }` and `test: { delivery: "commit" }` loads without error, and the loaded config has none of those keys. The default `roles.commit` is `{ model: "claude-bridge/claude-haiku-5-5", thinking: "medium" }`.

**`checkpoints.test.ts`:** a `Deliver: merge — x` step gives no `→ call deliver` hint, and a tag Deliver step still gives its hint. Remove the `modeAllowed` tests.

**`stages.test.ts`:** a heading `### Stage 1: A (delivery: push)` parses with title `A`, and no delivery field is used.

**`prompts.test.ts`:**
- `EXECUTE_PHASE` (or the built execute section) does not contain `Never commit, push`.
- It contains `git_task` and `call \`judge\``.
- It does not match `/ask the user to (push|merge|open)/i`.
- `finalize` has no `(delivery:` text.

**`registry-publish.test.ts`**, or the place where the publish refusal text lives: the missing-merge text equals the Design string.

**`git-guard.test.ts`** (new, replaces `commit-guard.test.ts`): `parseGuardSpec` round-trips a valid spec, and returns null for `undefined`, `"{}"` and non-array roots.

**`publish.test.ts` and `delivery.test.ts`:** delete the tests for the removed functions. Keep the tests of the functions that remain. Delete a file if nothing remains in it, together with its module.

**Plan store, in `plan-store.test.ts` or wherever the prune is tested:** the sweep deletes `refs/pi/review-base/<id>` for a pruned id. `pushRef`'s refspec names only `refs/pi/plans/<id>`, which shows the review base is never pushed.

**Commands:**
- Per file while fixing: `node --test <file>.test.ts`.
- Before each judge call: `node --test *.test.ts`. Expected: all pass, `fail 0`.
- If `pi/agent/extensions/workflow/tsconfig.json` exists, also run `npx tsc --noEmit -p .` (expected: no errors). Otherwise `node --test` loading every module is the type check.

### 7. Done when

- No code path starts a commit step after a PASS. `sendCommitStep`, `commitPending`, `finishPassed`, `delivery.runner` and the delivery menu are gone.
- During execution, `git commit`, a push to a non-protected branch, `gh pr create` and `git pull`/`git merge` are not refused.
- `gh pr merge` and a protected push are refused unless the target tree is in `passedTrees`, and always under `Delivery: no merge`. The refusal says to run `judge`, never to ask the user.
- `publish_packages` refuses without a judged, completed merge, and works after one.
- `git_task` runs the `commit` role (haiku-5-5 medium by default) under the same guard and gate, and returns in the same turn.
- The judge reviews from the review base. Commits don't change a passed diff. A merged `main` doesn't show up in the review when `merge-tree` succeeds.
- `refs/pi/review-base/<flowId>` is created and deleted per flow, swept by the prune, and never pushed.
- No prompt or refusal tells the executor to ask the user to commit, push, open or merge a PR, or publish.
- `node --test *.test.ts` passes.
- README and backlog are updated as in S13 and S14.

### 8. Risks, rollback, and what not to touch

**Risks:**
- Unjudged code reaches remote feature branches and open PRs (accepted in D2).
- A conflicted merge of `main` gives a bigger review diff, flagged by the focus note.
- A crashed flow leaves one small local ref until the prune removes it.
- The guard checks command text, so an executor that drifts could stage scratch files. The tree check then refuses the merge and lists the differing paths.
- `index.ts` is about 4900 lines. Removing the commit-step functions can leave callers dangling: after S5, grep for every removed name, and expect zero hits outside the deleted code.

**Rollback:** revert the stage merges. `status.json` files written by the new version load in the old one, which ignores the new fields. The old one then sees no `delivery` and uses its default.

**Don't touch:** judge and arbiter prompts, test runners and `test_run`, the wait and verify features, `tags.ts`, plan-store `refs/pi/plans/*`, the registry publish refusals (`push-guard.ts:241-262`) and the knowledge pass itself.

### 9. Commits

Stage 1:
- `feat(workflow): judge-gate merges and protected pushes; allow commit, push and PR during execution` — `push-guard.ts`, `push-guard.test.ts`, `merge-gate.ts`, `merge-gate.test.ts`
- `feat(workflow): review base per flow, passed trees and the merged-main base move` — `index.ts` (state, diff base, the `refreshReviewBase` helper, prune sweep), `merge-gate.ts` (`mergedBase`), `merge-gate.test.ts`, `plan-store.test.ts`
- `feat(workflow): end a stage at the judge pass instead of a commit step` — `index.ts` (`stageDone`, the removals, the execute guard wiring), `agent-end.ts`, `agent-end.test.ts`, `delivery.ts`, `delivery.test.ts`, `publish.ts`, `publish.test.ts`
- `feat(workflow): drop the delivery menu; Delivery: no merge plan line` — `index.ts` (approval), `stages.ts`, `stages.test.ts`, `config.ts`, `config.test.ts`, `pi/agent/workflow.json`
- `feat(workflow): deliver handles tags only; publish_packages needs a judged merge` — `index.ts` (`deliver`, `runPublish`), `checkpoints.ts`, `checkpoints.test.ts`, `registry-publish.ts`, `registry-publish.test.ts`
- `feat(workflow): execute prompt makes delivery the executor's job` — `prompts.ts`, `prompts.test.ts`

Stage 2:
- `feat(workflow): git_task delegates git work to the commit role under the git guard` — `git-guard.ts` (renamed from `commit-guard.ts`), `git-guard.test.ts` (replaces `commit-guard.test.ts`), `merge-gate.ts` (`gateFacts`), `index.ts`
- `docs(workflow): self-delivery, git_task and backlog rows A35 and D20` — `pi/agent/extensions/workflow/README.md`, `docs/workflow-improvements.md`

<!-- pi-workflow:status -->
## Checklist
- [x] S1 `push-guard.ts`: rework the guard (D2, D4, D8).
- [x] S2 New `merge-gate.ts`: `gateProblem`, `noMerge` and the refusal texts exactly as in Design.
- [x] S3 `index.ts` state and the review base (D9, D10).
- [x] S4 `index.ts` execute guard (`:2967-3000`).
- [x] S5 `agent-end.ts` and the agent-end path in `index.ts` (D1).
- [x] S6 Remove the delivery menu (D5).
- [x] S7 `deliver` (`index.ts:2755-2880`) keeps only `tag`.
- [x] S8 `publish_packages`/`runPublish` (`index.ts:2467`, `:2555`): the `noMerge` check, and the head from `judgedMerges` as in 
- [x] S9 Config (D6).
- [x] S10 `prompts.ts` (D7).
- [ ] S11 Rename `commit-guard.ts` to `git-guard.ts`.
- [ ] S12 Register `git_task` in `index.ts`, next to `publish_packages`.
- [ ] S13 `README.md`: rewrite the parts about the commit step, the delivery menu and the checkpoint modes in "Hands-off run" (`:3
- [ ] S14 `docs/workflow-improvements.md` (D11):
