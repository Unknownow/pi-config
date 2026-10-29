<!-- pi-workflow plan v1 flow=20261029-1408-test-the-gate-s-protected-push-wording-m-e17f -->
## Plan: Test the gate's protected-push wording, merge base PR #3, ship the Unity fork v0.1.0

### 1. Goal and non-goals
**Goal.**
- Add one test to the workflow extension. It covers the protected-push wording of the missing-head refusal in `merge-gate.ts:33`, which PR #14 introduced.
- Merge base PR #3 on `Unknownow/game-studio-base`. Do it from the working folder with `--repo` and no `cd`, so the new merge gate gets exercised.
- Ship the Unity fork `Unknownow/game-studio-unity` v0.1.0. These are steps S3–S9 of the paused plan `20261029-1151-…`, unchanged:
  - fast-forward to base `main`;
  - `Assets/` in uppercase;
  - four commits that only add files;
  - green CI;
  - tag `v0.1.0`;
  - template flag.
  - Finally, delete `/tmp/ghcfg-unknownow`.

**Non-goals:**
- Fixing the prompt-capture error (D24). Its cause is unconfirmed.
- Changing `pi-claude-bridge`, pi, or the workflow's `turn_start` refilter (`index.ts:3073-3075`).
- Changing production code in the workflow extension.
- Retagging base `v0.1.0`.
- Editing any base-owned file in the fork.
- Fixing `check.py:309` in base.
- Carrying judge passes across flows.

### 2. User decisions
- D1: Keep the merge-gate fix in the workflow extension, and keep judge passes reset with each new flow.
- D2: The prompt-capture error is first confirmed with a `CLAUDE_BRIDGE_DEBUG=1` run. It stays an idea (D24) in this plan.
- D3: pi-config changes go through a branch and a PR on `Unknownow/pi-config`, then a merge.
- D4: Use gh against Unknownow repos only with `GH_CONFIG_DIR=/tmp/ghcfg-unknownow`. Never run `gh auth switch` and never print the token. Keep the directory until the fork's template step, then delete it.
- D5: A repo's remote is `origin`, else its first remote. Other remotes never match.
- D6: PR #3 and the Unity fork resume now, after the gate fix is merged and pi has restarted. Merge PR #3 without a `cd` workaround.
- D7: The fork is cloned from base `main` and only adds files. `git diff --diff-filter=MDR base/main..main` must be empty, checked against base `main` after PR #3.
- D8: The fork's first commits go straight to `main`. Base changes go through a PR.
- D9: Uppercase `Assets/` is the asset root. On Windows, use `core.ignorecase=false` and a two-step rename.
- D10: The four fork commits, with their subjects, are as in §9.
- D11: Stop and report on any of these: a failed ff-merge, a stash restore conflict, a Unity licence error, red CI, or lowercase `assets/` coming back.
- D12: The human Verify steps are left to the user. The executor doesn't run them.
- D13: The test for the protected-push wording is its own small PR on pi-config, merged before PR #3.

### 3. Facts the executor needs
- **Shell:**
  - Bash on Windows 11.
  - Every bash call that runs Python starts with `export PATH="/c/Users/IEC-WW/AppData/Local/Programs/Python/Python312:$PATH"`. The default `python` is 3.9.
  - `core.ignorecase` defaults to true.
- **Guard:**
  - A merge, or a push to a protected branch, must be its own bash command with nothing chained to it. It runs only after `judge` has passed that exact tree.
  - `GH_TOKEN=$(…)` inline is refused.
  - gh commands take the form `GH_CONFIG_DIR=/tmp/ghcfg-unknownow gh … --repo Unknownow/<repo>`.
  - `/tmp/ghcfg-unknownow/hosts.yml` exists. Never print or change it.
- **pi-config:**
  - `D:/projects/pi-config` is currently on the merged branch `fix/workflow-gate-minor`, and it is clean.
  - PR #14 is merged into `master`. Local `origin/master` is stale until fetched.
- **The code under test:** `pi/agent/extensions/workflow/merge-gate.ts:30-33`, `gateProblem(kind, f)`:
  - When `!f.tree && f.commit`, it returns `` `${f.what}: its head ${f.commit.slice(0, 7)} is not in this repo; ` ``, followed by `run the merge in the repo it belongs to, or ` (only when `kind === "merge"`), followed by `fetch that commit first`.
  - `GateKind` = `"merge" | "protected-push" | "publish"` (`merge-gate.ts:8`).
- **The test to model on:** `merge-gate.test.ts:229-234`, "gateProblem: a head missing from the repo is named, not called unjudged".
  - It is followed by the `gateCheck` test at `:236-242`.
  - The file currently has 22 tests.
- **Base:**
  - Repo `D:/personal/game-studio-base`. The local checkout is clean, on `fix/assets-root-and-layer-tests` at `2dcc797`, which equals origin.
  - PR #3 is OPEN, MERGEABLE, with CI `check` green.
  - `v0.1.0^{commit}` starts with `063372c`.
  - `git checkout main` fails there because of an untracked `assets/data/README.md`. Leave it.
  - CI is `.github/workflows/check.yml`.
- **Merge gate (new, live since the restart):**
  - A `gh pr merge N --repo owner/name` with no `cd` is checked in the flow repo whose `origin` (else first) remote matches.
  - It is refused with "…must name a repo of this flow…" when no flow repo matches (`push-guard.ts`, `REPO_UNKNOWN`).
  - A repo joins the flow only after one of its files is edited with `edit`/`write`.
  - Judge passes are per flow, so PR #3's tree needs a new pass in this flow.
  - `judge` says "No changes to review" when its base equals HEAD, and records nothing (`index.ts:2918-2921`). Pass `base: "origin/main"` so it reviews PR #3's diff.
- **Fork:** facts and commands are in the paused plan `D:/projects/pi-config/.git/pi/plans/20261029-1151-merge-base-pr-3-then-finish-and-ship-the-eca5/plan.md`, §3 (lines 47-77), §6 (158-177), §8 (199-218) and §9 (219-226). The executor reads them before Stage 3. Key points:
  - `D:/personal/game-studio-unity` is on `main` at `48ccc4c` with nothing committed on top. Its remotes are `base` and `origin` (`git@github-personal:Unknownow/game-studio-unity.git`).
  - The index tracks lowercase `assets/data/README.md`. The groundwork (ENGINE.md, Packages/, ProjectSettings/, engine-reference/unity/, engine.toml, rules/unity/, roles/unity-*.md, studio-tests/agents/engine/unity/, files.manifest.d/unity.manifest, UPSTREAM.unity.toml, tools/gamestudio/engines/unity.py, tools/gamestudio/tests/test_engine_unity.py, and the Unity `.meta` files under `assets/`) is untracked.
  - Unity: `"C:/Program Files/Unity/Hub/Editor/6000.3.25f1/Editor/Unity.exe"`. The EditMode and batch-check command lines are in the paused plan, lines 71-74.
  - Already verified on this tree: `test_engine_unity` 19 OK, EditMode 45/45, `ProjectSettingsCheck`/`MissingReferenceAudit` exit 0, `test-run` 41/41.
- **Tags:** the fork tag `v0.1.0` is created with `deliver {tag: {name: "v0.1.0", repo: "D:/personal/game-studio-unity"}}`.

### 4. Design
There are no new components. Stage 1 adds one unit test. Stages 2 and 3 are delivery plus a case-correct fast-forward of work that already exists.

- **Fork merge route:**
  1. Set `core.ignorecase=false`.
  2. Stash, including untracked files. No `--all`, so ignored `Library/` stays out of the stash.
  3. Run `merge --ff-only base/main`.
  4. Restore the stash.
  5. Rename on disk `assets` → `_assets_tmp` → `Assets`.
  6. Stage the result, and `git rm --cached` any leftover `assets/` path.
- **Failure handling:**
  - Stop and report, with no workaround, on any D11 event.
  - If the gate refuses PR #3 after a passing judge, stop and report the exact message. Don't push to `main` directly, don't use `git_task` as a bypass, and don't change the tree to provoke a new judge round.
  - If the fork needs a base file changed, stop and report.
- **Rejected:**
  - A `cd` into base for the merge, because it bypasses what D6 tests.
  - Rebasing or re-cloning the fork, because it would lose the Unity-generated `.meta` and ProjectSettings state.
  - Folding the test into a later PR. D13 keeps it as its own PR.

### 5. Steps

### Stage 1: Test the protected-push wording of the missing-head refusal
**S1.** In `D:/projects/pi-config`:
- Confirm `git status` is clean.
- `git fetch origin`, check out `master`, and fast-forward it to `origin/master`.
- Confirm the PR #14 merge is in `git log --oneline -3`.
- Create the branch `flow/gate-push-wording-test`.

**S2.** In `pi/agent/extensions/workflow/merge-gate.test.ts`, add the test from §6 right after the test at `:229-234`, in the same style. Use the `edit` tool, not a heredoc, because the backslashes get mangled.

**S3.** Run the commands in §6 for Stage 1. Then call `judge`, and fix any blocker or major findings.

**S4.** Deliver: merge — branch `flow/gate-push-wording-test` into `master` of `Unknownow/pi-config`, as a pull request merged with a merge commit and delete-branch, through the D4 gh config. Confirm the PR's state is `MERGED`.

### Stage 2: Merge base PR #3
**S5.** In `D:/personal/game-studio-base`, confirm three things, all read-only:
- `git status` is clean, on `fix/assets-root-and-layer-tests`, HEAD `2dcc797` = `origin/fix/assets-root-and-layer-tests`.
- `gh pr checks 3 --repo Unknownow/game-studio-base` is green, through the D4 config.
- `/tmp/ghcfg-unknownow/hosts.yml` exists.

If any of them fails, stop and report.

**S6.** Make the base repo join the flow:
- With the `edit` tool, add one trailing space to a line of `docs/studio/code-root-resolution.md`, then remove it with `edit` in a second call.
- Confirm `git status` in base is clean.
- In a separate call, run `judge` with `base: "origin/main"` and the focus "Base PR #3: Assets/ root, legacy lowercase read with a warning, layer tests". It must pass on tree `2dcc797^{tree}`.

**S7.** Deliver: merge — PR #3 of `Unknownow/game-studio-base` into `main`, as a merge commit with delete-branch, through the D4 config.
- Run it from the working folder, naming the repo with `--repo` and with no `cd` (D6).
- Don't delete the gh config dir.
- If the gate refuses, stop and report the message.

**S8.** In base, all read-only:
- `git fetch origin`, then record `git rev-parse origin/main` as BASE_MAIN.
- Confirm `git merge-base --is-ancestor 2dcc797 origin/main` exits 0.
- Confirm `git rev-parse v0.1.0^{commit}` starts with `063372c`.
- Poll `gh run list --repo Unknownow/game-studio-base --branch main --limit 1` every ~10 s, up to 5 min, until the run on BASE_MAIN completes. It must be green; if it is red, stop and report.
- Leave the local checkout on its branch.

### Stage 3: Unity fork, ship v0.1.0
**S9.** In `D:/personal/game-studio-unity`:
1. Confirm the branch is `main` at `48ccc4c`.
2. Run `git config core.ignorecase false` and `git fetch base`, then confirm `base/main` = BASE_MAIN.
3. Stash the uncommitted work, including untracked files (no `--all`).
4. Fast-forward `main` to `base/main`. If that fails, stop.
5. Restore the stash. If it conflicts, stop, and never drop the stash before a clean restore.
6. Rename `assets` → `_assets_tmp` → `Assets` on disk, then stage the `Assets/` paths. `git rm --cached` any leftover `assets/` index entry.
7. Confirm all of these:
   - `git ls-files | grep '^assets/'` prints nothing.
   - `ls` shows `Assets` and not `assets`.
   - `Assets/README.md`, `Assets/README.md.meta`, `Assets/data.meta`, `Assets/data/README.md` and `Assets/data/README.md.meta` exist.
   - `git stash list` is empty.

**S10.** Run the fork commands in §6 for Stage 3, in order. Then:
- Delete the run outputs: `production/qa/**` and `.claude/`.
- Keep the Unity-generated `.meta` files and `Packages/packages-lock.json`.
- Confirm `git status` shows no `InitTestScene*`, `Library/`, `Temp/`, `Logs/`, `UserSettings/`, `project.local.toml` or `Assets/_Tmp`.
- If Unity re-creates a lowercase `assets/`, or reports a licence error, stop.

**S11.** Make the four commits in §9 on `main`. Then:
- Confirm `git diff --diff-filter=MDR base/main..main` prints nothing.
- Confirm `git ls-files | grep '^assets/'` prints nothing.
- Confirm `git status` is clean.
- Call `judge` with `full: true` and `base` = BASE_MAIN. Fix any findings with further commits, never by editing base files, and repeat until it passes.

**S12.** Deliver: the first push of the fork's commits straight to `main` of `Unknownow/game-studio-unity`. Then:
- Poll `gh run list --repo Unknownow/game-studio-unity --branch main --limit 1` every ~10 s, up to 5 min, through the D4 config.
- It must be green. If it is red, stop: S13–S15 don't run.

**S13.** Deliver: tag `v0.1.0` on `game-studio-unity` `main`, with `deliver {tag: {name: "v0.1.0", repo: "D:/personal/game-studio-unity"}, step: "S13"}`. Confirm with `git ls-remote --exit-code --tags origin v0.1.0` in the fork.

**S14.** Mark `Unknownow/game-studio-unity` as a template repository:
- Send a PATCH of the repo with `is_template=true` through the D4 config.
- Read it back with `gh api repos/Unknownow/game-studio-unity --jq .is_template`. It must print `true`.

**S15.** Delete `/tmp/ghcfg-unknownow`. Confirm `ls /tmp/ghcfg-unknownow` fails.

**S16.** Verify: open a case-sensitive clone of `Unknownow/game-studio-unity` (macOS or Linux) in Unity 6000.3 — look for:
- `Assets/` as the only asset folder;
- the "Game Studio Tools" menu;
- no compile errors.

**S17.** Verify: create a game repo from the template, clone it, and run `python tools/studio.py setup` — look for:
- `Packages/manifest.json` lists `com.unknownow.studio-tools` as `https://github.com/Unknownow/game-studio-unity.git?path=/Packages/com.unknownow.studio-tools#v0.1.0`;
- the embedded package folder is gone;
- Unity resolves the package on open.

**S18.** Verify: start pi with `CLAUDE_BRIDGE_DEBUG=1` and work until a new `prompt_capture_unresolved` line appears in `~/.pi/agent/claude-bridge-diag.log` — look for: the stored prompt and the sent prompt at their first difference. This feeds D24 in a later change.

### 6. Tests
**Stage 1:** one new test in `pi/agent/extensions/workflow/merge-gate.test.ts`.
- Name: `gateProblem: a missing head on a protected push gives no merge advice`.
- Input: `gateProblem("protected-push", { noMerge: false, passedTrees: ["t"], tree: null, commit: "abc1234def", what: "pushing x" })`.
- Expected: the result matches `/abc1234/`, `/not in this repo/` and `/fetch that commit first/`, and does not match `/run the merge/`.
- Commands, from `pi/agent/extensions/workflow`:
  - `node --experimental-strip-types --test merge-gate.test.ts` → `ℹ pass 23`, `ℹ fail 0`.
  - The full list at `README.md:211` plus `git-guard.test.ts` → `ℹ fail 0`, with pass = 641.

**Stage 2:** no new tests. CI is green on the PR and on BASE_MAIN.

**Stage 3:** no new tests. Fork commands, in order, from `D:/personal/game-studio-unity`:
1. `python -m unittest discover -s tools/gamestudio/tests -t tools -q` (~40–60 s) → `OK`. This includes `test_engine_unity` (19) and `test_no_lowercase_assets_root`.
2. `python tools/studio.py check` → `check: 0 errors`, with no `engine-hooks`, `engine-pin`, `legacy-assets` or `data-json` lines.
3. `python tools/studio.py upstream-diff --clone D:/scratch/ccgs-v1.2.0 --to v1.2.0 --coverage` → exit 0.
4. `python tools/studio.py claude-sync` → `75 skills, 39 agents`. Then delete `.claude/`.
5. EditMode (**slow**, 3–6 min), using the command at paused-plan line 72 → exit 0, and `D:/scratch/unity-results/editmode.xml` has `total="45" passed="45" failed="0"`. While fixing, add `-testFilter Unknownow.StudioTools.Tests.<Class>`. Run the full command once.
6. `ProjectSettingsCheck.RunBatch` and `MissingReferenceAudit.RunBatch` (**slow**, 1–2 min each), using paused-plan line 73 → exit 0, with 0 findings.
7. `python tools/studio.py test-run --timeout 1200 --log D:/scratch/unity-results/testrun.log` (**slow**) → exit 0, `tests total=41 passed=41 failed=0`. Then delete `production/qa`.

Rerun the slow suites only if a later fix touches `Packages/`, `ProjectSettings/` or `Assets/`. After S11, `git diff --diff-filter=MDR base/main..main` is empty.

### 7. Done when
- **pi-config:**
  - The protected-push wording test is merged into `master` of `Unknownow/pi-config` through its own PR.
  - All workflow tests pass.
  - No production code in the extension changed.
- **Base:**
  - PR #3 is merged into `main` of `Unknownow/game-studio-base`, by a `--repo` merge with no `cd`.
  - `2dcc797` is an ancestor of `origin/main`.
  - CI on `main` is green.
  - `v0.1.0` is still at `063372c`.
- **Fork `main`:**
  - It is base `main` plus the four commits in §9, which only add files.
  - It tracks `Assets/` and no `assets/` path.
  - It passes every fork command in §6.
  - CI is green, tag `v0.1.0` is pushed, and `is_template` is `true`.
- `/tmp/ghcfg-unknownow` is deleted.
- `~/.ssh`, `~/.gitconfig*` and the active `gh` account are unchanged.
- Nothing changed in `pi-claude-bridge`, pi, or the `turn_start` refilter.

### 8. Risks, rollback, and what not to touch
- **Gate still refusing PR #3:** stop and report the exact text. That would mean the new gate isn't loaded, or `repoRoot` doesn't match `github-personal/Unknownow/game-studio-base`.
- **Windows case folding:** always rename in two steps with `ignorecase=false`.
- **Stash:** never drop a stash before a clean restore is confirmed.
- **Rollback:**
  - pi-config test PR: a revert PR.
  - Base: a revert PR of the merge commit.
  - Fork before S12: reset `main` to BASE_MAIN with the work kept in the tree.
  - Fork after S12: don't tag; report.
- **Do not touch:**
  - workflow production code;
  - `pi-claude-bridge`;
  - `index.ts:3073-3075`;
  - other flows' plan files, apart from reading the paused plan;
  - `~/.ssh`, `~/.gitconfig*`, the active gh account;
  - base `v0.1.0`;
  - base's untracked `assets/data/README.md`;
  - base-owned files in the fork;
  - `D:/scratch/**`, `Library/`, `.claude/`, `project.local.toml`, `production/qa/**` (never committed);
  - CCGS scripts (never run them). Run Python on fetched files only with `-I`.
- **Writing files:** don't use heredocs for files with backslashes. Use `edit`/`write`.

### 9. Commits
**pi-config:**
1. `test(workflow): cover the protected-push wording of the missing-head refusal`: `pi/agent/extensions/workflow/merge-gate.test.ts`.

**Base:** none new. PR #3 is merged as is, with a merge commit.

**Fork**, on `main` after the fast-forward to BASE_MAIN:
1. `feat(unity): minimal Unity 6.3 LTS project`: `Assets/README.md`, `Assets/**/*.meta`, `Packages/manifest.json`, `Packages/packages-lock.json`, `ProjectSettings/**`.
2. `feat(unity): engine pin, ENGINE.md hooks, reference docs, roles and rules`: `engine.toml`, `ENGINE.md`, `engine-reference/unity/**`, `roles/unity-*.md`, `rules/unity/**`, `studio-tests/agents/engine/unity/**`, `files.manifest.d/unity.manifest`, `UPSTREAM.unity.toml`.
3. `feat(studio): Unity engine plugin`: `tools/gamestudio/engines/unity.py`, `tools/gamestudio/tests/test_engine_unity.py`.
4. `feat(package): com.unknownow.studio-tools 0.1.0`: `Packages/com.unknownow.studio-tools/**`.

<!-- pi-workflow:status -->
## Checklist
- [x] S1 In `D:/projects/pi-config`:
- [x] S2 In `pi/agent/extensions/workflow/merge-gate.test.ts`, add the test from §6 right after the test at `:229-234`, in the sa
- [x] S3 Run the commands in §6 for Stage 1. Then call `judge`, and fix any blocker or major findings.
- [x] S4 Deliver: merge — branch `flow/gate-push-wording-test` into `master` of `Unknownow/pi-config`, as a pull request merged w
- [ ] S5 In `D:/personal/game-studio-base`, confirm three things, all read-only:
- [ ] S6 Make the base repo join the flow:
- [ ] S7 Deliver: merge — PR #3 of `Unknownow/game-studio-base` into `main`, as a merge commit with delete-branch, through the D4
- [ ] S8 In base, all read-only:
- [ ] S9 In `D:/personal/game-studio-unity`:
- [ ] S10 Run the fork commands in §6 for Stage 3, in order. Then:
- [ ] S11 Make the four commits in §9 on `main`. Then:
- [ ] S12 Deliver: the first push of the fork's commits straight to `main` of `Unknownow/game-studio-unity`. Then:
- [ ] S13 Deliver: tag `v0.1.0` on `game-studio-unity` `main`, with `deliver {tag: {name: "v0.1.0", repo: "D:/personal/game-studio
- [ ] S14 Mark `Unknownow/game-studio-unity` as a template repository:
- [ ] S15 Delete `/tmp/ghcfg-unknownow`. Confirm `ls /tmp/ghcfg-unknownow` fails.
## For you after the flow
- S16 Verify: open a case-sensitive clone of `Unknownow/game-studio-unity` (macOS or Linux) in Unity 6000.3 — look for:
- S17 Verify: create a game repo from the template, clone it, and run `python tools/studio.py setup` — look for:
- S18 Verify: start pi with `CLAUDE_BRIDGE_DEBUG=1` and work until a new `prompt_capture_unresolved` line appears in `~/.pi/ag
