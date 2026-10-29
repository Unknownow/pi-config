<!-- pi-workflow plan v1 flow=20261029-1132-base-pr-3-asset-root-assets-then-finish-79d4 -->
## Plan: Base PR #3 (asset root `Assets/`), then finish and ship the Unity fork

### 1. Goal and non-goals
**Goal.**
- **Base (`Unknownow/game-studio-base`):**
  - The neutral asset root becomes `Assets/`, so the Unity fork has one asset folder on every OS, including case-sensitive ones.
  - Code-root detection keeps resolving `src/` in plain base projects.
  - Games that still have the old lowercase `assets/` keep their data-json, `content-count` and `asset-scan` coverage, with a warning to rename the folder.
  - The content tests tolerate an engine layer's `UPSTREAM.<layer>.toml`.
- **Fork (`Unknownow/game-studio-unity`):**
  - It merges that base and tracks `Assets/` with no lowercase `assets/` path.
  - It passes every check, and its first commits are pushed straight to `main`.
  - It is tagged `v0.1.0` and marked as a GitHub template repository.

**Non-goals:**
- Any change to `D:/projects/**`.
- Retagging base. Base `v0.1.0` stays at `063372c`.
- An automatic rename of `assets/` inside existing games. A warning is enough.
- Godot or Unreal content.
- A Unity build or Unity tests in CI.
- A UPM registry.
- Third-party Python dependencies.
- Fixing the staged skill-lint advice.
- Removing Godot/Unreal mentions in `studio-tests/**`, `tools/**` or `UPSTREAM.toml`.

### 2. User decisions
- D1: The templates stand alone and are agent-agnostic. They work with pi, Codex, Cursor, Claude Code and humans. Every skill is a numbered checklist.
- D2: Base is engine-agnostic. The Unity repo is a real fork of base that only adds files.
- D3: The repos are the public `Unknownow/game-studio-base` and `Unknownow/game-studio-unity`, kept locally under `D:/personal/`.
  - Remotes are `git@github-personal:Unknownow/<repo>.git`.
  - The fork has a `base` remote and an `origin` remote.
- D4: Python 3.11+, standard library only. Use Python 3.12 at `/c/Users/IEC-WW/AppData/Local/Programs/Python/Python312`.
- D5: The copyright holder is Cuong Bui (and Donchitos for the upstream content). The licence is MIT. The git identity is `Cuong Bui <cuong.bpt82@gmail.com>`.
- D6: Base changes go through a branch and a pull request. The fork's first commits go straight to `main`.
- D7: Package `com.unknownow.studio-tools` 0.1.0, with assemblies `Unknownow.StudioTools.Editor` and `Unknownow.StudioTools.Tests`.
  - Games install it from `https://github.com/Unknownow/game-studio-unity.git?path=/Packages/com.unknownow.studio-tools#v0.1.0`.
  - One tag versions both the template and the package.
- D8: The Unity pin is 6.3 LTS, editor line 6000.3. The package minimum is 6000.3.
- D9: The fork is cloned from base `main`, not `v0.1.0`. Base is not retagged.
- D10: Base PR #3 is approved. It overrides the old non-goal "no further base change".
- D11: Option 1 (then option A): the neutral asset root is renamed from lowercase `assets/` to `Assets/`.
- D12: `Assets/` counts as a derived code root only when `ProjectSettings/ProjectVersion.txt` exists. `src/` next to a plain `Assets/` resolves to `src`.
- D13: An old lowercase `assets/` is still read, with a warning naming the rename, by:
  - the data-json check
  - `content-count`
  - `asset-scan`
- D14: The fork's only-adds check (`git diff --diff-filter=MDR base/main..main` is empty) runs against base `main` after PR #3 has merged.
- D15: `test_command` keeps `-logFile -`, a deliberate deviation. With a log file, `test-run` sees no test output.
- D16: For the gh CLI against Unknownow repos, use a temporary `GH_CONFIG_DIR` that holds the Unknownow token, and delete it afterwards.
  - Never run `gh auth switch`.
  - Never print the token.
  - Don't touch `~/.ssh` or `~/.gitconfig*`.

### 3. Facts the executor needs
- Every bash call starts with `export PATH="/c/Users/IEC-WW/AppData/Local/Programs/Python/Python312:$PATH"`, because the default `python` is 3.9. The shell is bash on Windows, and `core.ignorecase` defaults to true.
- **Base branch `fix/assets-root-and-layer-tests` (local, not pushed), on top of `48ccc4c`:**
  - `45bf8f0`:
    - `tools/gamestudio/tests/test_upstream.py`: `test_real_base_engine_layer_paths_stay_ignored` copies only `UPSTREAM.toml` into a temp dir.
    - `tools/gamestudio/tests/test_repo_content.py`: `UPSTREAM*.toml` is exempt in `test_no_claude_runtime_leftovers`, and there is a new `test_no_lowercase_assets_root`.
  - `85debdf`: a bulk rename of `assets/` to `Assets/` across 42 files, plus the `git mv`.
  - Current results: suite 217 OK, `check` 0 errors (6 skill-lint warnings), `--coverage` exit 0.
- **Base code anchors:**
  - `tools/gamestudio/engines/__init__.py:42-52`: `code_root(ctx, plugin=None)`. Line 51 derives from `("src","Assets","Source")` and returns the single one present, else `None`.
  - `tools/gamestudio/helpers/project_state.py:56-58`: the same derivation, duplicated, returning `(name, "detected")`. It imports `engines`; `engines.Ctx` is used at `:50`.
  - `tools/gamestudio/check.py`:
    - `:19-20` `GAME_OWNED`, which now lists `"Assets/"` twice (line 19 and line 20).
    - `:148-154` `check_data_json(report, src, globs)`, with patterns `["Assets/data/**/*.json"] + list(globs)`.
    - `:305` the "code root unresolved" warning.
    - `:320` the call site.
  - `common.py:83-86`: `Report.error/warn(check_id, path, message)`.
  - `tools/gamestudio/helpers/asset_scan.py`:
    - `:209` `rootdir = "Assets"`.
    - `:210-215` the absent and present root rows. When the root is absent it writes to stderr and exits 4.
    - `:19-31` the help text.
  - `tools/gamestudio/helpers/content_count.py`:
    - `:24-25` the help text (garbled).
    - `:190` `roots = ["Assets"]`, then `:191-198` the present and absent rows.
    - `:223` `if rt == "Assets" and eng != "unity":` (the neutral first-segment rule).
- **Garbled text from the bulk replace:**
  - `.agents/skills/asset-audit/SKILL.md:74`
  - `.agents/skills/content-audit/SKILL.md:159-160`
  - `.agents/skills/launch-checklist/SKILL.md:89`
  - `.agents/skills/localize/SKILL.md:199`
  - `docs/studio/code-root-resolution.md:23-29`
  - `studio-tests/skills/analysis/asset-audit.md:6` and `:284`
  - `studio-tests/skills/analysis/content-audit.md:289`
  - `tools/gamestudio/helpers/content_count.py:25`
- **Base tests to extend:**
  - `tests/test_helpers_project_state.py:23-27` `test_unknown_code_root_is_unknown_not_zero`, which uses `src/a.gd` and `Assets/b.cs`.
  - `tests/test_check.py:58` `test_data_json`.
  - `tests/test_helpers_asset_scan.py:12,32,42`.
  - `tests/test_helpers_content_count.py:50,58,65`.
  - Model new cases on `RepoCase` (`tests/_util.py:30`), using `self.add`, `self.with_toml` and `self.run_cli`.
- **Fork `D:/personal/game-studio-unity`:**
  - Branch `main` sits at `48ccc4c`. Remotes are `base` and `origin`. All of the fork's work is uncommitted (untracked, plus `Packages/manifest.json` and similar).
  - Unity wrote these into the lowercase folder: `assets/README.md`, `assets/README.md.meta`, `assets/data.meta`, `assets/data/README.md.meta`.
  - Done and verified on the uncommitted tree:
    - `test_engine_unity.py` 19 OK.
    - EditMode 45/45 (`D:/scratch/unity-results/editmode.xml`).
    - `ProjectSettingsCheck` and `MissingReferenceAudit`: exit 0.
    - `test-run`: total 41, passed 41.
- **Unity commands:**
  - Unity is `"C:/Program Files/Unity/Hub/Editor/6000.3.25f1/Editor/Unity.exe"`.
  - EditMode: `-batchmode -nographics -projectPath D:/personal/game-studio-unity -runTests -testPlatform EditMode -testResults D:/scratch/unity-results/editmode.xml -logFile D:/scratch/unity-results/editmode.log`.
  - Batch checks: `-batchmode -nographics -quit -projectPath … -executeMethod Unknownow.StudioTools.Editor.ProjectSettingsCheck.RunBatch -logFile -`, and the same with `MissingReferenceAudit.RunBatch`.
- **Judge quirk:** if `judge` says "No changes to review" for a repo, make a trivial change with the `edit` tool in that repo, then call it again.
- **The temporary gh config:**
  - Directory `/tmp/ghcfg-unknownow`.
  - `hosts.yml` contains `github.com:\n    oauth_token: <gh auth token -u Unknownow>\n    user: Unknownow\n    git_protocol: ssh`.
  - Run every command as `GH_CONFIG_DIR=/tmp/ghcfg-unknownow gh … --repo Unknownow/<repo>`.

### 4. Design
- **Code-root derivation (D12).**
  - Add one public function to `tools/gamestudio/engines/__init__.py`: `def derive_code_root(root) -> str | None`.
    - It lists the top level of `root` and compares names exactly.
    - A candidate is `src` or `Source` when present, or `Assets` when present *and* `os.path.isfile(root/ProjectSettings/ProjectVersion.txt)`.
    - It returns the single candidate, or `None` when there are zero or two or more.
  - `code_root()` (`:51`) and `project_state.py:56` both call it. There is then no second copy.
  - The resolution order is unchanged: plugin, then `engine.toml`, then `engine.name` where `project_state` already checks it, then derivation.
- **Old lowercase root (D13).**
  - `check_data_json`:
    - The patterns are `["Assets/data/**/*.json", "assets/data/**/*.json"] + list(globs)`.
    - If any file in `src.files()` starts with `assets/`, emit exactly one warning: `report.warn("legacy-assets", "assets/", "rename the asset root assets/ to Assets/ (git mv assets tmp && git mv tmp Assets)")`.
    - Bad JSON under `assets/data/` is still an error, `data-json`.
  - `asset_scan`:
    - When the engine is `none`, `Assets` is not in the top-level listing and `assets` is, set `rootdir = "assets"`.
    - Write `asset-scan: warning: assets/ is the old asset root; rename it to Assets/` to stderr.
    - The rows print the real name, for example `root\tassets\tpresent`.
    - Unity always uses `Assets`.
  - `content_count`:
    - Roots are `["Assets"]` on Unity, else `["Assets", "assets"]`, each reported present or absent as today.
    - The neutral first-segment rule (`:223`) applies to every root when the engine is not Unity.
    - When the lowercase root is present, write `content-count: warning: assets/ is the old asset root; rename it to Assets/` to stderr.
  - The exit codes stay as they are.
- **Rejected alternatives:**
  - Moving the data folder to `data/` (option B). The user chose A.
  - Shipping a base `engine.toml` with `code_root = "src"`. It would be overridden by the fork's `engine.toml` anyway, and it would change the base layer files.
  - Auto-renaming the folder inside `update`. That is out of scope.
- **Scale.** This is a top-level listing plus the existing walks, so cost does not change.

### 5. Steps

### Stage 1: Base PR #3, asset root `Assets/`

**S1.** In `D:/personal/game-studio-base`, check `git status` (expect clean) and confirm the branch is `fix/assets-root-and-layer-tests` with `85debdf` at HEAD.
- Implement `derive_code_root` in `tools/gamestudio/engines/__init__.py`, as in §4.
- Make `code_root()` (`:51`) call it.
- Replace the duplicate derivation at `helpers/project_state.py:56-58` with a call to it; it still returns `(name, "detected")`.
- Leave the condition at `check.py:305` unchanged.

**S2.** Implement D13 as in §4, in three places:
- `check.py:148-154` (`check_data_json`)
- `helpers/asset_scan.py:209-215`, plus its help text `:19-31`, which should name the legacy fallback in one clause
- `helpers/content_count.py:190` and `:223`, plus its help text `:24-25`

**S3.** Clean up after the bulk replace:
- Remove the second `"Assets/"` from `GAME_OWNED` (`check.py:20`).
- Reword each garbled line (§3) so it names one root per engine and no sentence repeats `Assets/` against itself:
  - `asset-audit/SKILL.md:74`: the asset root is `Assets/`; on Unity it is also the Unity asset folder.
  - `content-audit/SKILL.md:159-160`: "on Unity every `Assets/data/…` glob below also runs anywhere under `Assets/`, without requiring a `data/` segment".
  - `launch-checklist/SKILL.md:89`: "`Assets/` or `Content/`".
  - `localize/SKILL.md:199`: "`Assets/data/strings/` and the rest of `Assets/`".
  - `studio-tests/skills/analysis/asset-audit.md:6,284`: "`Assets/` subfolders (art, audio, vfx, shaders, data) by default, all of `Assets/` on Unity, `Content/` on Unreal".
  - `studio-tests/skills/analysis/content-audit.md:289`: "anywhere under `Assets/`".
  - `docs/studio/code-root-resolution.md:23-29`: state rule D12, and note that an existence test for `Assets/` on Windows or macOS also succeeds on the old lowercase `assets/`, so names must be compared as listed.
- Then grep the lines `85debdf` added, `git diff 48ccc4c -U0 | grep '^+'`, for `Assets/.*Assets/` and `on Godot`, and fix any further line that is self-contradictory.

**S4.** Add the tests in §6 (base part) and run the base commands in §6. Then call `judge(full=true, base=48ccc4c)`, fix its findings, and repeat until it passes.

**S5.** Deliver: base PR #3.
- Push branch `fix/assets-root-and-layer-tests` to the base repo.
- Open a PR against `main` with the D16 gh config. Its body names D10–D13 and the fact that `v0.1.0` is untouched.
- Wait for green CI and merge it with merge commit and delete-branch.
- Delete the temporary gh config dir.
- No tag.

### Stage 2: Unity fork, ship v0.1.0

**S6.** In `D:/personal/game-studio-unity`, check `git status` and confirm the branch is `main`, then:
1. Run `git config core.ignorecase false` and `git fetch base`.
2. Stash all uncommitted work, including untracked files.
3. Fast-forward `main` to `base/main`. If the fast-forward is not possible, stop and report.
4. Restore the stash. If it conflicts, stop and report.
5. Make the folder `Assets/` on disk and in the index: rename on disk in two steps (`assets` to a temporary name to `Assets`) so Windows records the case change, then stage the new paths.
6. Confirm all of these:
   - `git ls-files | grep '^assets/'` prints nothing.
   - `ls` shows `Assets`.
   - Unity's metas are at `Assets/README.md.meta`, `Assets/data.meta` and `Assets/data/README.md.meta`.
   - `Assets/README.md` and `Assets/data/README.md` exist.

**S7.** Run the fork checks in §6 in order. Then:
- Delete the run outputs (`production/qa/**` written by the runs, `.claude/`).
- Keep the `.meta` files and `Packages/packages-lock.json` that Unity generated.
- Confirm `git status` shows no `InitTestScene*`, `Library/`, `Temp/`, `Logs/`, `UserSettings/` or `project.local.toml`.

**S8.** Make the four commits on `main` (§9). Then:
- Confirm `git diff --diff-filter=MDR base/main..main` is empty.
- Call `judge(full=true, base=<sha of base/main after S5>)`. Use the "No changes to review" workaround in §3 if needed.
- Fix the judge's findings with further commits, and repeat until it passes.

**S9.** Deliver: the first push of the fork's commits straight to `main` of `game-studio-unity`. CI on that commit must be green. If CI is red, stop and report.

**S10.** Deliver: tag `v0.1.0` on `game-studio-unity` `main` → call `deliver {tag: {name: "v0.1.0", repo: "D:/personal/game-studio-unity"}, step: "S10"}`.

**S11.** Mark `Unknownow/game-studio-unity` as a template repository:
- Send a PATCH of the repo with `is_template=true` through the D16 gh config.
- Read it back with `gh api repos/Unknownow/game-studio-unity --jq .is_template`. It must print `true`.
- Delete the config dir.

**S12.** Verify: open a case-sensitive clone of `Unknownow/game-studio-unity` (macOS or Linux) in Unity 6000.3. Look for:
- the project loads with `Assets/` as its asset folder, with no second `assets/`
- the menu "Game Studio Tools" is present
- the console shows no compile errors

**S13.** Verify: create a game repo from the template, clone it, and run `python tools/studio.py setup`. Look for:
- `Packages/manifest.json` lists `com.unknownow.studio-tools` as `https://github.com/Unknownow/game-studio-unity.git?path=/Packages/com.unknownow.studio-tools#v0.1.0`
- the embedded package folder is gone
- Unity resolves the package on open

### 6. Tests
**New or changed base tests:**
- `test_helpers_project_state.py`:
  - New `test_src_beside_a_plain_asset_root_is_the_code_root`. Input: `src/a.gd` and `Assets/data/x.json`, no engine, no `ProjectSettings/`. Expect the `code_root` row to be `src detected` and `source_files` to be `1`.
  - Changed `test_unknown_code_root_is_unknown_not_zero`: add `ProjectSettings/ProjectVersion.txt`. Expect `source_files` to stay `unknown`.
  - New `test_lone_unity_assets_is_the_code_root`. Input: `Assets/a.cs` and `ProjectSettings/ProjectVersion.txt`. Expect `code_root` to be `Assets detected`.
- `test_check.py`:
  - New `test_data_json_legacy_lowercase_root`. Input: `assets/data/b.json` containing `{bad`. Expect `ERROR data-json assets/data/b.json` and a `legacy-assets` line in the output, and a non-zero exit.
  - New `test_legacy_assets_warns_only`. Input: `assets/data/ok.json` containing `{}`. Expect exit 0 and the `legacy-assets` warning.
  - `test_data_json` (`:58`) stays as is: `Assets/data/b.json` gives an error, with no `legacy-assets` line.
- `test_helpers_asset_scan.py`: new `test_legacy_lowercase_root`. Input: neutral engine, only `assets/art/ok_tile.png`. Expect a `root\tassets\tpresent` row, a `FILE\tassets/art/ok_tile.png\t…` row, and `old asset root` in stderr.
- `test_helpers_content_count.py`: new `test_found_legacy_lowercase_root`. Input: neutral engine, `assets/data/enemies/orc.json`. Expect a found count of 1 for enemies, a `root\tassets\tpresent` row, and `old asset root` in stderr.
- The earlier commits keep these tests: `test_no_lowercase_assets_root` and the two layer tests.

**Base commands** (each about 40 s, fast):
- `python -m unittest discover -s tools/gamestudio/tests -t tools -q` → `OK`, under 2 min. `test_counts` keeps 75/34/28/13/71/28.
- `python tools/studio.py check` → `check: 0 errors`, with no `legacy-assets`, `engine-hooks` or `data-json` lines.
- `python tools/studio.py upstream-diff --clone D:/scratch/ccgs-v1.2.0 --to v1.2.0 --coverage` → exit 0.
- `git ls-files | grep '^assets/'` → no output.

**Fork commands, in order:**
1. Python suite (same command, fast) → `OK`, including `test_engine_unity` (19), `test_no_lowercase_assets_root` and the layer tests.
2. `python tools/studio.py check` → 0 errors, with no `engine-hooks`, `engine-pin` or `legacy-assets` lines.
3. `--coverage` (as above) → exit 0, 638/638.
4. `python tools/studio.py claude-sync` → `75 skills, 39 agents`, then delete `.claude/`.
5. EditMode run (**slow**, 3–6 min): use the command in §3. Expect exit 0 and `result="Passed" total="45" passed="45" failed="0"`. While fixing, add `-testFilter Unknownow.StudioTools.Tests.<Class>`. Run the full command once.
6. `ProjectSettingsCheck.RunBatch` and `MissingReferenceAudit.RunBatch` (**slow**, 1–2 min each) → exit 0, with 0 findings for the audit.
7. `python tools/studio.py test-run` (**slow**) → `exit 0`, `tests total=41 passed=41 failed=0`, and afterwards no `InitTestScene*` in `git status`.

Rerun the slow suites only if a later fix changes `Packages/` or `ProjectSettings/`.

### 7. Done when
- Base `main` has PR #3 merged:
  - the `Assets/` root
  - D12 and D13 in effect, with their tests
  - no self-contradictory text
  - the suite passes, `check` exits 0, `--coverage` exits 0, CI is green
  - `v0.1.0` is still at `063372c`
- Fork `Unknownow/game-studio-unity` `main`:
  - is base `main` (after PR #3) plus added files only (`git diff --diff-filter=MDR base/main..main` is empty)
  - tracks `Assets/` and no `assets/` path
  - is a valid Unity 6000.3 project
  - holds `ENGINE.md` covering all 19 hooks, with no `engine-hooks` findings
  - holds `engine.toml` pinned to 6.3 LTS, matching `VERSION.md`
  - holds 16 reference docs, 5 Unity roles and 9 Unity rules
  - holds the Unity plugin and package 0.1.0 with its 4 features
  - passes every fork command in §6
  - is tagged `v0.1.0`, with `is_template: true` and green CI
- A game installs the package from the `#v0.1.0` git URL, and `setup` converts the embedded copy to that URL.
- No file in `D:/projects/pi-config` has changed.

### 8. Risks, rollback, and what not to touch
- **Windows case folding:**
  - Always rename in two steps and with `core.ignorecase=false`.
  - If Unity or git writes lowercase `assets/` paths back, stop and report. Don't hard-code a workaround.
- **Stash conflicts:**
  - If the fast-forward fails, or the stash restore conflicts in S6, stop and report.
  - Never edit a base file in the fork: any need to do that means stop and report.
- **Unity licence error:** stop and report.
- **Red CI:** if CI is red on base or the fork, stop and report. Rollback for base is to revert the merge commit in a new PR. The fork is not pushed until its judge passes.
- **Do not touch:**
  - `D:/projects/**`
  - `~/.ssh`, `~/.gitconfig*`, the active `gh` account
  - base `v0.1.0`
  - `D:/scratch/**` (never committed)
  - `Library/`, `.claude/`, `project.local.toml`, `production/qa/**` run outputs
  - CCGS scripts (never run them)
- Run Python on fetched files only with `-I`.

### 9. Commits
**Base**, on branch `fix/assets-root-and-layer-tests`, after the existing `45bf8f0` and `85debdf`:
- `fix(studio): Assets/ is a code root only in a Unity project`: `tools/gamestudio/engines/__init__.py`, `tools/gamestudio/helpers/project_state.py`, `tools/gamestudio/tests/test_helpers_project_state.py`, `docs/studio/code-root-resolution.md`.
- `fix(studio): still read a legacy lowercase assets/ with a warning`: `tools/gamestudio/check.py`, `tools/gamestudio/helpers/asset_scan.py`, `tools/gamestudio/helpers/content_count.py`, `tools/gamestudio/tests/test_check.py`, `tools/gamestudio/tests/test_helpers_asset_scan.py`, `tools/gamestudio/tests/test_helpers_content_count.py`.
- `docs: one asset root per engine after the Assets/ rename`: the garbled `.agents/skills/**`, `studio-tests/**` and any other lines S3 finds.

**Fork**, on `main`, after the fast-forward to base `main`:
- `feat(unity): minimal Unity 6.3 LTS project`: `Assets/README.md`, `Assets/**/*.meta`, `Packages/manifest.json`, `Packages/packages-lock.json`, `ProjectSettings/**`.
- `feat(unity): engine pin, ENGINE.md hooks, reference docs, roles and rules`: `engine.toml`, `VERSION.md` (if it was added), `ENGINE.md`, `engine-reference/unity/**`, `roles/unity-*.md`, `rules/unity/**`, `studio-tests/agents/engine/unity/**`, `files.manifest.d/unity.manifest`, `UPSTREAM.unity.toml`.
- `feat(studio): Unity engine plugin`: `tools/gamestudio/engines/unity.py`, `tools/gamestudio/tests/test_engine_unity.py`.
- `feat(package): com.unknownow.studio-tools 0.1.0`: `Packages/com.unknownow.studio-tools/**`.

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 In `D:/personal/game-studio-base`, check `git status` (expect clean) and confirm the branch is `fix/assets-root-and-laye
- [ ] S2 Implement D13 as in §4, in three places:
- [ ] S3 Clean up after the bulk replace:
- [ ] S4 Add the tests in §6 (base part) and run the base commands in §6. Then call `judge(full=true, base=48ccc4c)`, fix its fin
- [ ] S5 Deliver: base PR #3.
- [ ] S6 In `D:/personal/game-studio-unity`, check `git status` and confirm the branch is `main`, then:
- [ ] S7 Run the fork checks in §6 in order. Then:
- [ ] S8 Make the four commits on `main` (§9). Then:
- [ ] S9 Deliver: the first push of the fork's commits straight to `main` of `game-studio-unity`. CI on that commit must be green
- [ ] S10 Deliver: tag `v0.1.0` on `game-studio-unity` `main` → call `deliver {tag: {name: "v0.1.0", repo: "D:/personal/game-studi
- [ ] S11 Mark `Unknownow/game-studio-unity` as a template repository:
## For you after the flow
- S12 Verify: open a case-sensitive clone of `Unknownow/game-studio-unity` (macOS or Linux) in Unity 6000.3. Look for:
- S13 Verify: create a game repo from the template, clone it, and run `python tools/studio.py setup`. Look for:
