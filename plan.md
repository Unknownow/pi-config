<!-- pi-workflow plan v1 flow=20261016-1101-deduplicate-plan-ref-roots-in-writeplan-3184 -->
## Plan: Deduplicate plan-ref roots in `writePlan` so a repo is never synced twice

### 1. Goal and non-goals

**Goal:** `writePlan` in the workflow extension deduplicates the flow's repo roots correctly on Windows.
- Each repo is written to its plan ref once per save.
- The concurrent `update-ref` race and its warning ("could not save the plan ref in …") go away.
- `status.json` `repos` gets no more repeated entries.

**Non-goals:**
- No rewrite or cleanup of existing `refs/pi/plans/*` refs that already hold repeated `repos` entries.
- No change to `syncRoot`, `commitRef`, push or retry logic, or how `planChain` serializes saves.
- No change to `repoKey` or `uniqueRoots` in `repos.ts`.
- No change to any other extension.

### 2. User decisions

- D1. Fix the cause in the workflow extension: replace the broken dedup in `writePlan` with the existing `uniqueRoots` helper.
- D2. The fix also collapses duplicates already present in a flow's saved roots, for example a flow resumed from a ref that has them.
- D3. Existing refs keep their extra entries, which are harmless. They are not migrated.
- D4. Add a `repos.test.ts` test showing `uniqueRoots` collapses repeated and trailing-slash Windows roots.
- D5. Delivery is commit + push.

### 3. Facts the executor needs

- Work in `D:/projects/pi-config/pi/agent/extensions/workflow/`. That is the repo copy, and the sync extension mirrors it to `~/.pi/agent`. Don't edit the live copy.
- `index.ts:898-905`, inside `writePlan`:
  - `roots` is copied from `snap.roots`.
  - `seen = new Set(roots.map(repoKey))` is the bug. `Array.map` passes the index as `repoKey`'s `platform` argument, so the keys aren't lowercased on win32.
  - `found` holds `flowRepos` roots plus `gitRoot` of each touched path. Entries can be `null`.
  - A loop pushes each `found` entry that isn't in `seen`.
- What uses `roots` afterwards, unchanged: `plansDir(… roots[0] …)` (`index.ts:906`), `repoInfo` per root (`:907`), the `live.roots` update (`:926-927`), and `mapLimit(roots, 3, syncRoot…)` (`:930`).
- `repos.ts:21-32`: `uniqueRoots(roots: string[], platform = process.platform): string[]` keeps the first occurrence by `repoKey` and returns the original strings.
- `repos.ts:10`: `repoKey` lowercases on win32, turns `\` into `/`, turns `/d/` into `D:/`, and strips a trailing slash.
- `index.ts:58`: `import { combineRepoTexts, parseAddDir, repoKey } from "./repos.ts";`. `uniqueRoots` isn't imported yet, and `repoKey` is still used elsewhere in `index.ts`.
- `repos.test.ts:4` already imports `uniqueRoots`. The existing test `uniqueRoots keeps first` is at `:14-16`, and it is the model for the new test.
- Test command, from `workflow/README.md:185`: `node --experimental-strip-types --test agent-end.test.ts readonly-bash.test.ts readonly-tools.test.ts tokens.test.ts push-guard.test.ts knowledge.test.ts mcp-forward.test.ts subagent.test.ts delivery.test.ts repos.test.ts stages.test.ts commit-guard.test.ts`.
- The working tree was clean before this work.

### 4. Design

No component or interface change, so this section is omitted.

### 5. Steps

**S1.** `index.ts:58`: add `uniqueRoots` to the existing `./repos.ts` import, and keep `repoKey`.

**S2.** `writePlan` (`index.ts:899-905`): replace the `roots` / `seen` / loop block with one `const roots` computed as `uniqueRoots` over `snap.roots` followed by the non-null entries of `found`.
- Order is preserved: saved roots first, then newly found ones, keeping the first spelling of each repo.
- `found` is computed exactly as now, with the same `flowRepos` and `gitRoot` calls.
- Leave the rest of `writePlan` unchanged.
- Because `snap.roots` goes through `uniqueRoots` too, a saved list like `["D:/p", "D:/p"]` becomes `["D:/p"]`. Then `roots.join("\n") !== live.roots.join("\n")` is true, the shortened list is stored in `live.roots` and persisted, and the stored state self-heals (D2).

**S3.** `repos.test.ts`: after the existing `uniqueRoots keeps first` test (`:14-16`), add the test from §6.

**S4.** Run the tests in §6. Then grep `index.ts` for `map(repoKey)`, which must find nothing.

### 6. Tests

**New test** in `repos.test.ts`, named `uniqueRoots collapses repeated roots`:
```ts
assert.deepEqual(uniqueRoots(["D:/projects/x", "D:/projects/x", "d:/projects/x/", "/d/projects/x"], "win32"), ["D:/projects/x"]);
```

**Commands**, from `pi/agent/extensions/workflow`:
- `node --experimental-strip-types --test agent-end.test.ts readonly-bash.test.ts readonly-tools.test.ts tokens.test.ts push-guard.test.ts knowledge.test.ts mcp-forward.test.ts subagent.test.ts delivery.test.ts repos.test.ts stages.test.ts commit-guard.test.ts plan-store.test.ts`: expect `ℹ fail 0`.
- `node --experimental-strip-types -e "import('./index.ts').then(()=>console.log('ok'),e=>{console.error(e.message);process.exit(1)})"` must not fail with a syntax or type-strip error. A runtime import error about pi packages is acceptable. If that is the outcome, instead check that `grep -n "uniqueRoots" index.ts` shows the import and the use.

**Manual check after delivery:** the next flow's plan ref, `git show refs/pi/plans/<new flowId>:status.json`, lists `pi-config` exactly once under `repos` in every rev. The "could not save the plan ref" warning does not appear.

### 7. Done when

- `writePlan` builds `roots` with `uniqueRoots`, and `index.ts` contains no `map(repoKey)`.
- A flow in a single repo writes `status.json` with exactly one `repos` entry at every rev, and `syncRoot` runs once per repo per save.
- A saved roots list with duplicates is collapsed on the next save.
- Existing refs are untouched.
- The new `repos.test.ts` test passes, and the whole listed suite reports `fail 0`.
- The change is committed and pushed.

### 8. Risks, rollback, and what not to touch

**Risks:**
- If root order changed, a different repo would become primary and the plans folder would move (`plansDir` uses `roots[0]`). `uniqueRoots` keeps first-occurrence order, so the primary root stays the same.
- Low risk otherwise: one call site, using a tested helper.

**Rollback:** revert the commit.

**Do not touch:**
- `repos.ts`, `plan-store.ts`, `syncRoot`, `planMilestone`
- existing `refs/pi/plans/*`
- the live copy under `~/.pi/agent`
- other extensions and `.bak` files

### 9. Commits

- `fix(workflow): deduplicate plan roots with uniqueRoots so each repo's plan ref is written once`
  - `pi/agent/extensions/workflow/index.ts`
  - `pi/agent/extensions/workflow/repos.test.ts`

<!-- pi-workflow:status -->
## Checklist
- [x] S1 `index.ts:58`: add `uniqueRoots` to the existing `./repos.ts` import, and keep `repoKey`.
- [x] S2 `writePlan` (`index.ts:899-905`): replace the `roots` / `seen` / loop block with one `const roots` computed as `uniqueRo
- [x] S3 `repos.test.ts`: after the existing `uniqueRoots keeps first` test (`:14-16`), add the test from §6.
- [x] S4 Run the tests in §6. Then grep `index.ts` for `map(repoKey)`, which must find nothing.
## Outcome
2026-10-16T04:03:03.169Z — ok: committed (1 commit)
