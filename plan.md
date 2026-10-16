<!-- pi-workflow plan v1 flow=20261017-0118-parallel-delivery-reads-a2-and-cached-pl-3036 -->
## Plan: Parallel delivery reads (A2) and cached plan-ref statuses (C3)

1. **Goal and non-goals.**
   - Goal: implement backlog items A2 and C3 from `docs/workflow-improvements.md`.
     - A2: in delivery, the read-only per-repo git/gh calls run at the same time instead of one after another.
     - C3: `statusAt` in `plan-store.ts` reads `status.json` of a plan-ref commit once per SHA per process and caches the raw text.
     - Update the backlog file in the same commits, as its "Keeping this file current" rules require.
   - Non-goals:
     - No change to commit or push order, delivery modes, prompts, messages or config keys.
     - Do not parallelize the `moved` loop in `deliverSelfCommit` (it shows warnings and is rare).
     - Do not parallelize the loops at `index.ts:1064`, `1190`, `1207` or `1232`.
     - Do not implement A7, D5 or any other backlog item.
     - No caching of local `status.json` files (`readLocalStatuses`).

2. **User decisions.**
   - D1: Do the backlog items that are low risk and give the most benefit. The approved scope is A2 and C3 only.
   - D2: A7 and D5 are not part of this flow. The user approved the plan without adding them.
   - D3: The flow's delivery is commit + push.

3. **Facts the executor needs.**

   In `pi/agent/extensions/workflow/index.ts`:
   - `summarizeCommit` (`index.ts:2082`). Line 2090 loops over `repos` sequentially and calls `repoOutcome` for each.
   - `repoOutcome` (`index.ts:2125-2140`) is read-only: `git rev-parse`, `rev-list --count`, and `gh pr view` through `prState` (`index.ts:2169`).
   - `prepareDelivery` (`index.ts:2474-2499`) is read-only:
     - `git rev-parse`;
     - `freeBranchName` (`index.ts:2686`), which only runs `git rev-parse --verify`;
     - `prState`;
     - plus `ctx.ui.notify`.

     It returns `{ mode, branch, from, base, prBefore, head }`.
   - `finishPassed` (`index.ts:2502`). Lines 2536-2537 build `prepared` with a sequential `for` loop over `changed`. `prepared[0]` and `prepared.map(...)` rely on the order of `changed`.
   - `deliverSelfCommit` (`index.ts:2569`). Lines 2574-2579 fill `now` with a sequential loop that runs two `git rev-parse` calls (`HEAD`, `HEAD^{tree}`) per repo. A repo is added only when both calls return code 0.
   - Pattern to copy for parallel per-repo reads: `snapshotRepos` (`index.ts:734-737`), i.e. `Promise.all(... map(async ...))` with an inner `Promise.all` of two git calls.

   In `pi/agent/extensions/workflow/plan-store.ts`:
   - `statusAt` (`plan-store.ts:153-156`) runs `git show <commit>:status.json` and returns `parseStatus(stdout)` on code 0, otherwise null.
   - `statusAt` has three callers, and every one passes a full SHA:
     - `refRev` (`plan-store.ts:159-164`) passes the result of `resolveRef` (`plan-store.ts:86-89`, `rev-parse --verify`);
     - `listRefs` (`plan-store.ts:167-180`) passes `%(objectname)` from `for-each-ref`;
     - `adoptHigher` (`plan-store.ts:199-215`) also passes the result of `resolveRef`.
   - `parseStatus` is imported from `./plan-doc.ts` (`plan-store.ts:6`).

   In the tests (`plan-store.test.ts`):
   - The `git` helper is at lines 10-17.
   - `ID`/`status` are at 19-20, `statusJson(rev, extra)` is at 58, and `setup()` at 61-73 returns `{ base, bare, a, b }`. Each test cleans up with `fs.rmSync(base, …)` in `finally`.
   - Imports are at line 8.

   Other facts:
   - `commitRef` builds commits with `commit-tree`. The same tree, parent, message and second give the same SHA, even across temp repos. So the new test must use content that no other test uses.
   - Tests run with `node --experimental-strip-types --test <files>` from `pi/agent/extensions/workflow` (see `README.md:186`). The repo has no `tsconfig.json` or `package.json`.
   - In `docs/workflow-improvements.md`:
     - the Status line is line 5;
     - the A2 row is line 32 and the C3 row line 63;
     - the "Effect measurement" rows are line 91 (A2) and line 112 (C3).

4. **Design.**
   - **A2: concurrency.**
     - Every parallelized call only reads (git reads and `gh pr view`). There are at most a few repos per flow, so at most a few concurrent `git`/`gh` processes, which is the same scale as `snapshotRepos`.
     - Results keep input order through `Promise.all` over `map`.
     - The `ctx.ui.notify` calls inside `prepareDelivery` may now appear in any order across repos. Each one is tagged with ` [<root>]`, so this is accepted.
     - If several repos are on protected branches, `freeBranchName` may pick the same new branch name in each. This is correct because branch names are per repo.
     - Failure handling does not change. `git` returns `{ code, ... }` and does not throw for normal failures. If something does throw, the `Promise.all` rejects just as the sequential loop would have thrown.
   - **C3: cache.**
     - Module-level `const statusCache = new Map<string, string>()` in `plan-store.ts`. The key is the commit SHA and the value is the raw `status.json` stdout.
     - `statusAt` contract and signature are unchanged: `async function statusAt(git: Git, root: string, commit: string): Promise<PlanStatus | null>`.
     - Use the cache only when `commit` matches `/^[0-9a-f]{40,64}$/` (lower-case hex SHA-1 or SHA-256). Any other string always goes to git and is not stored.
     - On a hit, return `parseStatus(cached)` with no git call.
     - On a miss, run the same `git show`. Store stdout only when `r.code === 0`. A rejected promise, a non-zero code or a missing file is not cached.
     - Parse on every call so each caller gets a fresh object.
     - The key is not scoped by repo: git objects are content-addressed, so the same SHA always has the same `status.json`.
     - Bound: before inserting, if `statusCache.size >= 1000`, call `statusCache.clear()`. A status.json is a few hundred bytes, so the cache stays at a few hundred KB. Past 1000 distinct plan commits in one process, the cache only gets cleared more often.
     - Stale data is not possible: a ref that moves points at a new SHA, which misses the cache.
     - Rejected alternatives:
       - caching parsed objects (callers could mutate a shared object);
       - caching by ref name (refs move).

5. **Steps.** No stages: two small independent changes, each in its own commit, in this order.

   **S1.** In `index.ts` `summarizeCommit` (`index.ts:2089-2091`), replace the `parts` array and the `for` loop with one `await Promise.all(repos.map(async (r) => ({ name: path.basename(r.root), outcome: await repoOutcome(r.root, r.mode, r.head, r.branch, r.prBefore) })))`. Then pass the result to `combineOutcomes` as before. Same element shape, same order.

   **S2.** In `index.ts` `finishPassed` (`index.ts:2536-2537`), build `prepared` with `await Promise.all(changed.map(async (ref) => ({ root: ref.root, p: await prepareDelivery(ctx, ref.dir, chosen, seed, \` [${ref.root}]\`) })))`.
   - Drop the explicit type annotation if inference gives the same type.
   - Add a one-line comment above it saying the per-repo preparation only reads (git rev-parse, gh pr view) and keeps the order of `changed`.
   - Everything after it (`prepared[0].p`, `state.commitPending`, `repoDeliveryInstruction`) stays unchanged.

   **S3.** In `index.ts` `deliverSelfCommit` (`index.ts:2574-2579`), read all repos at once:
   - `Promise.all` over `refs`, where each element is a `Promise.all` of `git(ref.dir, "rev-parse", "HEAD")` and `git(ref.dir, "rev-parse", "HEAD^{tree}")`;
   - then fill `now[repoKey(ref.root)]` in `refs` order, under the same condition (both codes 0) and with the same trimmed values.

   Leave the loop over `refs` that builds `moved` (`index.ts:2593-2610`) unchanged.

   **S4.** In `docs/workflow-improvements.md`:
   - A2 row (line 32): append `**Done:** the read-only per-repo calls in \`summarizeCommit\`, \`finishPassed\` (\`prepareDelivery\`) and \`deliverSelfCommit\` (HEAD and tree reads) run in parallel; commit and push stay sequential (\`index.ts\`).`
   - Status line (line 5): add A2 to the implemented list, in alphabetical order (`A2, A3, A5, ...`).
   - "Effect measurement" A2 row (line 91): append ` Implemented, not measured yet.` to the "How to measure" cell.

   **S5.** In `plan-store.ts`, add the module-level `statusCache` and change `statusAt` exactly as in Design C3:
   - SHA regex guard, hit returns a fresh parse, store only on code 0, clear at 1000 entries.
   - Add a short doc comment on the map: "status.json text per plan commit; commits are immutable, so a SHA's text never changes."
   - Callers stay unchanged.

   **S6.** In `plan-store.test.ts`, add the test described in section 6. If the test needs a counting wrapper, write it inside the test around the existing `git` helper; do not change the shared helper.

   **S7.** In `docs/workflow-improvements.md`:
   - C3 row (line 63): append `**Done:** \`statusAt\` caches the raw \`status.json\` text by commit SHA (successful reads only, cleared at 1000 entries); test in \`plan-store.test.ts\`.`
   - Status line: add C3 in order (`..., C2, C3, C4, ...`).
   - "Effect measurement" C3 row (line 112): append ` Implemented, not measured yet.` to the "How to measure" cell.

6. **Tests.**
   - New test in `plan-store.test.ts`, named `statusAt caches status.json by commit, so listRefs reads each plan commit once`:
     - Setup: `const { base, a } = setup()`. Define a counting `Git` that wraps `git` and increments a counter when `args[0] === "show"`.
     - Commit: call `commitRef(git, a, ID, "# cache\n", statusJson(1, { title: "Cache test unique" }))`. The unique title keeps the SHA different from any other test.
     - First listing: `listRefs(counting, a, "plans")` returns one entry with `status.rev === 1`, and the counter is 1.
     - Second listing: reset the counter. A second `listRefs(counting, a, "plans")` returns `status.rev === 1`, and the counter is 0.
     - Fresh objects: the two calls' `status` objects are not the same object (`assert.notEqual(first[0].status, second[0].status)`).
     - New commit: call `commitRef(git, a, ID, "# cache 2\n", statusJson(2, { title: "Cache test unique" }))`, then reset the counter.
       - `refRev(counting, a, ID)` returns 2 and the counter is 1.
       - Then `listRefs(counting, a, "plans")` returns `status.rev === 2` and the counter stays 1.
     - Cleanup: `fs.rmSync(base, { recursive: true, force: true })` in `finally`.
   - Existing tests stay unchanged and must pass. This includes the `refRev`/`adoptHigher` tests at `plan-store.test.ts:154`.
   - A2 gets no new unit test, because `index.ts` has no test harness (backlog D1). Correctness rests on keeping order and the same per-element logic.
   - Command, from `pi/agent/extensions/workflow`: `node --experimental-strip-types --test *.test.ts`. Expected output: every test passes, `# fail 0`.

7. **Done when.**
   - In `index.ts`, the loops in `summarizeCommit` (repo outcomes), `finishPassed` (`prepareDelivery` per changed repo) and `deliverSelfCommit` (HEAD/tree reads) run in parallel and keep input order. No commit, push or other mutating step was parallelized.
   - `statusAt` in `plan-store.ts` serves repeated reads of the same commit SHA from memory and caches only successful reads. Its signature and callers did not change.
   - The new plan-store test passes, and all workflow tests pass with `# fail 0`.
   - `docs/workflow-improvements.md` marks A2 and C3 as Done (row note, Status line, Effect measurement note), and each doc change is in the same commit as its code.
   - Nothing outside the files in section 9 changed.

8. **Risks, rollback, and what not to touch.**
   - Risks:
     - A2: delivery notices may appear in a different order across repos (accepted, see Design). The extra concurrent `gh` processes are few.
     - C3: a memory leak is prevented by the 1000-entry clear. Stale status is not possible because the key is an immutable SHA.
   - Rollback: revert either commit on its own; the two are independent.
   - Do not touch:
     - `prepareDelivery`, `repoOutcome`, `prState` or `freeBranchName` themselves;
     - commit or push code;
     - `readLocalStatuses`;
     - the shared `git` helper in `plan-store.test.ts`;
     - backlog rows other than A2 and C3 and the Status line.

9. **Commits.**
   - `perf(workflow): read repos in parallel during delivery (A2)`: `pi/agent/extensions/workflow/index.ts`, `docs/workflow-improvements.md` (S1-S4).
   - `perf(workflow): cache plan-ref statuses by commit (C3)`: `pi/agent/extensions/workflow/plan-store.ts`, `pi/agent/extensions/workflow/plan-store.test.ts`, `docs/workflow-improvements.md` (S5-S7).

<!-- pi-workflow:status -->
## Checklist
- [x] S1 In `index.ts` `summarizeCommit` (`index.ts:2089-2091`), replace the `parts` array and the `for` loop with one `await Pro
- [x] S2 In `index.ts` `finishPassed` (`index.ts:2536-2537`), build `prepared` with `await Promise.all(changed.map(async (ref) =>
- [x] S3 In `index.ts` `deliverSelfCommit` (`index.ts:2574-2579`), read all repos at once:
- [x] S4 In `docs/workflow-improvements.md`:
- [x] S5 In `plan-store.ts`, add the module-level `statusCache` and change `statusAt` exactly as in Design C3:
- [x] S6 In `plan-store.test.ts`, add the test described in section 6. If the test needs a counting wrapper, write it inside the 
- [x] S7 In `docs/workflow-improvements.md`:
## Outcome
2026-10-16T18:20:47.092Z — ok: committed (2 commits)
