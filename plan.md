<!-- pi-workflow plan v1 flow=20261019-1458-match-repo-relative-citations-in-the-mul-9b13 -->
## Plan: Match repo-relative citations in the multi-repo final-review gate (B1 follow-up)

### 1. Goal and non-goals
**Goal:**
- In multi-repo flows, a judge finding that cites a repo-relative path (for example `src/a.ts:12`) counts as citing that changed file. The B1 gate (`needsFinalFullReview`) then skips the final full review when every changed file is cited, as it already does in single-repo flows.
- A relative path changed in two or more repos stays separate per repo. A finding about `repoA/README.md` must not count as citing repoB's `README.md`.

**Non-goals:**
- No change to `uncitedFiles` or `needsFinalFullReview` (`repo-diff.ts:16`, `:25`).
- No change to the judge prompts (`prompts.ts`), `reviewPlan`'s recheck/full decision, `plan.changed` or `recheckKnowledgeFiles`.
- No change to single-repo behaviour.
- No other backlog item.
- No change outside `pi/agent/extensions/workflow/` and `docs/workflow-improvements.md`.

### 2. User decisions
- D1: Fix the judge's remaining minor finding (`index.ts:776`, multi-repo citations relative to the repo).
- D2: Approved design: paths changed in only one repo stay bare, and paths changed in several repos get the repo folder in front. Findings are not parsed per repo section.

### 3. Facts the executor needs
- `repo-diff.ts:2` already imports `path` (`import * as path from "node:path"`).
- `repo-diff.ts:16`: `uncitedFiles(findings, changed)` returns the entries of `changed` that no finding cites as `<name>:<digit>`. It normalizes `\` to `/` and uses substring matching, so the bare name `src/a.ts` also matches `repoA/src/a.ts:3`.
- `repo-diff.ts:25`: `needsFinalFullReview(newFilesOnly, findings, changed)`.
- `index.ts:58`: `import { collectRepoDiff as collectRepoDiffImpl, needsFinalFullReview, type RepoDiff } from "./repo-diff.ts";`
- `index.ts:760-768`: `per` is an array of `{ root: string; text: string; names: string[] }`, one entry per repo, in `diff.repos` order. `names` are paths relative to that repo, with `/` separators (from `git diff --name-only`).
- `index.ts:775-777` today:
  ```
  // Multi-repo findings cite `repo/path`, so the same relative path in two repos stays apart.
  const cites = per.flatMap((p) => p.names.map((n) => (diff.multi ? `${path.basename(p.root)}/${n}` : n)));
  return { kind: "recheck", snaps, prev, delta, changed, cites };
  ```
- `index.ts:730`: the `recheck` plan type has `cites: string[]`, which stays as it is.
- `index.ts:797`: the gate uses `plan.cites`, which stays as it is.
- `prompts.ts:209`: the judge is told that paths inside a repo section are relative to that root.
- `repo-diff.test.ts:8`: `import { collectRepoDiff, type RepoDiff, type RunGit, needsFinalFullReview, uncitedFiles } from "./repo-diff.ts";`
  - `:149` is the `uncitedFiles` test.
  - `:158` is the `needsFinalFullReview` test. It is the last test in the file.
- `docs/workflow-improvements.md:45` (B1 row) ends with: `**Done:** \`uncitedFiles\` in \`repo-diff.ts\`, gated by \`judge.finalFullReviewNewFilesOnly\` (default true; false restores the old behaviour) in \`index.ts\`.`

### 4. Design
- **Component:** one new pure function in `repo-diff.ts`, placed directly above `needsFinalFullReview` (`:25`). It needs a short JSDoc saying why bare vs. prefixed:
  ```ts
  export function citeNames(parts: { root: string; names: string[] }[], multi: boolean): string[]
  ```
- **Contract:**
  - If `multi` is false, return all `names` of all parts, flattened in order, unchanged.
  - If `multi` is true, count how many parts contain each name. A name in exactly one part is returned bare. A name in two or more parts is returned as `` `${path.basename(root)}/${name}` `` for each part.
  - The output keeps part order and name order, with one entry per (part, name). An empty input gives `[]`.
- **Accepted looseness:** a bare name also matches a finding that cites the same relative path in a different repo whose copy did not change this round. This needs the same path in two repos plus a finding about the unchanged one. It only skips a review the change made optional. Rejected alternative: splitting `prev.text` by repo section, because findings carry no section markers.
- **Rejected:** always prefixing, which is today's code. Findings cite relative paths, so in multi-repo flows B1 almost never skipped.

### 5. Steps
**S1.** In `repo-diff.ts`, add `citeNames` above `needsFinalFullReview` (`:25`), as in Design. Model the style on `uncitedFiles` (`:16`): tabs, JSDoc, and a single small function.

**S2.** In `index.ts`:
- At `:775-777`, delete the comment and the `cites` line.
- Return `cites: citeNames(per, diff.multi)` in the `recheck` object.
- Add `citeNames` to the `./repo-diff.ts` import at `:58`.
- Leave `changed` (`:773-774`) untouched.

**S3.** In `repo-diff.test.ts`:
- Add `citeNames` to the import at `:8`.
- Append a test after `:158`, as in section 6.

**S4.** In `docs/workflow-improvements.md:45`, append one sentence to the B1 **Done:** note: `In multi-repo flows \`citeNames\` keeps a path changed in one repo bare, so repo-relative citations count.` Leave the Status line and the measurement row unchanged, since B1 is already listed as implemented.

**S5.** Run the tests (section 6).

### 6. Tests
**New test** in `repo-diff.test.ts`: `citeNames keeps a path bare unless several repos changed it`. Use parts `[{ root: "/w/repoA", names: ["src/a.ts", "README.md"] }, { root: "/w/repoB", names: ["README.md"] }]` and check:
- `citeNames(parts, false)` deep-equals `["src/a.ts", "README.md", "README.md"]`.
- `citeNames(parts, true)` deep-equals `["src/a.ts", "repoA/README.md", "repoB/README.md"]`.
- With `names = citeNames(parts, true)`, `uncitedFiles("src/a.ts:3 - minor - x", names)` deep-equals `["repoA/README.md", "repoB/README.md"]`.
- `uncitedFiles("repoA/README.md:3 - minor - x", names)` deep-equals `["src/a.ts", "repoB/README.md"]`.
- `citeNames([], true)` deep-equals `[]`.

**Command:** in `pi/agent/extensions/workflow`, run `node --experimental-strip-types --test *.test.ts`. Expect `ℹ fail 0`, and `ℹ pass` one higher than the current 466.

### 7. Done when
- In multi-repo flows, a repo-relative citation of a path changed in only one repo counts as cited.
- A path changed in several repos counts as cited only through its own `repo/path` citation.
- Single-repo `cites` equals the changed names exactly as before.
- All workflow tests pass with 0 failures.
- The B1 row in `docs/workflow-improvements.md` carries the added sentence.

### 8. Risks, rollback, and what not to touch
- **Risk:** the looseness described in Design. It is accepted and errs toward skipping only an optional extra review.
- **Rollback:** revert the commit. `judge.finalFullReviewNewFilesOnly: false` also turns the gate off.
- **Do not touch:**
  - `uncitedFiles`, `needsFinalFullReview`, `plan.changed`, `recheckKnowledgeFiles` (`index.ts:1320`);
  - the gate at `index.ts:797`;
  - `prompts.ts`, `config.ts`, the README, `workflow.json`.

### 9. Commits
- `fix(workflow): match repo-relative citations in the multi-repo final review gate (B1)`, with these files: `pi/agent/extensions/workflow/repo-diff.ts`, `pi/agent/extensions/workflow/repo-diff.test.ts`, `pi/agent/extensions/workflow/index.ts`, `docs/workflow-improvements.md`.

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 In `repo-diff.ts`, add `citeNames` above `needsFinalFullReview` (`:25`), as in Design. Model the style on `uncitedFiles`
- [ ] S2 In `index.ts`:
- [ ] S3 In `repo-diff.test.ts`:
- [ ] S4 In `docs/workflow-improvements.md:45`, append one sentence to the B1 Done: note: `In multi-repo flows \`citeNames\` keep
- [ ] S5 Run the tests (section 6).
