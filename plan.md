<!-- pi-workflow plan v1 flow=20261021-1405-runnergate-test-covers-a-newcomer-arrivi-bf0a -->
## Plan: runnerGate test covers a newcomer arriving at the slot hand-over

### 1. Goal and non-goals
**Goal.** Close the last open judge finding (`test-run.test.ts:149`, minor, [test]). Add a test to `test-run.test.ts` that fails if `runnerGate` again lets a call that arrives as a slot frees take that slot from a runner already waiting. The current test "runnerGate: waiting runners start in order" queues every call before any slot frees, so it also passes on the old, buggy code.

**Non-goals.**
- No change to `test-run.ts` or any other source file. The hand-over fix is already correct (the judge confirmed it).
- No change to the existing tests, including "waiting runners start in order".
- No README or docs change. Test-only changes need no `docs/workflow-improvements.md` update, because no backlog item is implemented, rejected or added.
- No push, PR or merge (`master` is protected).

### 2. User decisions
- **D1.** Tackle the remaining open finding ("fix the open for me").
- **D2.** Earlier constraint, still in force: the workflow must not import or refer to the `worktree` extension. Don't change `worktree/`.
- **D3.** Earlier constraint, still in force: README updates go in the same commit as the behaviour they describe. None are needed here.

### 3. Facts the executor needs
- `test-run.ts:86`: `export function runnerGate(limit: () => number): <R>(resource: string, fn: () => Promise<R>) => Promise<R>`.
- `test-run.ts:105`: the waiter. If `running >= Math.max(1, limit())`, it waits on a promise pushed to `waiting`, and the slot is handed over to it. Otherwise it does `running++`.
- `test-run.ts:110-115`: the `finally`:
  - If `running > limit` or no one waits, it does `running--`. Otherwise it calls `waiting.shift()!()` and keeps `running` as it is (the hand-over).
  - Then, while there are waiters and `running < limit`, it does `running++` and wakes one waiter.
- `test-run.ts:118`: `release()` of the resource lock. Resource `"none"` takes no lock.
- The old code the new test must catch, for the S2 check only:
  - Waiter: `while (running >= Math.max(1, limit())) await new Promise<void>((r) => waiting.push(r)); running++;`
  - `finally`: `running--; waiting.shift()?.();`
- `test-run.test.ts:4` already imports `runnerGate`. `:7` has `const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));`.
- `test-run.test.ts:116-154`: the existing runnerGate tests. The new test goes right after "runnerGate: waiting runners start in order" (`:149-154`, at the end of the file).
- `test-run.test.ts` and `test-run.ts` don't import pi packages (`test-run.ts` imports from `./subagent.ts`), so a copy of the folder's `.ts` files runs on its own.
- Test command, from `D:\projects\pi-config\pi\agent\extensions\workflow`:
  `node --experimental-strip-types --test *.test.ts 2>&1 | grep -E "^(✖|ℹ (tests|pass|fail))"`. The current count is 528 tests, 0 fail.
- Typecheck: `cd /tmp/wfty && node /tmp/readycheck/node_modules/typescript/bin/tsc -p . 2>&1 | grep "error TS"`. Expect exactly the 5 known errors: `waitForIdle` and `reload` in `index.ts`, `aborted` in `index.ts`, and `findLast` plus an implicit `any` in `subagent.ts:137`.
- Bash on Windows mangles backslashes in heredocs and sed. Use the edit/write tools, or codemode `tools.write`/`tools.edit`, for file changes.

### 4. Design
Not needed. This is a test-only change with no new components, interfaces or concurrency.

### 5. Steps
**S1.** In `test-run.test.ts`, after the test at `:149-154`, add the test `runnerGate: a newcomer does not take a freed slot from a waiter`. Model it on the existing runnerGate tests (`:116-154`). Behaviour:
- Loop `ticks` from 0 to 11. Each iteration uses a fresh `runnerGate(() => 1)` and a fresh `order: string[]`.
- Start A with `gate("none", fn)`. Its `fn` pushes `"A"`, then awaits a promise whose resolver the test keeps.
- Start B with `gate("none", fn)`. Its `fn` pushes `"B"`.
- `await sleep(5)` so that A is running and B is in the queue.
- Call A's resolver. Then await `Promise.resolve()` exactly `ticks` times, and only then call `gate("none", fn)` for D, whose `fn` pushes `"D"`. With `ticks` 0, D starts in the same tick as the release: the case the judge asked for. Higher values make D arrive before, at and after the hand-over to B.
- Await A, B and D together. Then `assert.deepEqual(order, ["A", "B", "D"], ...)` with the message `` `D after ${ticks} microtasks` ``.
- Don't add new imports.

**S2.** Check that the new test catches the old bug, without touching the repo:
1. Make a fresh scratch folder `/tmp/oldgate`, and copy every `*.ts` file from the workflow folder into it.
2. In the copy of `test-run.ts`, put back the old waiter and `finally` from section 3. Replace lines 105-115 so the resource lock and `release()` stay as they are.
3. Run `node --experimental-strip-types --test test-run.test.ts` in `/tmp/oldgate`.

Expected: the new test fails for at least one `ticks` value, and every other test passes.

If the new test passes on the old code, it doesn't guard the race. In that case change only the new test's timing in the repo: a wider tick range, or D started from a `.then` on A's `fn` promise. Repeat S2 until the test fails on the old code and passes on the current code. Don't change `test-run.ts` in the repo. Report the `ticks` values that failed on the old code. Delete `/tmp/oldgate` afterwards.

### 6. Tests
- **New test** in `test-run.test.ts`: `runnerGate: a newcomer does not take a freed slot from a waiter`. It uses limit 1 and resource `"none"`. A holds the slot, B waits, and D arrives 0 to 11 microtasks after A is released. Expected order every time: `["A","B","D"]`.
- **Old-code check** (S2): the new test fails in `/tmp/oldgate`.
- **Commands:**
  - The full suite, from the workflow folder. Expect `ℹ tests 529`, `ℹ fail 0`, and no `✖` lines.
  - The typecheck. Expect exactly the 5 known errors.

### 7. Done when
- The new test exists after "runnerGate: waiting runners start in order", and passes on the current `runnerGate`.
- It fails on the old gate code, run in a scratch copy, and the report says so.
- The full suite passes (529 tests, 0 fail), and the typecheck shows only the 5 known errors.
- Nothing but `test-run.test.ts` is changed in the repo.

### 8. Risks, rollback, what not to touch
- **Risk:** microtask timing differs between Node versions, so a fixed delay could miss the window. The `ticks` loop covers a range of arrival points. S2 confirms that the range hits the window on this Node.
- **Risk:** flakiness from `sleep(5)`. It only lets A start and B queue, which takes microtasks rather than milliseconds, so it is safe.
- **Rollback:** revert the one test commit.
- **Don't touch:**
  - `test-run.ts`, `index.ts`, README and docs.
  - The existing tests.
  - `worktree/`, `delivery.ts`, guards and prompts.
  - Don't leave `/tmp/oldgate` changes anywhere in the repo.

### 9. Commits
1. `test(workflow): runnerGate test covers a newcomer at hand-over` — `pi/agent/extensions/workflow/test-run.test.ts`.

<!-- pi-workflow:status -->
## Checklist
- [x] S1 In `test-run.test.ts`, after the test at `:149-154`, add the test `runnerGate: a newcomer does not take a freed slot fro
- [x] S2 Check that the new test catches the old bug, without touching the repo:
## Outcome
2026-10-21T07:07:35.022Z — failed: committed (1 commit), pushed, no open pull request
