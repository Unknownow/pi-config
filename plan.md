<!-- pi-workflow plan v1 flow=20261021-1250-workflow-test-flow-close-the-five-stage-86bb -->
## Plan: Workflow test flow: close the five stage-1 minor findings

### 1. Goal and non-goals

**Goal.** Fix the five minor judge findings left open after stage 1 of the test-and-fix workflow (`pi/agent/extensions/workflow/`):
1. **Deny list:** a command wrapper (`timeout`, `env`, …) in front of `adb`/`fastboot` gets past the runner deny list.
2. **Git detection:** behind a wrapper, any later word whose basename is `git`/`gh` is wrongly treated as running git.
3. **Records:** a second `test_run` call in the same round overwrites earlier task records and logs that have the same ID.
4. **Resources:** resource exclusion and the `test.concurrency` limit hold only within one `test_run` call, not across calls that run in parallel.
5. **Notice:** starting with `--flow test` shows no "describe what to test" notice.

**Non-goals.**
- No change to the K5 exports `parseCommands`, `KEYWORDS`, `WRAPPERS` (names, signatures or meaning).
- No change to push-guard or commit-guard rules, the normal judge prompt texts, `delivery.ts`, plan-phase allow defaults, or anything in `worktree/`.
- No new config keys.
- No coordination between separate pi sessions or processes.
- Not a sandbox: the runner guard stays a guard against drift.

### 2. User decisions

- **D1.** Tackle all remaining open findings from stage 1 ("tackle the remaining opens for me").
- **D2.** Earlier constraint, still in force: the workflow must not import or refer to the `worktree` extension. Don't change `worktree/`.
- **D3.** Earlier constraint, still in force: README updates go in the same commit as the behaviour they describe.

### 3. Facts the executor needs

- **`readonly-bash.ts:269` `KEYWORDS`:** a set of shell keywords (`if`, `then`, `do`, `!`, `{`, `time`, …).
- **`readonly-bash.ts:272-281` `WRAPPERS`:** maps each wrapper name to the options that take a value:
  - `timeout`: `-s --signal -k --kill-after`
  - `xargs`: `-I -i -n -L -l -P -d -s -E -e -a`
  - `env`: `-u --unset -C --chdir`
  - `nice`: `-n`
  - `stdbuf`: `-i -o -e`
  - `command`, `exec`, `nohup`: none
- **`readonly-bash.ts:427-440` `wrapperProblem(name, args, allow)`** skips the wrapper's own words like this:
  - `command -v`/`-V` → null.
  - For `env`, a RISKY_ENV check.
  - Then it skips words starting with `-` (two words if the option is in `WRAPPERS[name]`) and, for `env`, `NAME=value` words.
  - For `timeout` it skips one more word (the duration).
  - It checks the rest with `commandProblem({ words: rest, writes: [], env: [] }, allow)`.
- **`runner-guard.ts:44` `nameOf(w)`:** the basename without `.exe`.
- **`runner-guard.ts:47-51` `stripKeywords(words)`:** drops leading `KEYWORDS`.
- **`runner-guard.ts:54-61` `runsGit(words)`:** if the first word is a wrapper, it returns true when *any* later word's basename is `git`/`gh`. This is finding 2.
- **`runner-guard.ts` `runnerProblem`:**
  - Step 1 refuses `runsGit(cmd.words) && commandReadOnlyProblem({ ...cmd, writes: [] })` with "runners may not change git or GitHub". It also recurses into `bash -c` and `sh -c`.
  - Step 2 (deny list) tests `cmds.length ? cmds.some(c => re.test(stripKeywords(c.words).join(" "))) : re.test(text.trim())`. Wrappers are not removed, so `^adb` misses `timeout 120 adb … reboot`. This is finding 1.
  - Steps 3 and 4 (path flags, path env) stay unchanged.
- **`test-run.ts:32` `resourceKey`:** `r.trim().toLowerCase()`. An empty key or `none` means no resource (`:44`).
- **`test-run.ts:39-61` `scheduleTasks(tasks, concurrency, runOne)`:** a per-call grouping that uses `mapLimit` from `subagent.ts` (`test-run.ts:7`).
- **`index.ts:1852` `const dir = runsDir(state.testFlow?.round ?? 1);`**
  - `:1856` `scheduleTasks(tasks, cfg.test.concurrency, async (task) => { … runRole("runner", …) … })`.
  - `:1857` `taskCard(task, ctx.cwd, dir)`.
  - `:1868` the record path `path.join(dir, `${task.id}.md`)`.
  - `:1878` the result starts with `Artifacts folder: ${dir}`.
- **`index.ts` `runsDir(round)`** (just above `onTestEnd`) creates `<plan folder or temp>/runs/<round>` with `fs.mkdirSync(..., { recursive: true })` and returns it.
- **`prompts.ts:130` (RUNNER):** "Redirect long output into files named `<artifacts folder>/<task id>-*.log`. Write only inside the artifacts folder." The artifacts folder is whatever `dir` the card names.
- **`index.ts:3302` `if (start !== "off") await setPhase(ctx, start);`** runs in `session_start` and shows no notice.
- **`index.ts:3498`:** the notice text for `/flow test` with no scope is `` `workflow: test phase on ${describeRole(cfg.roles.test)}; describe what to test` `` (level `"info"`).
- **README.md:198** (the `test_run` bullet) ends with "… is written to `runs/<round>/<id>.md` in the plan's folder (the temp folder when there is no plan file)."
- **README.md:200** (the runner guard bullet) lists what the guard refuses.
- **Tests run with:** `node --experimental-strip-types --test *.test.ts` from `pi/agent/extensions/workflow`. The current suite has 520 tests, all passing.

### 4. Design

**Unwrapping (`readonly-bash.ts`).** New export:

```ts
/** The words of the real command: leading shell keywords and wrappers (with their options and arguments) removed, repeatedly. */
export function unwrapCommand(words: string[]): string[]
```

- **Loop:**
  1. Drop leading `KEYWORDS` words.
  2. If the first word's basename (without `.exe`) is a key of `WRAPPERS`, drop it together with its options and arguments, by exactly the rules `wrapperProblem` uses: `-` options (valued ones take two words), `env`'s `NAME=value` words, and `timeout`'s duration.
  3. Repeat until neither applies.
- **`command -v X`/`-V X`:** these only look up a name and run nothing, so the result is `[]`.
- **Empty input** gives `[]`.
- **Shared code:** move the option-skipping logic into one non-exported helper, used by both `unwrapCommand` and `wrapperProblem`, so they can't drift.
- **`wrapperProblem`'s outputs must stay the same:** every existing `readonly-bash.test.ts` test passes unchanged.
- **K5:** this is an addition. `parseCommands`, `KEYWORDS` and `WRAPPERS` are unchanged.

**Runner guard (`runner-guard.ts`).**
- **Git detection:** `runsGit(words)` is true only when the first word of `unwrapCommand(words)` has basename `git` or `gh`. The step 1 refusal condition and message stay the same.
- **Deny list:** each regex is tested against two strings per parsed command: `stripKeywords(c.words).join(" ")` and `unwrapCommand(c.words).join(" ")`. Either one matching refuses. The whole-text fallback stays for when `parseCommands` returns no commands. The message `refused by test.runnerDeny: <pattern>` is unchanged.

**Per-call records (`test-run.ts`, `index.ts`).** New pure export:

```ts
export function callDir(roundDir: string, fsx: { mkdirSync(p: string): unknown; readdirSync(p: string): string[] }, join: (...p: string[]) => string): string
```

- **Where it starts:** `n` = 1 + the number of entries of `roundDir` whose name is all digits.
- **How it picks:** it tries `mkdirSync(join(roundDir, String(n)))` without `recursive`.
  - Success: return that path.
  - `EEXIST`: increment `n` and retry.
  - Any other error: rethrow.
- **In `test_run`:** `dir = callDir(runsDir(round), fs, path.join)`. If that throws, fall back to the round folder from `runsDir`.
- **What uses `dir`:** cards, records and `Artifacts folder:` all use it. Task IDs in the results stay as given.
- **New layout:** `runs/<round>/<call n>/<id>.md` and `<id>-*.log`.

**Session-wide runner gate (`test-run.ts`, `index.ts`).** New pure export:

```ts
export function runnerGate(limit: () => number): <R>(resource: string, fn: () => Promise<R>) => Promise<R>
```

- **Per-resource lock:** for a resource whose `resourceKey` is not empty or `none`, the call waits until every earlier holder of the same key has finished (FIFO, a promise chain per key). An empty or `none` key takes no lock.
- **Global slot:** after the lock, it waits for one of `max(1, limit())` slots shared by all calls (FIFO waiters). It runs `fn`, then frees the slot, then releases the lock.
- **Errors:** both are released in `finally` when `fn` throws, and the error propagates.
- **Cleanup:** the map entry for a key is deleted when its last holder releases, so the map doesn't grow.
- **Ordering:** lock first, then slot, so a task waiting for its resource never holds a slot. This rules out deadlock: slot holders always run to completion.
- **Wiring:** `index.ts` creates one gate in the `workflow()` closure with `() => cfg.test.concurrency`. Inside `test_run`'s `runOne`, the `runRole("runner", …)` call (and only it) runs inside `gate(task.resource, …)`. `scheduleTasks` stays as it is and still orders within a call.

**Notice.** In `session_start`, after `await setPhase(ctx, start)`, when `start === "test"` and `ctx.hasUI`, show the same notice as `/flow test` with no scope (the same text and level as `index.ts:3498`).

**Failure handling.**
- `callDir` failing falls back to the round folder.
- A runner failing or throwing inside the gate releases its lock and slot. The existing `ERROR: …` result path is unchanged.
- An aborted signal makes `runRole` return early, and that also releases them.

**Scale.** Up to 8 tasks per call. A session usually makes a few parallel calls. The gate holds at most one map entry per resource in use. Per process only: two pi sessions on one device are not coordinated (documented limit).

**Rejected.**
- **Renaming reused IDs to `<id>-2`:** the supervisor matches results by its own IDs.
- **A global lock across processes:** out of scope.
- **Replacing `scheduleTasks` with the gate:** that would change the tested per-call ordering for nothing.

### 5. Steps

**S1.** `readonly-bash.ts`, next to `wrapperProblem` (`:427`): add `unwrapCommand` as in Design.
- Move `wrapperProblem`'s option-skipping (`:431-436`) into one shared non-exported helper, used by both functions. `wrapperProblem`'s behaviour must not change.
- Edge cases:
  - Nested wrappers: `timeout 5 env A=1 adb …` → `adb …`.
  - Keywords before and between wrappers: `if timeout 5 git status` → `git status`.
  - A wrapper with no command after it → `[]`.
  - `command -v git` → `[]`.

**S2.** `runner-guard.ts` `runsGit` (`:54-61`): decide by the first word of `unwrapCommand(words)` (basename `git`/`gh`). Remove the any-later-word scan.

**S3.** `runner-guard.ts` `runnerProblem` step 2: test each deny regex against both the keyword-stripped and the unwrapped words of each parsed command, as in Design. Keep the whole-text fallback and the message.

**S4.** `test-run.ts`: add `callDir` as in Design, after `scheduleTasks` (`:61`). It must not import `node:fs` directly; the fs functions are passed in, as the signature says.

**S5.** `test-run.ts`: add `runnerGate` as in Design, using `resourceKey` (`:32`). Pure, with no imports beyond what the file has.

**S6.** `index.ts` `test_run` execute (`:1852-1878`):
- **Folder:** compute `dir` with `callDir(runsDir(round), fs, path.join)`, with the fallback in Design.
- **Gate:** create the gate once in the `workflow()` closure, near the other closure-level state, with `runnerGate(() => cfg.test.concurrency)`. Wrap only the `runRole("runner", …)` call in `gate(task.resource, () => runRole(…))`.
- **Import:** add `callDir` and `runnerGate` to the existing `./test-run.ts` import.

**S7.** `index.ts` `session_start` (`:3302`): after `setPhase(ctx, start)`, add the notice for `start === "test"` with UI, using the text and level from `:3498`.

**S8.** README.md:
- **`test_run` bullet (`:198`):**
  - The record path becomes `runs/<round>/<call>/<id>.md` (each call gets its own numbered folder).
  - Add one sentence: the resource order and `test.concurrency` hold across `test_run` calls that run at the same time in one session (not across separate pi sessions).
- **Runner guard bullet (`:200`):** add one sentence: commands are checked behind wrappers too (`timeout`, `env`, `xargs`, `nice`, …), so `timeout 60 adb reboot` is refused and only a real `git`/`gh` command counts as git.

### 6. Tests

**`readonly-bash.test.ts`**, new test "unwrapCommand":
- `["timeout","60","adb","-s","R58","reboot"]` → `["adb","-s","R58","reboot"]`
- `["env","X=1","fastboot","flash","boot","x"]` → `["fastboot","flash","boot","x"]`
- `["timeout","-s","KILL","5","git","push"]` → `["git","push"]`
- `["if","git","status"]` → `["git","status"]`
- `["timeout","5","env","A=1","adb","devices"]` → `["adb","devices"]`
- `["command","-v","git"]` → `[]`
- `["timeout","5"]` → `[]`

Every existing test in the file must still pass unchanged.

**`runner-guard.test.ts`** (uses its existing `problem` helper and spec):
- "deny patterns apply behind wrappers": `timeout 60 adb -s R58 reboot` and `env X=1 fastboot flash boot x` each return text matching `/runnerDeny/`.
- "git behind a wrapper is the real command only":
  - `timeout 60 unity run-tests --project-path D:/projects/game/git` → null. The project path must be inside the test spec's roots; use a root path the existing tests already accept (check the spec at the top of the file, adjusting the path to lie under it).
  - `timeout 60 npm test -- --grep gh` → null.
  - `timeout 60 git push` matches `/git or GitHub/`.

**`test-run.test.ts`:**
- "runnerGate: one runner per resource across calls":
  - Two `gate("unity:D:/p", …)` calls started together never overlap. Measure with a counter of active `fn`s, each awaiting a short timer.
  - Two calls on different resources (limit 4) do overlap.
  - `UNITY:D:/P` and `unity:d:/p` count as the same resource.
- "runnerGate: global limit": with `limit` 1, three `none` tasks never overlap. With limit 3, they do.
- "runnerGate: releases on error": a throwing `fn` rejects its call, and the next call on the same resource still runs.
- "callDir": with a fake fs whose round folder lists `["1", "a.md"]`, the first try is `…/2`. If `mkdirSync` throws `{ code: "EEXIST" }` once, the result is `…/3`. Another error code is rethrown.

**Commands**, from `pi/agent/extensions/workflow`:
- Run `node --experimental-strip-types --test *.test.ts 2>&1 | grep -E "^(✖|ℹ (tests|pass|fail))"`. Expected: fail 0, and the test count up from 520 by the new tests.
- Typecheck: in `/tmp/wfty`, run `node /tmp/readycheck/node_modules/typescript/bin/tsc -p .`. Expected: only the 5 errors that are already there (`waitForIdle`/`reload` index.ts, `aborted` index.ts, `findLast`/implicit any subagent.ts:137).

### 7. Done when

- `timeout 60 adb -s R58 reboot` and `env X=1 fastboot flash boot x` are refused by the runner deny list.
- `timeout 60 unity run-tests --project-path <inside the roots>/git` and `timeout 60 npm test -- --grep gh` are allowed. `timeout 60 git push` is still refused.
- Two `test_run` calls in one round write to separate `runs/<round>/<n>/` folders, so no record or log is overwritten.
- Runners from parallel `test_run` calls never share a non-`none` resource at once, and never exceed `test.concurrency` in total.
- `--flow test` at session start shows the "describe what to test" notice.
- README describes the new record path, the cross-call ordering and the wrapper handling.
- The full suite passes and the typecheck shows only the pre-existing errors.

### 8. Risks, rollback, what not to touch

- **Risks:**
  - The unwrapped deny check could refuse more than before: for example, a deny pattern that now matches the real command behind `xargs`. That is the intended direction.
  - Unwrapping `xargs` sees only its static words, not the input piped into it (documented guard limit).
  - The gate only covers one pi process.
- **Rollback:** each commit reverts on its own.
- **Don't touch:**
  - the K5 exports (`parseCommands`, `KEYWORDS`, `WRAPPERS`);
  - `commandProblem`'s rules;
  - push-guard and commit-guard;
  - `delivery.ts`;
  - the normal judge prompts;
  - `worktree/`;
  - `scheduleTasks`'s behaviour;
  - `runsDir`'s signature;
  - the RUNNER prompt text.

### 9. Commits

- `fix(workflow): runner guard looks through command wrappers`: `readonly-bash.ts`, `readonly-bash.test.ts`, `runner-guard.ts`, `runner-guard.test.ts`, README.md (runner guard sentence).
- `fix(workflow): test_run records per call and a session-wide runner gate`: `test-run.ts`, `test-run.test.ts`, `index.ts` (test_run part), README.md (`test_run` bullet).
- `fix(workflow): describe-what-to-test notice for --flow test`: `index.ts` (`session_start`).

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 `readonly-bash.ts`, next to `wrapperProblem` (`:427`): add `unwrapCommand` as in Design.
- [ ] S2 `runner-guard.ts` `runsGit` (`:54-61`): decide by the first word of `unwrapCommand(words)` (basename `git`/`gh`). Remove
- [ ] S3 `runner-guard.ts` `runnerProblem` step 2: test each deny regex against both the keyword-stripped and the unwrapped words
- [ ] S4 `test-run.ts`: add `callDir` as in Design, after `scheduleTasks` (`:61`). It must not import `node:fs` directly; the fs 
- [ ] S5 `test-run.ts`: add `runnerGate` as in Design, using `resourceKey` (`:32`). Pure, with no imports beyond what the file ha
- [ ] S6 `index.ts` `test_run` execute (`:1852-1878`):
- [ ] S7 `index.ts` `session_start` (`:3302`): after `setPhase(ctx, start)`, add the notice for `start === "test"` with UI, using
- [ ] S8 README.md:
