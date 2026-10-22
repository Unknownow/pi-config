<!-- pi-workflow plan v1 flow=20261022-1557-faster-unity-test-runs-reuse-library-ski-e6f4 -->
## Plan: Faster Unity test runs: reuse Library, skip unchanged inputs, run variants in parallel, and rerun slow suites only when needed

### 1. Goal and non-goals
- **Goal:** cut the Unity time per flow (about 60-100 min today) by four changes:
  - **Fix 1:** `test-packages.mjs` keeps Unity's `Library` between runs.
  - **Fix 4:** `test-packages.mjs` skips a variant whose inputs are unchanged since its last pass.
  - **Batching:** `test-packages.mjs` runs the full and lite variants at the same time.
  - **Fixes 2-3:** the workflow prompts tell executors to iterate on narrow checks, run each slow suite in full once before the first judge call, and after a judge round rerun a slow suite only if the fix touched what that suite builds or reads.
- The knowledge playbooks describe the new behaviour.
- **Non-goals:**
  - No change to `test-ads-set.mjs` behaviour: no `Library` reuse and no parallel Android/iOS.
  - No change to `copyProject`, `scratch-android-build.mjs` or `lib/package-dev.mjs`.
  - No result caching inside the workflow extension, and no new workflow tool.
  - The final success line of `test-packages.mjs` stays byte-identical.

### 2. User decisions
- **D1:** Include fix 4 (skip a run when nothing changed) together with fixes 1-3.
- **D2:** Fix 4 lives in the harness (`test-packages.mjs`), keyed by a hash of everything the run reads, not by the workflow's diff hash.
- **D3:** Batch the checks: full and lite run at the same time by default. The machine has 32 GB of RAM, so no memory concern. `--serial` stays as a fallback.
- **D4:** `test-ads-set.mjs` is not parallelized and does not reuse `Library`, because its local registry republishes the same versions. It runs once at the end, and only when the ads packages changed.
- **D5:** The executor runs the Unity batch-mode verification runs itself. They are not a person's `Wait:` step.
- **D6:** Three stages: unity-packages harness, pi-config workflow prompts, knowledge playbooks. Stage 3 runs only after stage 1 is merged.
- **D7:** Delivery per stage:
  - Stage 1 (unity-packages): merge, after checks pass.
  - Stage 2 (pi-config): push.
  - Stage 3 (knowledge): merge.
- **D8:** In `docs/workflow-improvements.md`, fixes 2 and 3 are new rows A23 and A24, marked Done.

### 3. Facts
**`D:/projects/unity-packages/scripts/test-packages.mjs`** (on `main`, up to date with origin):
- `:1-14`: the header comment. Line 14: "Each variant imports a fresh project: about 5-10 minutes."
- `:18`: `spawnSync` import. `:20`: `copyProject` and `defaultUnity` are imported from `./test-ads-set.mjs`.
- `:47-97`: `runVariant(args, variant)`:
  - `:49`: `mkdtempSync(os.tmpdir()/packages-test-<variant>-)`.
  - `:52`: `copyProject`. `:53-54`: copies the template's `scripts/` to `<work>/scripts`.
  - `:56-59`: edits the manifest with `editManifest`, then deletes `packages-lock.json`.
  - `:65`: `spawnSync(unity, ["-batchmode","-nographics","-projectPath",project,"-runTests","-testPlatform","EditMode","-testResults",results,"-logFile",log], { timeout: 60*60*1000 })`.
  - `:66-88`: parses compile errors and results into `problems`.
  - `:89-96`: deletes the work folder on a pass unless `--keep`.
- `:99-121`: `main(argv)` parses arguments with an inline loop (`--template`, `--package`, `--variant`, `--unity`, `--keep`). `:117-118` runs the variants with `flatMap` one after the other. `:119` prints the final line:
  `` `\n${args.packages.join(", ")}: compiled and all tests passed (${variants.join(", ")}).` ``
- `:123-130`: the entry point is `process.exitCode = main(...)`, and errors give exit code 2.

**Elsewhere in unity-packages:**
- `scripts/test-ads-set.mjs:109-119`: `copyProject` skips the top-level `Library`, `Temp`, `Logs`, `UserSettings`, `.vscode`, `obj` and `Builds` folders, and `*.csproj`/`*.sln`/`*.slnx` files.
- `scripts/scripts.test.mjs:14`: imports `parseResults` and `editManifest` from `./test-packages.mjs`. The existing tests are at `:261` and `:279`.
- `AGENTS.md:28`: before pushing, run `node scripts/package.mjs check`, which is `node --test "scripts/*.test.mjs"`.
- `scripts/lib/test-flow.mjs:45-50`: the menu passes `--variant`.

**`D:/projects/pi-config/pi/agent/extensions/workflow/prompts.ts`:**
- `:97`: the execute bullet "When done, run the plan's tests, then call `judge` with `focus` set to the plan's title. …"
- `:75`: planner item "6. Tests: each new or changed test (file, name, input, expected result), plus the commands to run and the expected output."
- `FIX_ROUND`, around `:192-198`: "Run the step's Repro and the suites named under Facts before you call judge."
- `prompts.test.ts:4` imports `EXECUTE_PHASE`, `planPhase` and the other prompts.

**`D:/projects/pi-config/docs/workflow-improvements.md`:**
- `:5`: the Status line.
- Section A ("Time and parallelism", `:27`) ends with the A22 row at `:52`.
- The Effect measurement table's A22 row is at `:165`.
- Row format: `| A22 | Problem: … **Implemented:** … | Medium (T) | M | Low. … | <measure> |`.
- The repo is on `master`.

**`D:/projects/knowledge`** (branch `main`, 2 commits behind origin):
- `entries/eng/playbook/release-code-packages.md:29` (step 2, "Test before tagging").
- `entries/eng/guideline/sdk-wrapper-packages.md:32` (step 7, "Verify").
- The repo check is `npm run check`.

### 4. Design

**Components (all in `scripts/test-packages.mjs`):**

- **Cache folder.**
  - Location: `path.join(os.tmpdir(), "iec-packages-test")`.
  - Each variant gets its own project folder `<cache>/<h8>-<variant>`, where `h8` is the first 8 hex characters of the sha256 of the lower-cased absolute template path. Inside it: `project/`, `scripts/`, `unity.log`, `results.xml`.
  - The pass record is `<cache>/passes.json`.
- **Mirror (fix 1).** Brings `<folder>/project` up to date with the template's `unity` folder, and `<folder>/scripts` with the template's `scripts`, without a full copy.
  - Uses the same skip rules as `copyProject`, at the top level of the source. In the destination, it never deletes or touches the skipped folders.
  - Copies a file when it is missing, its size differs, or its `Math.floor(mtimeMs)` differs. Copies keep the source timestamps (`fs.copyFileSync` then `fs.utimesSync`, or `cpSync` with `preserveTimestamps`).
  - Deletes destination files that are gone from the source, then empty folders.
  - `Packages/manifest.json` and `Packages/packages-lock.json` are excluded from the mirror. Each run builds the edited manifest from the template's manifest, as today. It writes the file only if the content differs, and deletes `packages-lock.json` as today.
- **Lock.**
  - File `<folder>.lock`, created with flag `wx`, containing the pid. It is removed in a `finally` block.
  - If the lock exists and its pid is alive (`process.kill(pid, 0)` doesn't throw), the variant falls back to the old behaviour: a new `mkdtemp` folder with a full `copyProject`, deleted after a pass unless `--keep`. The run prints `<variant>: cache folder in use by pid <pid>; using a fresh copy`.
  - If the pid is dead, the stale lock is taken over.
- **Input hash (fix 4).** `collectInputs(...)` returns the entries below, and `inputsHash(entries)` returns their sha256 hex.
  - Entries, each as `{ key, data }`:
    - `variant` = the variant name;
    - `packages` = the sorted package list, joined with `\n`;
    - `unity` = the Unity executable path, size and `mtimeMs`;
    - `extras` = JSON of `readDevConfig(ROOT).packages[n]` for each package;
    - the files under the template's `unity/Assets`, `unity/Packages` and `unity/ProjectSettings`, and its `scripts/`, keyed `template/<rel>`;
    - every file under each linked package folder `ROOT/<name>`, skipping `.git`, `node_modules` and the `copyProject` skip names, keyed `pkg/<name>/<rel>`;
    - `scripts/test-packages.mjs` and every file under `scripts/lib/`, keyed `harness/<rel>`.
  - Relative paths use `/`.
  - The hash sorts entries by key and feeds each one in as `key`, `\0`, the byte length, `\0`, then the data.
- **Pass record.**
  - Format: `passes.json` is `{ "<sha256>": { "variant": "full"|"lite", "at": "<ISO 8601>" } }`.
  - `main` writes it once after all variants finish, adding each variant that had no problems. It keeps the newest 200 entries and writes atomically (temp file, then rename).
  - A missing or unreadable file counts as `{}`.
- **Skip.**
  - If the variant's hash is already in the record and `--fresh` is not set, the variant does no mirror, lock or Unity run. It prints exactly:
    `== <variant>: unchanged since the pass at <at> (<first 8 of hash>), not run`
    and counts as passed with no problems.
  - The final line keeps the exact `:119` format, so `compiled and all tests passed (full, lite).` still appears.
- **Parallel.**
  - `runVariant` becomes async and uses `spawn` with the same arguments, the same 60-minute `timeout` and `windowsHide: true`. It resolves on `close`.
  - With `both` and no `--serial`, the two variants run concurrently with `Promise.all`. Beforehand, `main` prints one line: `running full and lite at the same time`.
  - Each variant collects its output lines into a buffer instead of printing. When all are done, `main` prints the full block, then the lite block, then the final line.
  - With `--serial`, the variants run one after the other, each block printed when it finishes.
  - `main` becomes async. The entry point awaits it and still sets `process.exitCode`, with exit code 2 on thrown errors.
- **Flags.**
  - `--fresh`: if the variant's cache folder is locked by a live pid, throw `cache folder <path> is in use by pid <pid>` (exit 2). Otherwise delete the folder, ignore the pass record, and record the new pass on success.
  - `--serial`: run the variants one after the other.
  - `--keep`: still accepted. It now only affects fallback `mkdtemp` folders, because cache folders are always kept.
  - Unknown flags throw, as today.
- **Failure hints.** When a variant that reused a cache folder has problems, add the line `if this looks like a stale cache, run again with --fresh`. Never retry automatically.

**Exported functions** (exact names, for the tests):
```js
export function parseArgs(argv)        // → { template, packages, variant, unity, keep, fresh, serial }; throws on unknown flags; template not validated here
export function cacheFolder(template, variant, base = path.join(os.tmpdir(), "iec-packages-test"))  // → absolute path
export function mirrorPlan(src, dest)  // src/dest: Map<rel, {size, mtimeMs}> → { copy: string[], remove: string[] } (sorted)
export function collectInputs({ template, packages, variant, unity, root = ROOT })  // → Array<{ key, data }>
export function inputsHash(entries)    // → sha256 hex string; independent of entry order
```
`main` keeps validating the template, the Unity path and the packages as it does today, after `parseArgs`.

**Compatibility:**
- Existing callers (`lib/test-flow.mjs`, the playbooks, existing plans' `grep -qF` checks) keep working, because the flags and the final line are unchanged.
- The old `mkdtemp` folders are not cleaned up.

**Scale:**
- 2 cache folders per template path, each a few GB (about one Unity `Library`).
- Hashing the template and packages takes a few thousand files, a few seconds.
- The design stops paying off when the template's `Assets` grow to tens of thousands of files (hashing above about 30 s), or when many worktrees each fill their own cache folder and the disk.

**Rejected:**
- **A workflow diff hash for fix 4:** it misses inputs from other repos.
- **Copying the template's own `Library` in:** the open Editor locks it, and the manifest differs.
- **Parallel and cached `test-ads-set`:** see D4.

### 5. Steps

### Stage 1: unity-packages test-packages: reuse Library, skip unchanged inputs, run variants in parallel

**S1.** In `D:/projects/unity-packages`, check that `main` is clean and up to date (`git status -sb`, `git fetch`, `git merge --ff-only origin/main`). If it isn't, stop and report.

**S2.** In `scripts/test-packages.mjs`, add `parseArgs` and `cacheFolder` as specified in section 4, replacing the inline loop at `:100-108`. Model the parsing on that loop. `--fresh` and `--serial` default to `false`.

**S3.** Add `mirrorPlan` (pure) and a non-exported mirror routine that applies it as described in section 4.
- The routine lists source and destination files with the `copyProject` skip rules from `test-ads-set.mjs:110-116`, applied to the top-level path segment.
- It excludes `Packages/manifest.json` and `Packages/packages-lock.json`.
- It also mirrors the template's `scripts/` into `<folder>/scripts` when that folder exists, and deletes `<folder>/scripts` when it doesn't.

**S4.** Add `collectInputs` and `inputsHash` as specified, plus non-exported helpers that read and write `passes.json` (missing or broken file means `{}`; keep the newest 200 entries; atomic write).

**S5.** Rewrite `runVariant` as async:
- skip check;
- lock or fallback;
- mirror, or `copyProject` for a fallback;
- manifest written only if it changed, then lock file deleted;
- `spawn`, with the same arguments as `:65`;
- the existing result parsing (`:66-88`) unchanged.

All output goes into a returned `lines` array. The returned object is `{ variant, lines, problems, hash, reused }`.
- Fallback folders keep today's delete-on-pass behaviour (`:89-96`). Cache folders are never deleted except by `--fresh`.
- Keep the `(<seconds> s, log: <path>)` line.

**S6.** Rewrite `main` as async:
- Run the variants in parallel, or serially with `--serial`, then print the blocks in the order full, lite.
- Write passed hashes to `passes.json`.
- Print the unchanged final line from `:119`. Return 0 or 1 as today.

Update the entry point (`:123-130`) to await `main`.

**S7.** Update the header comment (`:1-14`):
- the new flags `[--fresh] [--serial]`;
- the cache folder location;
- that the variants run at the same time;
- that unchanged inputs are not run again;
- that the first run per template is about 5-10 minutes, and later runs take only the recompile.

In `AGENTS.md`, add one bullet near `:28` saying that `test-packages.mjs` caches per template and variant, that `--fresh` forces a clean import, and that `--fresh` should be used before tagging a release.

**S8.** Add the tests in section 6 to `scripts/scripts.test.mjs`, then run `node scripts/package.mjs check`. It must pass.

**S9.** Verify in Unity yourself (D5). Run each command from `D:/projects/unity-packages` in Git Bash and note the wall time of each:
1. `node scripts/test-packages.mjs --template D:/projects/game-template --variant both --fresh 2>&1 | tail -30`
2. The same command without `--fresh`. Expect two `unchanged … not run` lines and the final success line within seconds.
3. Add a blank line to one `.cs` file in `com.iecgames.core/Runtime`, run without `--fresh`, then revert the edit with `git checkout -- <file>`. Expect both variants to run, with `Library` reused, faster than run 1.

Put the three times, and the line showing the variants ran at the same time, in the PR description.
- If Unity or the registry token is missing, stop and report. Don't work around it.
- If run 1 fails because the template itself doesn't compile on `main`, report it. That is not part of this change.

### Stage 2: workflow prompts: slow suites once, reruns only when touched (delivery: push)

**S10.** In `D:/projects/pi-config/pi/agent/extensions/workflow/prompts.ts:97`, replace "When done, run the plan's tests, then call `judge`" so the bullet says the following (these substrings are exact; the rest of the bullet stays):
- "While fixing, run the narrowest check that covers the change"
- "Run each slow suite in full once, before your first judge call"
- "After a judge round, rerun a slow suite only if the fix changed files it builds or reads; otherwise cite its last passing run"

Fast suites are still run before every judge call. Keep everything after "then call `judge`" (focus, findings, disputes) unchanged.

**S11.** In the planner item at `prompts.ts:75`, append exactly "Mark each suite slower than about 2 minutes as slow and give its fast command for fixing and its full command, run once." In `FIX_ROUND` (around `:197`), after "Run the step's Repro and the suites named under Facts before you call judge.", add the same sentence used in S10: "After a judge round, rerun a slow suite only if the fix changed files it builds or reads; otherwise cite its last passing run."

**S12.** In `docs/workflow-improvements.md`, add two rows to section A, after A22 (`:52`), in the existing row format:
- **A23:** "Problem: executors reran slow suites (Unity batch mode, 10-20 min) before every judge call. **Done:** prompts.ts: narrow checks while fixing, each slow suite in full once before the first judge call; the planner marks slow suites with a fast and a full command." Benefit High (T), Effort S, Risk "Medium. A narrow check can miss a failure the full suite catches; the full run before the first judge call covers it."
- **A24:** "Problem: a judge round that only changed docs or comments triggered a full slow rerun. **Done:** prompts.ts (execute and fix round): rerun a slow suite only if the fix changed files it builds or reads." Benefit Medium (T), Effort S, Risk "Medium. The executor decides what a suite reads; the judge still reviews."

Add matching rows to the Effect measurement table after `:165`:
- A23: measure Unity harness runs per flow and their minutes, from session logs. "Implemented, not measured yet." Target: one full run per stage.
- A24: measure slow reruns after a judge round whose fix touched no code. "Implemented, not measured yet." Target: zero.

Add "A23 and A24 are implemented" to the Status line (`:5`).

**S13.** Add the `prompts.test.ts` checks in section 6. Run the workflow tests (section 6).

### Stage 3: knowledge playbooks (after: stage 1 merged; check: `git -C D:/projects/unity-packages fetch origin main && git -C D:/projects/unity-packages grep -q -e "--serial" origin/main -- scripts/test-packages.mjs`)

**S14.** In `D:/projects/knowledge`, fast-forward `main` (`git fetch`, then `git merge --ff-only origin/main`). If that fails, stop and report.

**S15.** In `entries/eng/playbook/release-code-packages.md:29`, keep the existing commands and add that:
- `--variant both` runs full and lite at the same time, reuses each variant's `Library` and skips variants whose inputs haven't changed since their last pass;
- before tagging, use `--fresh` for a clean import;
- while iterating, use `--variant lite --package <changed package>`;
- `test-ads-set.mjs` runs once at the end, and only when the ads packages changed.

In `entries/eng/guideline/sdk-wrapper-packages.md:32`, add the same iterate-narrow, full-once and `--fresh` guidance in one sentence. Follow the repo's front-matter rules: if `npm run check` asks for an updated date or version field, update it.

**S16.** Run `npm ci` if `node_modules` is missing, then `npm run check`. It must pass.

### 6. Tests
**`unity-packages/scripts/scripts.test.mjs`** (new tests; import the new exports next to `:14`):
- `test-packages: parseArgs reads --fresh and --serial`:
  - `parseArgs(["--template","x","--fresh","--serial"])` has `fresh: true` and `serial: true`.
  - With neither flag, both are `false`, and `variant` is `"both"`.
  - `parseArgs(["--bogus"])` throws.
- `test-packages: cacheFolder is per template and variant`:
  - The same template with `full` and `lite` gives different folders under the given base.
  - The same template path in different case gives the same folder.
  - Different templates give different folders.
- `test-packages: mirrorPlan copies new and changed files and removes gone ones`:
  - src `{a:{1,100}, b:{2,100}, c:{3,100}}`, dest `{a:{1,100}, b:{2,999}, d:{4,100}}`.
  - Expected: `copy: ["b","c"]`, `remove: ["d"]`.
- `test-packages: the input hash ignores Library and changes with a source file`. In a temp dir, build a fake template:
  - `unity/Assets/A.cs`, `unity/Packages/manifest.json`, `unity/ProjectSettings/P.asset`, `unity/Library/x.bin`;
  - a fake package folder, used as `root` with `<root>/<name>/package.json` and `<root>/scripts/test-packages.mjs`;
  - a fake Unity file.

  Then check, with `inputsHash(collectInputs(...))`:
  - two calls give the same hash;
  - after changing `unity/Library/x.bin`, the hash is unchanged;
  - after changing `unity/Assets/A.cs`, the hash changes;
  - after changing the package's `package.json`, the hash changes;
  - `variant: "lite"` gives a different hash from `"full"`;
  - `inputsHash` of the same entries in reversed order gives the same hash.
- The existing tests at `:261` and `:279` stay unchanged and pass.
- Command: `cd D:/projects/unity-packages && node scripts/package.mjs check`. Expected: all tests pass and the check is clean.
- Real Unity runs: S9, with the expected output listed there.

**`pi-config/pi/agent/extensions/workflow/prompts.test.ts`** (new test `slow suites run once and rerun only when touched`):
- `EXECUTE_PHASE` contains the three S10 substrings and still contains "then call `judge`".
- `planPhase(...)`, called with the same arguments the existing tests use, contains "Mark each suite slower than about 2 minutes as slow".
- `FIX_ROUND` (import it) contains "rerun a slow suite only if the fix changed files it builds or reads".
- Command: `cd D:/projects/pi-config/pi/agent/extensions/workflow && node --test *.test.ts 2>&1 | grep -E "^ℹ (pass|fail)"`. Expected: `fail 0`.

**knowledge:** `npm run check` passes.

### 7. Done when
- `test-packages.mjs` keeps a cache folder per template and variant and reuses `Library`.
- An immediate rerun with no changes skips both variants with the `unchanged … not run` line and still prints `compiled and all tests passed (full, lite).`
- `--fresh` forces a clean import.
- `both` runs full and lite at the same time; `--serial` runs them one after the other.
- `test-ads-set.mjs` behaviour is unchanged.
- The three S9 times are reported in the stage 1 PR.
- The execute, planner and fix-round prompts contain the narrow, full-once and rerun-only-when-touched rules.
- `docs/workflow-improvements.md` has A23 and A24 as Done, with Status and Effect measurement rows.
- Both knowledge playbooks describe the new flags and the iterate-narrow guidance.
- The tests pass in all three repos.
- Stage 1 and stage 3 are merged; stage 2 is pushed.

### 8. Risks, rollback, what not to touch
- **Stale `Library` causes odd failures.** Mitigation: the `--fresh` hint, and the playbooks use `--fresh` before tagging. Rollback: revert the stage 1 merge commit; the cache folders are harmless leftovers.
- **A skip on a wrong hash hides a real failure.** The hash covers every file the run reads, plus the harness itself. `--fresh` overrides it.
- **Two Unity instances at once** may hit Package Manager hiccups. `--serial` is the fallback. Don't add automatic retries.
- **Narrow checks miss a failure** (stage 2): the full run before the first judge call covers it. Rollback: revert the stage 2 commit.
- **Don't touch:**
  - `test-ads-set.mjs` (including `copyProject`), `scratch-android-build.mjs`, `lib/package-dev.mjs`, `lib/test-flow.mjs`;
  - the success line format at `test-packages.mjs:119`;
  - workflow code other than `prompts.ts`, `prompts.test.ts` and the backlog doc;
  - other knowledge entries;
  - the open PRs game-template #153 and knowledge #155.
- Don't start the Unity Editor. Only batch mode, through the harness.

### 9. Commits
- **Stage 1:** `feat(test-packages): reuse Library, skip unchanged inputs, run variants in parallel`. Files: `scripts/test-packages.mjs`, `scripts/scripts.test.mjs`, `AGENTS.md`.
- **Stage 2:** `feat(workflow): run slow suites once and rerun them only when a fix touches them`. Files: `pi/agent/extensions/workflow/prompts.ts`, `pi/agent/extensions/workflow/prompts.test.ts`, `docs/workflow-improvements.md`.
- **Stage 3:** `docs(playbooks): faster test-packages runs and iterate-narrow guidance`. Files: `entries/eng/playbook/release-code-packages.md`, `entries/eng/guideline/sdk-wrapper-packages.md`.

<!-- pi-workflow:status -->
## Checklist
- [x] S1 In `D:/projects/unity-packages`, check that `main` is clean and up to date (`git status -sb`, `git fetch`, `git merge --
- [x] S2 In `scripts/test-packages.mjs`, add `parseArgs` and `cacheFolder` as specified in section 4, replacing the inline loop a
- [x] S3 Add `mirrorPlan` (pure) and a non-exported mirror routine that applies it as described in section 4.
- [x] S4 Add `collectInputs` and `inputsHash` as specified, plus non-exported helpers that read and write `passes.json` (missing 
- [x] S5 Rewrite `runVariant` as async:
- [x] S6 Rewrite `main` as async:
- [x] S7 Update the header comment (`:1-14`):
- [x] S8 Add the tests in section 6 to `scripts/scripts.test.mjs`, then run `node scripts/package.mjs check`. It must pass.
- [x] S9 Verify in Unity yourself (D5). Run each command from `D:/projects/unity-packages` in Git Bash and note the wall time of 
- [ ] S10 In `D:/projects/pi-config/pi/agent/extensions/workflow/prompts.ts:97`, replace "When done, run the plan's tests, then ca
- [ ] S11 In the planner item at `prompts.ts:75`, append exactly "Mark each suite slower than about 2 minutes as slow and give its
- [ ] S12 In `docs/workflow-improvements.md`, add two rows to section A, after A22 (`:52`), in the existing row format:
- [ ] S13 Add the `prompts.test.ts` checks in section 6. Run the workflow tests (section 6).
- [ ] S14 In `D:/projects/knowledge`, fast-forward `main` (`git fetch`, then `git merge --ff-only origin/main`). If that fails, st
- [ ] S15 In `entries/eng/playbook/release-code-packages.md:29`, keep the existing commands and add that:
- [ ] S16 Run `npm ci` if `node_modules` is missing, then `npm run check`. It must pass.
