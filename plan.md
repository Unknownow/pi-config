<!-- pi-workflow plan v1 flow=20261029-1151-merge-base-pr-3-then-finish-and-ship-the-eca5 -->
## Plan: Merge base PR #3, then finish and ship the Unity fork v0.1.0

### 1. Goal and non-goals
**Goal.**
- **Base (`Unknownow/game-studio-base`):**
  - PR #3 is merged into `main`. After it, the neutral asset root is `Assets/`, so the Unity fork has one asset folder on every OS, including case-sensitive ones.
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
- Fixing the `check.py:309` "code root unresolved" warning for an `Assets/`-only plain project. It was upheld as a plan choice and is a possible later base follow-up.

### 2. User decisions
- D1: The templates stand alone and are agent-agnostic. They work with pi, Codex, Cursor, Claude Code and humans. Every skill is a numbered checklist.
- D2: Base is engine-agnostic. The Unity repo is a real fork of base that only adds files.
- D3: The repos are the public `Unknownow/game-studio-base` and `Unknownow/game-studio-unity`, kept locally under `D:/personal/`. Remotes are `git@github-personal:Unknownow/<repo>.git`. The fork has a `base` remote and an `origin` remote.
- D4: Python 3.11+, standard library only. Use Python 3.12 at `/c/Users/IEC-WW/AppData/Local/Programs/Python/Python312`.
- D5: The copyright holder is Cuong Bui (and Donchitos for the upstream content). The licence is MIT. The git identity is `Cuong Bui <cuong.bpt82@gmail.com>`.
- D6: Base changes go through a branch and a pull request. The fork's first commits go straight to `main`.
- D7: Package `com.unknownow.studio-tools` 0.1.0, with assemblies `Unknownow.StudioTools.Editor` and `Unknownow.StudioTools.Tests`. Games install it from `https://github.com/Unknownow/game-studio-unity.git?path=/Packages/com.unknownow.studio-tools#v0.1.0`. One tag versions both the template and the package.
- D8: The Unity pin is 6.3 LTS, editor line 6000.3. The package minimum is 6000.3.
- D9: The fork is cloned from base `main`, not `v0.1.0`. Base is not retagged.
- D10: Base PR #3 is approved. It overrides the old non-goal "no further base change".
- D11: The neutral asset root is renamed from lowercase `assets/` to `Assets/`.
- D12: `Assets/` counts as a derived code root only when `ProjectSettings/ProjectVersion.txt` exists. `src/` next to a plain `Assets/` resolves to `src`.
- D13: An old lowercase `assets/` is still read, with a warning naming the rename, by the data-json check, `content-count` and `asset-scan`.
- D14: The fork's only-adds check (`git diff --diff-filter=MDR base/main..main` is empty) runs against base `main` after PR #3 has merged.
- D15: `test_command` keeps `-logFile -`, a deliberate deviation. With a log file, `test-run` sees no test output.
- D16: For the gh CLI against Unknownow repos, use a temporary `GH_CONFIG_DIR` that holds the Unknownow token, and delete it afterwards. Never run `gh auth switch`. Never print the token. Don't touch `~/.ssh` or `~/.gitconfig*`.
- D17: The merge of PR #3 is the first step of the remaining work. The temporary gh config dir is kept from that merge until the template step (S9) and deleted there.

### 3. Facts the executor needs
- **Python:** every bash call starts with `export PATH="/c/Users/IEC-WW/AppData/Local/Programs/Python/Python312:$PATH"`. The default `python` is 3.9.
- **Shell:** bash on Windows, where `core.ignorecase` defaults to true.
- **Guard:**
  - A merge or a push to a protected branch must be its own bash command, with nothing chained to it, run after the judge has passed that exact tree.
  - `GH_TOKEN=$(…)` inline is refused. Use `GH_CONFIG_DIR`.
- **Temporary gh config:**
  - `/tmp/ghcfg-unknownow/hosts.yml` already exists and holds the Unknownow token. Don't print it.
  - Use it as `GH_CONFIG_DIR=/tmp/ghcfg-unknownow gh … --repo Unknownow/<repo>`.
  - If it is missing, recreate it with a `hosts.yml` in this format, writing the token with `gh auth token -u Unknownow` without echoing it:
    `github.com:\n    oauth_token: <token>\n    user: Unknownow\n    git_protocol: ssh`
- **Base PR #3:**
  - URL: https://github.com/Unknownow/game-studio-base/pull/3.
  - Branch `fix/assets-root-and-layer-tests`, head `2dcc797`, 7 commits on `48ccc4c`: `45bf8f0`, `85debdf`, `c59652b`, `2b4842f`, `2d42397`, `69d05a6`, `2dcc797`.
  - CI (`check`) is green on it. The judge passed this tree.
  - `v0.1.0` is at `063372c`.
  - The local base checkout stays on the PR branch. `git checkout main` there fails on an untracked `assets/data/README.md`. Don't fix or touch it: the fork reads base through its `base` remote.
- **Base CI** (`.github/workflows/check.yml`, shared by the fork): runs `python tools/studio.py check` and the unittest discover command.
- **Fork `D:/personal/game-studio-unity`:**
  - Branch `main` at `48ccc4c`, nothing committed on top. Remotes: `base` and `origin` (`git@github-personal:Unknownow/game-studio-unity.git`).
  - The index tracks lowercase `assets/data/README.md`. Unity wrote `assets/README.md`, `assets/README.md.meta`, `assets/data.meta` and `assets/data/README.md.meta`, all untracked.
  - Untracked: `ENGINE.md`, `Packages/` (incl. `manifest.json` and `com.unknownow.studio-tools/**`), `ProjectSettings/`, `UPSTREAM.unity.toml`, `engine-reference/` (unity: `VERSION.md`, `PLUGINS.md`, `breaking-changes.md`, `current-best-practices.md`, `deprecated-apis.md`, `modules/`, `plugins/`, 16 docs in total), `engine.toml`, `files.manifest.d/`, `roles/unity-{addressables,dots,shader,ui}-specialist.md`, `roles/unity-specialist.md`, `rules/unity/` (9), `studio-tests/agents/engine/`, `tools/gamestudio/engines/unity.py`, `tools/gamestudio/tests/test_engine_unity.py`.
  - The stray `Assets/_Tmp` is already gone.
  - There is no top-level `VERSION.md`. The pin file is `engine-reference/unity/VERSION.md`.
  - Already verified on this tree: `test_engine_unity` 19 OK, EditMode 45/45, `ProjectSettingsCheck` and `MissingReferenceAudit` exit 0, `test-run` 41/41.
- **Unity:**
  - Executable: `"C:/Program Files/Unity/Hub/Editor/6000.3.25f1/Editor/Unity.exe"`.
  - EditMode run: `-batchmode -nographics -projectPath D:/personal/game-studio-unity -runTests -testPlatform EditMode -testResults D:/scratch/unity-results/editmode.xml -logFile D:/scratch/unity-results/editmode.log`.
  - Batch checks: `-batchmode -nographics -quit -projectPath D:/personal/game-studio-unity -executeMethod Unknownow.StudioTools.Editor.ProjectSettingsCheck.RunBatch -logFile -`, and the same with `Unknownow.StudioTools.Editor.MissingReferenceAudit.RunBatch`.
- **Judge quirk:** if `judge` says "No changes to review" for a repo, make a trivial change with the `edit` tool in that repo, revert it with the same tool if it isn't wanted, then call `judge` again.

### 4. Design
No new components. This is delivery plus a case-correct merge of existing work.

- **Fork merge route.** Base `main` after PR #3 is a merge commit whose ancestor is `48ccc4c`, so the fork's `main` fast-forwards. The steps:
  1. `core.ignorecase=false`.
  2. Stash all work, including untracked files.
  3. `merge --ff-only base/main`.
  4. Restore the stash.
  5. Rename the folder on disk in two steps (`assets` → `_assets_tmp` → `Assets`).
  6. Stage it.
- **Failure handling:**
  - A failed fast-forward, a stash conflict, a licence error, red CI, or git/Unity writing lowercase `assets/` back: stop and report. No workaround.
  - Every fork file must be new relative to `base/main` (D14). Any need to edit a base file: stop and report.
- **Rejected:**
  - Rebasing the fork onto base: there is nothing committed to rebase.
  - Cloning the fork fresh from base: it would lose the Unity-generated `.meta` and `ProjectSettings` state.
  - Fixing `check.py:309` now: upheld as a plan choice, out of scope.

### 5. Steps

### Stage 1: Merge base PR #3
**S1.** In `D:/personal/game-studio-base`, check `git status`. Expect it clean, on `fix/assets-root-and-layer-tests`, with HEAD equal to `origin/fix/assets-root-and-layer-tests` = `2dcc797`. Read-only, confirm two things:
- PR #3 is OPEN with green checks: `gh pr checks 3` with the D16 config.
- `/tmp/ghcfg-unknownow/hosts.yml` exists.

If HEAD differs, or CI isn't green, stop and report. Call `judge` (the tree is already judged; use the quirk in §3 if it says no changes) so the merge gate sees a pass on this exact tree.

**S2.** Deliver: merge — base PR #3, as a merge commit with delete-branch, through the D16 gh config. Don't delete the gh config dir (D17). Then, read-only:
- `git fetch origin` in base.
- Record `origin/main`'s sha as BASE_MAIN.
- Confirm `git merge-base --is-ancestor 2dcc797 origin/main`.
- Confirm `git rev-parse v0.1.0^{commit}` starts with `063372c`.
- Confirm CI on the merge commit is green: `gh run list --branch main --limit 1` with the D16 config, polling every ~10 s up to 5 min.

If CI is red, stop and report.

### Stage 2: Unity fork, ship v0.1.0
**S3.** In `D:/personal/game-studio-unity`, check `git status` and confirm the branch is `main` at `48ccc4c`, then:
1. Run `git config core.ignorecase false`, then `git fetch base`. Confirm `base/main` = BASE_MAIN.
2. Stash all uncommitted work, including untracked files. Don't use `--all`, because ignored `Library/` must not go into the stash.
3. Fast-forward `main` to `base/main`. If it isn't possible, stop and report.
4. Restore the stash. If it conflicts, stop and report.
5. Rename the folder on disk in two steps (`assets` → `_assets_tmp` → `Assets`), then stage the `Assets/` paths. Make sure the index has no `assets/` entry left (`git rm --cached` any leftover lowercase path).
6. Confirm all of these:
   - `git ls-files | grep '^assets/'` prints nothing.
   - `ls` shows `Assets`, not `assets`.
   - `Assets/README.md`, `Assets/README.md.meta`, `Assets/data.meta`, `Assets/data/README.md` and `Assets/data/README.md.meta` exist.
   - `git stash list` is empty, or the stash was dropped after a clean restore.

**S4.** Run the fork checks in §6 in order. Then:
- Delete the run outputs: `production/qa/**` written by the runs, and `.claude/`.
- Keep the `.meta` files and `Packages/packages-lock.json` that Unity generated.
- Confirm `git status` shows no `InitTestScene*`, `Library/`, `Temp/`, `Logs/`, `UserSettings/`, `project.local.toml` or `Assets/_Tmp`.
- If Unity re-creates a lowercase `assets/` folder or paths, stop and report.

**S5.** Make the four commits on `main` (§9). Then:
- Confirm `git diff --diff-filter=MDR base/main..main` prints nothing, and `git ls-files | grep '^assets/'` prints nothing.
- Call `judge(full=true, base=BASE_MAIN)`, using the quirk in §3 if needed.
- Fix its findings with further commits, never by editing base files, and repeat until it passes.

**S6.** Deliver: the first push of the fork's commits straight to `main` of `game-studio-unity`. Then poll CI on that commit every ~10 s up to 5 min, with `gh run list --repo Unknownow/game-studio-unity` and the D16 config. It must be green. If it is red, stop and report.

**S7.** Deliver: tag `v0.1.0` on `game-studio-unity` `main` → call `deliver {tag: {name: "v0.1.0", repo: "D:/personal/game-studio-unity"}, step: "S7"}`. Confirm with `git ls-remote --exit-code --tags origin v0.1.0`.

**S8.** Mark `Unknownow/game-studio-unity` as a template repository:
- Send a PATCH of the repo with `is_template=true` through the D16 gh config.
- Read it back with `gh api repos/Unknownow/game-studio-unity --jq .is_template`. It must print `true`.

**S9.** Delete `/tmp/ghcfg-unknownow`. Confirm `ls /tmp/ghcfg-unknownow` fails. Tick the steps with `plan_check`.

**S10.** Verify: open a case-sensitive clone of `Unknownow/game-studio-unity` (macOS or Linux) in Unity 6000.3 — look for:
- the project loads with `Assets/` as its only asset folder, with no second `assets/`
- the menu "Game Studio Tools" is present
- the console shows no compile errors

**S11.** Verify: create a game repo from the template, clone it, and run `python tools/studio.py setup` — look for:
- `Packages/manifest.json` lists `com.unknownow.studio-tools` as `https://github.com/Unknownow/game-studio-unity.git?path=/Packages/com.unknownow.studio-tools#v0.1.0`
- the embedded package folder is gone
- Unity resolves the package on open

### 6. Tests
No new tests. The base tests were added in PR #3. The fork's `test_engine_unity.py` (19 tests) already exists and ships in commit 3.

**After S2 (base, read-only):** CI green on the merge commit.

**Fork commands, in order (S4), from `D:/personal/game-studio-unity`:**
1. `python -m unittest discover -s tools/gamestudio/tests -t tools -q` (fast, ~40–60 s) → `OK`. This includes `test_engine_unity` (19), `test_no_lowercase_assets_root` and the layer tests. `test_counts` stays consistent with the fork's counts.
2. `python tools/studio.py check` → `check: 0 errors`, with no `engine-hooks`, `engine-pin`, `legacy-assets` or `data-json` lines.
3. `python tools/studio.py upstream-diff --clone D:/scratch/ccgs-v1.2.0 --to v1.2.0 --coverage` → exit 0.
4. `python tools/studio.py claude-sync` → `75 skills, 39 agents`, then delete `.claude/`.
5. EditMode run (**slow**, 3–6 min), command in §3 → exit 0, and `editmode.xml` has `result="Passed" total="45" passed="45" failed="0"`. While fixing, add `-testFilter Unknownow.StudioTools.Tests.<Class>`. Run the full command once.
6. `ProjectSettingsCheck.RunBatch` and `MissingReferenceAudit.RunBatch` (**slow**, 1–2 min each) → exit 0, with 0 audit findings.
7. `python tools/studio.py test-run --timeout 1200 --log D:/scratch/unity-results/testrun.log` (**slow**) → exit 0, `tests total=41 passed=41 failed=0`. Afterwards there is no `InitTestScene*` in `git status`, and `production/qa` is deleted.

Rerun the slow suites only if a later fix changes `Packages/`, `ProjectSettings/` or `Assets/`.

**After S5:**
- `git diff --diff-filter=MDR base/main..main` → empty.
- `git ls-files | grep '^assets/'` → empty.

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
- No file in `D:/projects/pi-config` has changed, apart from the plan ticks.
- `/tmp/ghcfg-unknownow` is deleted.

### 8. Risks, rollback, and what not to touch
- **Merge gate refusal in S2:**
  - If `gh pr merge` is still refused as unjudged after a passing `judge` on `2dcc797`, stop and report.
  - Don't push to `main` directly, don't use `git_task` as a bypass, and don't change the tree to provoke a new judge round.
- **Windows case folding:** always rename in two steps, with `core.ignorecase=false`. If git or Unity writes lowercase `assets/` paths back, stop and report.
- **Stash:** a failed fast-forward or a conflicting restore means stop and report. Never `git stash drop` before a clean restore is confirmed.
- **Unity licence error:** stop and report.
- **Red CI:**
  - Base: stop. The rollback is a revert PR of the merge commit.
  - Fork: stop. The tag and the template step don't run.
- **Do not touch:**
  - `D:/projects/**`
  - `~/.ssh`, `~/.gitconfig*`, the active `gh` account (no `gh auth switch`)
  - base `v0.1.0`
  - the local base checkout's untracked `assets/data/README.md`
  - `D:/scratch/**` (never committed)
  - `Library/`, `.claude/`, `project.local.toml`, `production/qa/**` run outputs
  - any base-owned file in the fork
  - CCGS scripts (never run them; run Python on fetched files only with `-I`)

### 9. Commits
**Base:** none new. PR #3 is merged as is, with a merge commit.

**Fork**, on `main` after the fast-forward to BASE_MAIN:
1. `feat(unity): minimal Unity 6.3 LTS project`: `Assets/README.md`, `Assets/**/*.meta`, `Packages/manifest.json`, `Packages/packages-lock.json`, `ProjectSettings/**`.
2. `feat(unity): engine pin, ENGINE.md hooks, reference docs, roles and rules`: `engine.toml`, `ENGINE.md`, `engine-reference/unity/**`, `roles/unity-*.md`, `rules/unity/**`, `studio-tests/agents/engine/unity/**`, `files.manifest.d/unity.manifest`, `UPSTREAM.unity.toml`.
3. `feat(studio): Unity engine plugin`: `tools/gamestudio/engines/unity.py`, `tools/gamestudio/tests/test_engine_unity.py`.
4. `feat(package): com.unknownow.studio-tools 0.1.0`: `Packages/com.unknownow.studio-tools/**`.

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 In `D:/personal/game-studio-base`, check `git status`. Expect it clean, on `fix/assets-root-and-layer-tests`, with HEAD 
- [ ] S2 Deliver: merge — base PR #3, as a merge commit with delete-branch, through the D16 gh config. Don't delete the gh config
- [ ] S3 In `D:/personal/game-studio-unity`, check `git status` and confirm the branch is `main` at `48ccc4c`, then:
- [ ] S4 Run the fork checks in §6 in order. Then:
- [ ] S5 Make the four commits on `main` (§9). Then:
- [ ] S6 Deliver: the first push of the fork's commits straight to `main` of `game-studio-unity`. Then poll CI on that commit eve
- [ ] S7 Deliver: tag `v0.1.0` on `game-studio-unity` `main` → call `deliver {tag: {name: "v0.1.0", repo: "D:/personal/game-studi
- [ ] S8 Mark `Unknownow/game-studio-unity` as a template repository:
- [ ] S9 Delete `/tmp/ghcfg-unknownow`. Confirm `ls /tmp/ghcfg-unknownow` fails. Tick the steps with `plan_check`.
## For you after the flow
- S10 Verify: open a case-sensitive clone of `Unknownow/game-studio-unity` (macOS or Linux) in Unity 6000.3 — look for:
- S11 Verify: create a game repo from the template, clone it, and run `python tools/studio.py setup` — look for:
## Outcome
2026-10-29T04:54:01.410Z — failed: stage 1: no changes; back to planning · 2 human check(s) for you (see the card)
