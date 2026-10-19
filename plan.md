<!-- pi-workflow plan v1 flow=20261019-1208-a7-b1-and-d5-from-the-workflow-backlog-2807 -->
## Plan: A7, B1 and D5 from the workflow backlog

### 1. Goal and non-goals
**Goal:** implement these three items from `docs/workflow-improvements.md`:
- **A7:** the `explore` tool runs up to 8 queries at once, not two waves of 4.
- **B1:** today a large re-review that passes gets one more full review. Now it gets that full review only when the changes since the last round touched a file the last round's findings did not cite. The config switch `judge.finalFullReviewNewFilesOnly` (`false`) restores today's behaviour.
- **D5:** a `push` delivery on a protected branch or a detached HEAD falls back to commit only. The commit instruction and the flow's final report now give the reason.

**Non-goals:**
- No other backlog item.
- No changes to the judge prompts, the recheck/full decision in `reviewPlan`, the push guard, the `protectedBranches` list, or how `pr`/`merge` mode handles a protected branch (new branch, unchanged).
- No changes outside `pi/agent/extensions/workflow/`, `pi/agent/workflow.json` and `docs/workflow-improvements.md`.

### 2. User decisions
- D1: Implement D5, A7 and B1 first, out of the open low- and medium-risk backlog items.
- D2: B1 is behind the config key `judge.finalFullReviewNewFilesOnly`, default `true` (the new behaviour). `false` gives today's behaviour. The plan proposed this and the user approved it.

### 3. Facts the executor needs
Paths are relative to `pi/agent/extensions/workflow/` unless stated.

**Explore concurrency (A7):**
- `config.ts:189` has the default `explore: { maxQueries: 8, concurrency: 4, ... }`.
- `pi/agent/workflow.json:92-93` overrides it with `"concurrency": 4`.
- It is used at `index.ts:1430` (`mapLimit(queries, cfg.explore.concurrency, ...)`).

**Judge config and the final full review (B1):**
- The judge config type is at `config.ts:132-143`, where `finalFullReviewOverChars` (`:142`) has a doc comment. The defaults are at `config.ts:192-199`.
- `merge` (`config.ts:221`) deep-merges user JSON over the defaults, so a new key needs no loader change.
- The final full review sits in `judge()` at `index.ts:793-798`:
  - `limit = cfg.judge.finalFullReviewOverChars`
  - `if (r.verdict === "PASS" && plan.kind === "recheck" && limit > 0 && diff.chars > limit)` runs `judgeOnce` with `{ kind: "full", snaps: plan.snaps }`.
- The `recheck` plan type is at `index.ts:730`: `{ kind: "recheck"; snaps; prev: LastJudge; delta: string; changed: string[] }`.
  - `prev.text` is the previous round's judge text with its findings.
  - `changed` is the repo-relative paths changed since that round, from `git diff --name-only`, without deleted files (`index.ts:763-775`).
- Judge findings use the format `path:line - severity - ...` (for example `pi/agent/extensions/worktree/progress.ts:109 - minor - ...`).

**Pure modules and their tests:**
- `repo-diff.ts` is pure. It exports `collectRepoDiff` and the types. `index.ts:58` imports it as `import { collectRepoDiff as collectRepoDiffImpl, type RepoDiff } from "./repo-diff.ts";`. Its tests are in `repo-diff.test.ts`.
- `delivery.ts` holds the pure delivery text and decisions:
  - `DeliveryOptions` is at `:44-60`.
  - `deliveryInstruction(o)` is at `:73`. The push sentence is added only when `o.mode !== "commit"` (`:79-85`).
  - `deliveryOutcome(mode, commits, pushed, pr, prUnknown = false)` is at `:119`. `commit` mode returns `{ text: \`committed${n}\`, ok: true }`.
  - The tests are in `delivery.test.ts`. The outcome tests are at `:85-101` and `:183-187`.

**Delivery wiring in `index.ts` (D5):**
- `index.ts:122`: `commitPending?: { mode; head; branch?; prBefore?; repos?: { root; mode; head; branch?; prBefore? }[] }`.
- `prepareDelivery` (`index.ts:2473-2498`): `unsafe = !current || current === "HEAD" || cfg.protectedBranches.includes(current)`. `unsafe && mode === "push"` sets `mode = "commit"` and only shows a notify. It returns `{ mode, branch, from, base, prBefore, head }`.
- `finishPassed` (`index.ts:2519-2546`):
  - `options(p)` builds `DeliveryOptions`.
  - The single-repo `state.commitPending = {...}` is at `:2532`.
  - The multi-repo `state.commitPending` is at `:2538-2544`, including the `repos` map.
- `deliverSelfCommit` (`index.ts:2594-2615`):
  - When `unsafe`, it sets `mode = "commit"` and warns if `chosen !== "commit"`.
  - `moved` is typed at `:2591`.
  - `commitPending` is built at `:2612-2614`.
  - When every repo is `commit`, it calls `summarizeCommit` directly (`:2615-2619`).
- `summarizeCommit` (`index.ts:2082-2093`) calls `repoOutcome(...)` at `:2089` (per repo) and `:2092` (single). `repoOutcome` is at `:2124` and returns `deliveryOutcome(mode, commits, pushed, pr, !ghOk)` at `:2138`.

**Docs:**
- The workflow `README.md`:
  - The Delivery paragraph is at `:63-72`; the sentence about a protected branch in `pr`/`merge` mode is at `:67-69`.
  - The final full review sentence is at `:92-94`.
- In `docs/workflow-improvements.md`:
  - the Status line is at `:5`;
  - the A7 row is at `:37`, the B1 row at `:45` and the D5 row in section D;
  - the measurement rows for A7, B1 and D5 are in "Effect measurement";
  - the pipeline recap at `:25` says "concurrency 4".
  - The rules for keeping it current are at `:7-11`.

### 4. Design
**B1, `uncitedFiles` in `repo-diff.ts`:**
- Contract: `export function uncitedFiles(findings: string, changed: string[]): string[]`.
- It returns the entries of `changed` (same order, same strings) that the findings text does not cite.
- A name counts as cited when the findings text contains that name directly followed by `:` and a digit. Before matching, replace every `\` with `/` in both the text and the name.
- Matching is a plain substring with regex special characters escaped. So `a/b.ts:12`, `repo/a/b.ts:12` and `D:/x/repo/a/b.ts:12` all cite `a/b.ts`.
- Empty findings return all of `changed`, and an empty `changed` returns `[]`.
- When in doubt, a file counts as uncited, which keeps today's full review.

**B1, config:**
- `config.ts` judge type: add `finalFullReviewNewFilesOnly: boolean` with the doc comment `/** The final full review runs only when the changes since the last round touched a file its findings did not cite. */`.
- Default `true`. `pi/agent/workflow.json` is not changed for this key.

**B1, gate in `judge()` (`index.ts:795`):**
- The existing condition also requires `!cfg.judge.finalFullReviewNewFilesOnly || uncitedFiles(plan.prev.text, plan.changed).length > 0`.
- Nothing else changes. When the review is skipped, `r` is the re-review's result as is.

**A7:**
- Change `explore.concurrency` from 4 to 8 in `config.ts:189` and `pi/agent/workflow.json`. `maxQueries` stays 8.

**D5, `delivery.ts`:**
- `DeliveryOptions` gets `pushSkipped?: string`, documented as `/** Why a push delivery only commits (protected branch, detached HEAD), plain text; unset otherwise. */`.
- `export function pushSkipReason(branch: string): string` returns:
  - `"HEAD is detached"` when `branch` is `""` or `"HEAD"`;
  - otherwise `` `${branch} is protected` ``, for example `master is protected`.
- `deliveryInstruction`: when `o.mode === "commit"` and `o.pushSkipped` is set, add this part right after the commit text, in the place where the push sentence would go:

  ```
  Don't push: ${o.pushSkipped}, so this flow only commits. Say so in your report.
  ```

  This applies to both the not-committed and the `committed` cases. Nothing is added when `pushSkipped` is unset or the mode is not `commit`.
- `deliveryOutcome` gets an optional 6th parameter, `pushSkipped?: string`. In `commit` mode, when it is set, the text is `` `committed${n}, push skipped: ${pushSkipped}` `` with `ok: true`. Other modes ignore it.

**D5, `index.ts` wiring:**
- `commitPending`, top level and each `repos` entry, gets `pushSkipped?: string`. Old saved state without the field reads as unset, so no migration is needed.
- `prepareDelivery` returns `pushSkipped: pushSkipReason(current)` only in the `unsafe && mode === "push"` branch; otherwise it is `undefined`.
- `finishPassed` passes `pushSkipped` into `options(p)` and into both `commitPending` assignments: the single-repo one, and the multi-repo top-level from `first` plus each repos entry.
- `deliverSelfCommit`: when `unsafe && chosen !== "commit"`, the `moved` entry gets `pushSkipped: pushSkipReason(branch)`. The `moved` type and both `commitPending` shapes carry it. Its `options(m)` passes it too.
- `repoOutcome` gets a 6th parameter, `pushSkipped: string | undefined`, and forwards it to `deliveryOutcome`. Both calls in `summarizeCommit` pass `r.pushSkipped` or the top-level `pushSkipped`.
- The existing UI notices stay as they are.

**Alternatives rejected:**
- Skipping the final full review entirely (setting `finalFullReviewOverChars: 0`): it loses the drift check even when new files were touched.
- Matching findings by basename only: too loose, because files like `index.ts` would always count as cited.

### 5. Steps
**S1.** In `repo-diff.ts`, add `uncitedFiles` exactly as in Design: normalize `\` to `/`, escape regex characters, match `name:` followed by a digit, and keep the order. Add a one-line doc comment, in the style of the module's other exports. Tests go in `repo-diff.test.ts` (see section 6).

**S2.** In `config.ts`:
- Add `finalFullReviewNewFilesOnly: boolean` with its doc comment after `finalFullReviewOverChars` in the type (`:142`), and the default `true` after `finalFullReviewOverChars: 80_000` (`:198`).
- Change `explore.concurrency` to `8` at `:189`.

In `pi/agent/workflow.json:93`, change `"concurrency": 4` to `8`.

**S3.** In `index.ts`:
- Import `uncitedFiles` by adding it to the existing `./repo-diff.ts` import at `:58`.
- At `:795`, add the B1 condition from Design to the final-full-review `if`.
- Update the JSDoc above `judge()` (`:778-781`). Its last sentence becomes: "A large change that passes on a re-review gets one final full review when the changes since touched a file the last findings did not cite."

**S4.** In `delivery.ts`:
- Add the `pushSkipped` field to `DeliveryOptions`.
- Add `pushSkipReason`, modelled on the other small exported helpers such as `freshPr` (`:113`).
- Add the instruction part to `deliveryInstruction` and the 6th parameter to `deliveryOutcome`, both exactly as in Design.

Tests go in `delivery.test.ts`.

**S5.** In `index.ts`, wire D5 as in Design:
- Add `pushSkipped?: string` to the `commitPending` type (`:122`) and its `repos` entry.
- In `prepareDelivery` (`:2478-2481`), add `pushSkipped` to the return.
- In `finishPassed`, pass it through `options(p)` (`:2519`) and both `commitPending` assignments (`:2532`, `:2538-2544`).
- In `deliverSelfCommit` (`:2591-2629`), update the `moved` type, set the field in the `unsafe` branch when `chosen !== "commit"`, and pass it through both `commitPending` shapes and `options(m)`.
- In `summarizeCommit` (`:2083`, `:2089`, `:2092`), destructure `pushSkipped` and pass it to `repoOutcome`. Give `repoOutcome` (`:2124`) the new parameter and forward it at `:2138`.

**S6.** In the workflow `README.md`:
- In the judge bullet (`:92-94`), the final full review sentence says it runs only when the changes since the last round touched a file the last findings did not cite, and that `judge.finalFullReviewNewFilesOnly: false` makes it run every time as before.
- In the Delivery paragraph (`:67`), add one sentence: in `push` mode on a protected branch or a detached HEAD it only commits, and the commit instruction and the final report say why (for example "push skipped: master is protected").

**S7.** In `docs/workflow-improvements.md`, follow its "Keeping this file current" rules:
- Append a **Done:** note naming the files to the end of the Finding text of rows A7, B1 and D5:
  - A7: concurrency 8 in `config.ts` and `workflow.json`.
  - B1: `uncitedFiles` in `repo-diff.ts`, `judge.finalFullReviewNewFilesOnly` (default true).
  - D5: `pushSkipped` in `delivery.ts`/`index.ts`.
- Update the Status line to list A7, B1 and D5 as implemented, and fix its now-wrong "the rest are ideas only" wording.
- Append "Implemented, not measured yet." to the "How to measure" cell of the A7 and B1 rows in Effect measurement. Leave the D5 row (`n/a`) as it is.
- Change "concurrency 4" to "concurrency 8" in the pipeline recap (`:25`).

### 6. Tests
**In `repo-diff.test.ts`, new test "uncitedFiles keeps files no finding cites":**
- `uncitedFiles("a/b.ts:12 - major - x", ["a/b.ts", "c.ts"])` returns `["c.ts"]`.
- `uncitedFiles("D:\\x\\repo\\a\\b.ts:3 - minor", ["a/b.ts"])` returns `[]`.
- `uncitedFiles("only a/b.ts was changed", ["a/b.ts"])` returns `["a/b.ts"]` (no line number).
- `uncitedFiles("", ["a.ts"])` returns `["a.ts"]`.
- `uncitedFiles("x.ts:1", [])` returns `[]`.
- `uncitedFiles("ab.ts:4", ["b.ts"])` returns `[]`. This is the documented substring behaviour; it stays conservative only in the direction of skipping. Keep this case so the behaviour is pinned.

**In `delivery.test.ts`:**
- **"pushSkipReason":** `""` gives `"HEAD is detached"`, `"HEAD"` gives `"HEAD is detached"`, and `"master"` gives `"master is protected"`.
- **"commit mode names a skipped push":**
  - A `deliveryInstruction` with `mode: "commit"` and `pushSkipped: "master is protected"`, plus the other fields as in the existing commit test (`:39`), includes `Don't push: master is protected, so this flow only commits. Say so in your report.` and does not include `git push`.
  - The same options without `pushSkipped` do not include `Don't push`.
- **"outcome names a skipped push":**
  - `deliveryOutcome("commit", 1, false, null, false, "master is protected")` returns `{ text: "committed (1 commit), push skipped: master is protected", ok: true }`.
  - `deliveryOutcome("push", 1, true, null, false, "x")` returns `{ text: "committed (1 commit), pushed", ok: true }`.
- The existing tests stay unchanged and pass.

**Command, in `pi/agent/extensions/workflow`:**
`node --experimental-strip-types --test *.test.ts`. Expect the summary line `ℹ fail 0`.

### 7. Done when
- With `finalFullReviewNewFilesOnly: true`, a passing re-review over `finalFullReviewOverChars` whose changed files are all cited in the previous findings runs no second full review. If any changed file is uncited, it runs as before.
- With `false`, the behaviour is exactly as today.
- Explore concurrency is 8 in the `config.ts` defaults and in `pi/agent/workflow.json`.
- A `push` delivery on a protected branch or a detached HEAD gives a commit instruction containing `Don't push: <reason>`, and a final report reading `committed (N commits), push skipped: <reason>`.
- This holds for both the normal commit step and the executor-self-commit path.
- All workflow tests pass with 0 failures.
- The README and `docs/workflow-improvements.md` are updated as in S6 and S7.

### 8. Risks, rollback, and what not to touch
**Risks:**
- B1 can skip a full review that would have caught drift across rounds. The skip applies only when every changed file was cited. Roll back with `"judge": { "finalFullReviewNewFilesOnly": false }` in `workflow.json`.
- A7 runs up to 8 explore processes at once, which can hit API rate limits. Roll back by setting `explore.concurrency` to 4 in `workflow.json`.
- D5 changes text only. Modes, branches and the push guard are unchanged.

**Do not touch:**
- `reviewPlan`, the judge prompts (`prompts.ts`), `push-guard.ts`, `commit-guard.ts`;
- the `pr`/`merge` new-branch logic in `prepareDelivery`;
- `protectedBranches`;
- any file outside the ones named in S1–S7.

### 9. Commits
- `feat(workflow): explore 8 at once, final full review only for uncited files, explain a skipped push (A7, B1, D5)`. Files:
  - `pi/agent/extensions/workflow/repo-diff.ts`, `repo-diff.test.ts`
  - `pi/agent/extensions/workflow/config.ts`, `index.ts`
  - `pi/agent/extensions/workflow/delivery.ts`, `delivery.test.ts`
  - `pi/agent/extensions/workflow/README.md`
  - `pi/agent/workflow.json`
  - `docs/workflow-improvements.md`

  It is one commit because `index.ts`, `README.md` and the backlog file each carry changes for all three items, and files are not split across commits.

<!-- pi-workflow:status -->
## Checklist
- [x] S1 In `repo-diff.ts`, add `uncitedFiles` exactly as in Design: normalize `\` to `/`, escape regex characters, match `name:`
- [x] S2 In `config.ts`:
- [x] S3 In `index.ts`:
- [x] S4 In `delivery.ts`:
- [x] S5 In `index.ts`, wire D5 as in Design:
- [x] S6 In the workflow `README.md`:
- [x] S7 In `docs/workflow-improvements.md`, follow its "Keeping this file current" rules:
## Outcome
2026-10-19T05:14:42.641Z — ok: committed (1 commit), pushed
