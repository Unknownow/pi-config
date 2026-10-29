<!-- pi-workflow plan v1 flow=20261029-1023-stage-3-base-engine-layer-fixes-delivere-759e -->
## Plan: Stage 3: base engine-layer fixes (delivered), then the `game-studio-unity` fork and the `com.unknownow.studio-tools` 0.1.0 package

### 1. Goal and non-goals
**Goal.** The base work is already done. Base `Unknownow/game-studio-base` `main` (`48ccc4c`, PR #2) is ready for an engine layer that only adds files:
- `engine-hooks` also scans `roles/`
- maps from an `UPSTREAM.<layer>.toml` take precedence over `engine-layer:` ignores
- the content tests tolerate engine-layer files
- `.gitignore` covers Unity and IDE generated files
- the Godot/Unreal leftovers are removed

What remains is to build `Unknownow/game-studio-unity`: a real fork of base `main` that only adds files. It contains:
- a minimal Unity 6000.3 project
- `ENGINE.md`, covering all 19 hook IDs
- `engine.toml`, pinned to 6.3 LTS
- 16 reference docs, 5 Unity roles and 9 Unity rules
- the `engines/unity.py` plugin
- the UPM package `com.unknownow.studio-tools` 0.1.0 with its 4 Editor features

The repo is tagged `v0.1.0` and marked as a GitHub template repository.

**Non-goals:**
- Any change to `D:/projects/pi-config` or any `D:/projects/**`.
- pi workflow integration.
- Godot or Unreal content.
- A Unity build or Unity tests in CI.
- A UPM registry server.
- A real game.
- Third-party Python dependencies.
- Retagging base.
- Any further base change.
- Removing Godot/Unreal mentions in `studio-tests/**`, `tools/**` or `UPSTREAM.toml`.
- Fixing the staged skill-lint advice, which reads the working tree.

### 2. User decisions
- D1: The templates stand alone, not tied to pi or Claude Code. They work with pi, Codex, Cursor, Claude Code and humans. Every skill is a numbered checklist.
- D2: Unity comes first. Base is engine-agnostic. The Unity repo is a real fork of base that only adds files, in its own places.
- D3: The repos are `Unknownow/game-studio-base` and `Unknownow/game-studio-unity`.
  - Both are public, and no repo name contains "claude".
  - Local folders are under `D:/personal/`.
  - Remotes are `git@github-personal:Unknownow/<repo>.git`, and the Unity repo also has a `base` remote.
- D4: The runtime is Python 3.11+, standard library only (`tomllib`). Config lives in `project.toml`, a gitignored `project.local.toml`, and `UPSTREAM*.toml`.
- D5: Git hooks are tiny bash scripts that fail loudly when Python is missing. CI runs the same checks.
- D6: Only config, story sections, data JSON, evidence and frontmatter checks block, plus `engine-hooks`, `manifest-game-owned` and Unity's `engine-pin`. Style rules are advice.
- D7: The default rigor is `minimal`.
- D8: The Claude Code add-on ships in base. `claude-sync` generates `.claude/`.
- D9: Games update through `files.manifest`, `files.manifest.d/*.manifest` and `update`.
- D10: Upstream sync works per CCGS release tag, with one upstream map per repo. The flow is upstream → base → Unity (git merge) → games.
- D11: The UPM package:
  - name `com.unknownow.studio-tools`, display name "Game Studio Tools"
  - assemblies `Unknownow.StudioTools.Editor` and `Unknownow.StudioTools.Tests`
  - lives at `Packages/com.unknownow.studio-tools/`
  - games use `https://github.com/Unknownow/game-studio-unity.git?path=/Packages/com.unknownow.studio-tools#vX.Y.Z`
  - one tag versions both the template and the package
- D12: The licence is MIT. Copyright is Cuong Bui and Donchitos. `NOTICE` is as in base.
- D13: The git identity under `D:/personal/` is `Cuong Bui <cuong.bpt82@gmail.com>`.
- D14: The first commits of `game-studio-unity` go straight to `main`. Base changes use a branch and a pull request.
- D15: The 5 CCGS Unity agents become Unity roles. Only Claude Code runtime files, Godot/Unreal content and CCGS metadata are ignored.
- D16: Base was delivered in earlier stages. This Unity work is the last part.
- D17: Role frontmatter is `name`, `description`, `tier`, `can`, `memory` and `skills`.
- D19: Agent memory lives in `.agents/memory/<role>.md`.
- D20: `scene-files` is rewritten for Unity. Engine path patterns live in Unity rules that use `extends:`.
- D24: Frontmatter stays portable and is validated.
- D25: Base skills and roles call `ENGINE.md` hook sections. Unity never overrides a skill.
- D26: Unity 6.3 LTS is pinned in `engine.toml`, and the pin must match `VERSION.md`. `status` warns when the editor is on another line. The `setup-engine` upgrade mode covers moving to a newer LTS. The package minimum is `6000.3`.
- D27: Package 0.1.0 ships `EvidenceCapture`, `BatchTests`, `MissingReferenceAudit` and `ProjectSettingsCheck`.
- D28: Python 3.12 at `/c/Users/IEC-WW/AppData/Local/Programs/Python/Python312`.
- D29: `game-studio-unity` is marked as a template repository at its first release.
- D31: A small base PR landed first (done, PR #2). Unity is cloned from base `main`, not from `v0.1.0`. Base is not retagged.

### 3. Facts the executor needs
**Shell and tools**
- Every bash call starts with `export PATH="/c/Users/IEC-WW/AppData/Local/Programs/Python/Python312:$PATH"`. The bare `python` is 3.9 and has no `tomllib`.
- Unity editor: `C:/Program Files/Unity/Hub/Editor/6000.3.25f1/Editor/Unity.exe`. The built-in input system is `com.unity.inputsystem-1.20.0.tgz` (in `…/Editor/Data/Resources/PackageManager/Editor/`).
- Read the `com.unity.test-framework` version from the `Packages/manifest.json` that S10 creates.
- **`gh` against Unknownow repos:**
  - Use a temporary `GH_CONFIG_DIR=/tmp/ghcfg-unknownow`.
  - Its `hosts.yml` holds `github.com: {oauth_token: <gh auth token -u Unknownow>, user: Unknownow, git_protocol: ssh}`.
  - Delete the folder afterwards.
  - Never print the token, and never run `gh auth switch`.
- `git ls-remote git@github-personal:Unknownow/game-studio-unity.git` returns nothing: the repo exists and is empty. `D:/personal/game-studio-unity` does not exist.
- The judge only sees a repo after a file in it has been edited with the `edit`/`write` tool. Write the new files with the `write` tool, not with bash.
- Write Python edit scripts with the `write` tool, not heredocs. Heredoc `\n` escapes broke a test file once.

**Base state (`main` = `48ccc4c`; tag `v0.1.0` = `063372c`, untouched)**
- Hook check: `tools/gamestudio/check.py:17-18` (`HOOK_RE`, `HOOK_HEADING_RE` = `^## hook: <id>\s*$`). `check_engine_hooks` is at `:221`, and `:227` scans `.agents/skills`, `docs/studio` and `roles`.
- The 19 hook IDs:
  - `dev-story/engine-checks`, `dev-story/specialists`
  - `qa-tester/test-pattern`
  - `run-and-observe/capture`
  - `security-audit/patterns`
  - `setup-engine/commands`, `language`, `naming`, `scaffold`, `specialists`, `stack`, `testing`, `upgrade`, `version`
  - `smoke-check/run-tests`
  - `soak-test/memory-tool`
  - `test-helpers/engine-helpers`
  - `test-setup/ci-workflow`, `test-setup/engine-files`
- Before writing `ENGINE.md`, confirm the list with `grep -rhoE "hook: [a-z0-9-]+/[a-z0-9-]+" .agents/skills docs/studio roles | sort -u`.
- **Upstream** (`tools/gamestudio/upstream.py`):
  - `load_maps` is at `:8`. It reads every `UPSTREAM*.toml` and tags each map with `_layer` (`:18`), which is true for every file other than `UPSTREAM.toml`.
  - `classify` (`:32-51`) checks in this order:
    1. ignores whose reason is not `engine-layer:`
    2. `_layer` maps
    3. `engine-layer:` ignores
    4. base maps
    5. `UNMAPPED`
  - Only `UPSTREAM.toml` sets the tag, unless none sets one.
- The 9 `engine-layer:` ignores in `UPSTREAM.toml`:
  - `.claude/skills/dev-story/references/engine-checks.md`
  - `docs/engine-reference/unity/**`
  - `.claude/agents/unity-specialist.md`, `unity-addressables-specialist.md`, `unity-dots-specialist.md`, `unity-shader-specialist.md`, `unity-ui-specialist.md`
  - `studio-tests/agents/engine/unity/**`
  - `.claude/rules/scene-files.md`
- **Repo content test** (`tools/gamestudio/tests/test_repo_content.py`):
  - `ENGINES` (`:19`) is the stems of `tools/gamestudio/engines/*.py`. Adding `unity.py` makes `unity` an engine.
  - `engine_layer` (`:22`) excludes `roles/unity-*.md`, `rules/unity/**`, `.agents/skills/unity-*` and `studio-tests/agents/engine/**` from the base counts.
  - `test_counts` (`:46`) and `test_no_other_engine_leftovers` (`:84`): the leftover test scans `.agents docs roles rules gates templates AGENTS.md README.md`. It skips `engine-reference` and engine-layer files, so `ENGINE.md` and `engine-reference/unity/**` are not scanned.
  - The Unity roles and rules are engine-layer files, so they are skipped too. Still keep the Godot/Unreal words out of them.
- `tools/gamestudio/common.py:6` `SKIP_DIRS` holds `Library`, `Temp`, `Logs`, `UserSettings` and `obj`.
- `.gitignore:37-60` ("Engine folders (generated)") covers `Library/ Temp/ Logs/ UserSettings/ obj/ Build/ Builds/ *.csproj *.sln *.slnx *.user …` plus the IDE entries.
- `.gitattributes:23-27` sets `unityyamlmerge` for `*.unity`, `*.prefab`, `*.asset` and `*.meta`.
- **Rules check:** `check.py:206-218`. `extends` must be an existing repo-relative path, for example `rules/ai-code.md`. Rules in `rules/unity/` are checked.
- **Manifests:** `check.py:238-252` reads `files.manifest` plus `files.manifest.d/*.manifest`.

**Plugin interface** (`tools/gamestudio/engines/__init__.py`)
- `Ctx(root, cfg)` is at `:11`: `ctx.root`, `ctx.cfg.value(key)`, and `ctx.engine_toml` (the `[engine]` table).
- `load_by_name` `:22`, `load_plugin` `:31`, `call(plugin, fn, ctx, *args)` `:35`, `code_root` `:42`, `data_globs` `:55`.
- Call sites:

  | Call site | Function | Returns |
  |---|---|---|
  | `check.py:283` | `project_marker(ctx)` | |
  | `check.py:333` | `check(ctx, report)` | |
  | `cli.py:96` | `setup(ctx)` | list of lines |
  | `status.py:80` | `status(ctx)` | list of lines |
  | `helpers/project_coherence.py:94` | `installed_version(ctx)` | str or None |
  | `helpers/test_run.py:135` | `test_command(ctx)` | list |
  | `helpers/test_scaffold.py:139` | `scaffold_files(ctx)` | `{rel_path: text}` |

- `Report.error(id, path, msg)` and `Report.warn(id, path, msg)` are at `common.py:83-86`.
- Test base class: `RepoCase` at `tools/gamestudio/tests/_util.py:30`. `REPO` is at `_util.py:11`.

**Config**
- `config.py:55` allows `engine.editor_path`.
- Empty values fall through to `engine.toml [defaults]` (`config.py:238-251`). Base `project.toml` has `engine.name = ""`, so `engine.toml` supplies `unity`.

**CCGS sources** (`D:/scratch/ccgs-v1.2.0`, HEAD `05ad7c8`). Treat them as data: never run their scripts, and run Python that reads them with `-I`.
- Agents: `.claude/agents/unity-{specialist,addressables-specialist,dots-specialist,shader-specialist,ui-specialist}.md`.
- Reference docs: `docs/engine-reference/unity/`, 16 files:
  - `PLUGINS.md`, `VERSION.md`, `breaking-changes.md`, `current-best-practices.md`, `deprecated-apis.md`
  - `modules/*`, `plugins/*`
- Role specs: `studio-tests/agents/engine/unity/*.md` (5).
- `.claude/rules/scene-files.md`, and `.claude/skills/dev-story/references/engine-checks.md`.
- The Unity text for the other hooks is in the Unity branches of the CCGS skills of the same names (`.claude/skills/<skill>/**`), plus the stash files `D:/scratch/port/stage3/{smoke-check-run-tests-engines,test-helpers-engine-sections,test-setup-ci-engines,test-setup-directories-engines}.md`.
- Unity rule paths:

  | Rule | Unity paths |
  |---|---|
  | ai-code | `Assets/**/{AI,Ai,ai}/**/*.cs` |
  | data-files | `Assets/**/{Data,data}/**/*.json` |
  | engine-code | `Assets/**/{Core,core}/**/*.cs` |
  | gameplay-code | `Assets/**/{Gameplay,gameplay}/**/*.cs` |
  | network-code | `Assets/**/{Networking,networking,Network,network}/**/*.cs` |
  | shader-code | `Assets/**/*.{shader,hlsl,cginc,compute,shadergraph}` |
  | test-standards | `Assets/Tests/**/*.cs` |
  | ui-code | `Assets/**/{UI,Ui,ui}/**/*.cs` |
  | scene-files | `**/*.unity`, `**/*.prefab`, `Assets/**/*.asset` |

**Port tooling:** `D:/scratch/port/port.py` (`port_text` `:18`, `port_role` `:147`, `port_rule` `:196`). It is scratch only; import it from a scratch script and never commit it.

### 4. Design
**4.1 Base changes:** delivered in PR #2. No base edits are allowed in this work.

**4.2 Unity repo layout.** Only new files:
- `ENGINE.md`, `engine.toml`
- `engine-reference/unity/**` (16)
- `roles/unity-*.md` (5)
- `rules/unity/*.md` (9)
- `tools/gamestudio/engines/unity.py`, `tools/gamestudio/tests/test_engine_unity.py`
- `files.manifest.d/unity.manifest`, `UPSTREAM.unity.toml`
- `studio-tests/agents/engine/unity/*.md` (5)
- the `Assets/` files Unity creates, plus `Assets/README.md`
- `Packages/manifest.json`, `Packages/packages-lock.json`, `ProjectSettings/**`
- `Packages/com.unknownow.studio-tools/**`

There are no Unity-only skills, and `catalog.toml` is not edited.

**4.3 File formats**

`engine.toml`, exactly:
```
[engine]
name = "unity"
lts = "6.3"
editor_line = "6000.3"
code_root = "Assets"
tests_root = "Assets/Tests"
project_marker = "ProjectSettings/ProjectVersion.txt"
data_globs = ["Assets/**/Data/**/*.json"]
[defaults]
"engine.name" = "unity"
"engine.version" = "6.3 LTS"
```

`ENGINE.md`:
- Frontmatter `engine: unity`, then a short intro: what the file is, and that skills and roles call its sections.
- Then exactly one `## hook: <id>` heading per hook ID (19). Each is followed by numbered steps for Unity 6.3 LTS. There are no other `## hook:` headings.
- Commands are exact: `python tools/studio.py test-run`, the full `Unity.exe` batch lines, and the package menu paths and batch methods from 4.5.
- Required content:
  - `run-and-observe/capture` names `Unknownow.StudioTools.Editor.EvidenceCapture.CaptureBatch`, with its arguments, and warns never to use `-nographics` with it.
  - `smoke-check/run-tests` names `python tools/studio.py test-run`.
  - `setup-engine/upgrade` has these numbered steps:
    1. Install the new LTS.
    2. Update `engine.toml` `lts` and `editor_line`.
    3. Update the `VERSION.md` Engine Version row.
    4. Update `package.json` `unity`.
    5. Open the project and commit the upgraded `ProjectSettings/`.
    6. Run `check` and the EditMode suite.
  - `qa-tester/test-pattern` describes NUnit `[Test]` / `[UnityTest]` in EditMode and PlayMode asmdefs under `Assets/Tests/`.
  - `setup-engine/specialists` and `dev-story/specialists` name the 5 Unity roles.
  - `test-setup/ci-workflow` notes that Unity tests in CI are left to the game (for example `game-ci/unity-test-runner@v4`) and are not shipped.

Roles (`roles/unity-*.md`):
- Base role frontmatter (D17), ported with `port_role`.
- `tier: standard`.
- `unity-specialist` has `can: [read, write, shell, delegate]`; the other 4 have `can: [read, write, shell]`.
- The body line `**Allowed actions:** …` matches `can`.

Rules (`rules/unity/<name>.md`):
- Frontmatter `paths:` is the §3 Unity patterns, and `extends: rules/<name>.md`.
- The body holds only the Unity additions from the CCGS rule body.
- `scene-files.md` has the scene-files paths and no `extends`. It covers:
  - YAML and merge-sensitive files
  - never hand-edit `fileID` or `guid`
  - commit `.meta` files with their assets
  - edit in the Editor
  - Force Text and Visible Meta are required
  - UnityYAMLMerge (`.gitattributes:23-27`)

`files.manifest.d/unity.manifest` has one entry per line:
- `ENGINE.md`
- `engine.toml`
- `engine-reference/**`
- `roles/unity-*.md`
- `rules/unity/**`
- `tools/gamestudio/engines/unity.py`
- `studio-tests/agents/engine/unity/**`

It has no game-owned paths.

`UPSTREAM.unity.toml`:
- A header comment.
- `[upstream] tag = "v1.2.0"`.
- `[[map]]` entries for all 9 engine-layer paths:

  | `from` | `to` |
  |---|---|
  | `.claude/skills/dev-story/references/engine-checks.md` | `ENGINE.md` |
  | `docs/engine-reference/unity/**` | `engine-reference/unity/` |
  | each `.claude/agents/unity-*.md` | `roles/<same name>.md` |
  | `studio-tests/agents/engine/unity/**` | `studio-tests/agents/engine/unity/` |
  | `.claude/rules/scene-files.md` | `rules/unity/scene-files.md` |

**4.4 Unity plugin (`tools/gamestudio/engines/unity.py`, stdlib only)**

Helpers:
- `_project_version(ctx)` reads `m_EditorVersion:` from `ProjectSettings/ProjectVersion.txt`. It returns None when the file or the line is missing.
- `_editor_path(ctx)` returns `engine.editor_path` if set. Otherwise it returns the Hub path for that version:
  - Windows: `C:/Program Files/Unity/Hub/Editor/<v>/Editor/Unity.exe`
  - macOS: `/Applications/Unity/Hub/Editor/<v>/Unity.app/Contents/MacOS/Unity`
  - Linux: `~/Unity/Hub/Editor/<v>/Editor/Unity`

  With no version and no `editor_path`, it returns None.

`status(ctx)`:
- Returns `["editor: <v> (pinned line <editor_line>, Unity <lts> LTS)"]`.
- If `<v>` does not start with `editor_line + "."`, it adds `WARN engine-pin: editor <v> is not on the pinned line <editor_line> (Unity <lts> LTS); see the setup-engine upgrade mode`.
- Without `ProjectVersion.txt`, the first line says `editor: unknown`.

`check(ctx, report)`:
- ERROR `engine-pin` on `engine.toml` when `lts` or `editor_line` is missing.
- ERROR `engine-pin` on `engine-reference/unity/VERSION.md` when the file is missing, or its `| **Engine Version** |` row lacks `Unity <lts> LTS`.
- WARN `engine-pin` on `ProjectSettings/ProjectVersion.txt` when the editor is not on the pinned line.

`installed_version(ctx)` returns `m_EditorVersion` when `_editor_path` exists on disk, otherwise None.

`test_command(ctx)`:
- Returns `[<editor>, "-batchmode", "-projectPath", <root>, "-executeMethod", "Unknownow.StudioTools.Editor.BatchTests.Run", "-testPlatform", "All", "-logFile", "production/qa/test-results/unity.log"]`.
- If the editor is None or missing, it writes `studio: Unity editor not found: <path>; set engine.editor_path in project.local.toml` to stderr and calls `sys.exit(2)`.

`scaffold_files(ctx)`:
- Returns 4 files:
  - `Assets/Tests/EditMode/<Name>.Tests.EditMode.asmdef`
  - `Assets/Tests/EditMode/SampleEditModeTest.cs`
  - `Assets/Tests/PlayMode/<Name>.Tests.PlayMode.asmdef`
  - `Assets/Tests/PlayMode/SamplePlayModeTest.cs`
- `<Name>` is `project.name` with non-alphanumerics removed, or `Game` when that is empty.
- The asmdefs:
  - reference `UnityEngine.TestRunner` and `UnityEditor.TestRunner`
  - set `overrideReferences: true` with `precompiledReferences: ["nunit.framework.dll"]`
  - set `defineConstraints: ["UNITY_INCLUDE_TESTS"]`
  - EditMode also sets `includePlatforms: ["Editor"]`

`setup(ctx)`:
- Get `origin` from `git remote get-url origin`. A missing remote counts as a non-template origin.
- If origin matches `Unknownow/game-studio-unity(\.git)?$`, return `[]`.
- Otherwise, if `Packages/com.unknownow.studio-tools/package.json` exists:
  1. Read its `version` V, then delete the folder.
  2. In `Packages/manifest.json`, set `dependencies["com.unknownow.studio-tools"] = "https://github.com/Unknownow/game-studio-unity.git?path=/Packages/com.unknownow.studio-tools#vV"`.
  3. Remove the package name from `testables`, and drop `testables` if it becomes empty.
  4. Write the file back with 2-space indent, key order kept and a trailing newline.
  5. Return `["removed Packages/com.unknownow.studio-tools (embedded copy)", "Packages/manifest.json: com.unknownow.studio-tools -> <url>"]`.
- No embedded folder → return `[]`.

`code_root`, `data_globs` and `project_marker` come from `ctx.engine_toml`.

**4.5 Package `Packages/com.unknownow.studio-tools/` 0.1.0**
- `package.json`:
  - `name`, `version "0.1.0"`, `displayName "Game Studio Tools"`, `unity "6000.3"`, `description`, `author {"name":"Cuong Bui"}`, `license "MIT"`
  - `dependencies {"com.unity.test-framework": <S10 version>}`
- `LICENSE.md` (MIT, Cuong Bui), `README.md` (install URL from D11, menus, batch lines) and `CHANGELOG.md` (`## [0.1.0]`).
- Two Editor-only asmdefs:
  - `Editor/Unknownow.StudioTools.Editor.asmdef`
  - `Tests/Editor/Unknownow.StudioTools.Tests.asmdef`, which references the Editor assembly, `UnityEngine.TestRunner`, `UnityEditor.TestRunner` and `nunit.framework.dll`, with `UNITY_INCLUDE_TESTS`.
- Namespace `Unknownow.StudioTools.Editor`.
- Logic lives in pure static methods that the tests call.
- Reports go under `<project>/production/qa/`, where project = the parent of `Application.dataPath`.
- Batch methods parse `Environment.GetCommandLineArgs()` and end with `EditorApplication.Exit(code)`: 0 pass, 1 findings, 2 bad argument or setup error.
- Menu items are `Tools/Game Studio/Capture Evidence`, `Run All Tests`, `Missing Reference Audit` and `Project Settings Check`. Each logs a summary and shows a dialog.

`EvidenceCapture`:
- `CaptureBatch -story <slug> -scene <path> [-width <int>] [-height <int>]`; the size defaults to 1920×1080.
- The slug must match `^[a-z0-9][a-z0-9._-]*$`.
- Output goes to `production/qa/evidence/<slug>/<slug>-<yyyyMMdd-HHmmss>.png`.
- In Play Mode it uses `ScreenCapture`. Otherwise it renders `Camera.main` (or the first camera) to a RenderTexture.
- No camera → 2. It needs a GPU, so it is never run with `-nographics`.

`BatchTests`:
- `Run -testPlatform EditMode|PlayMode|All` through `TestRunnerApi`.
- Writes `production/qa/test-results/editmode.xml` and/or `playmode.xml`.
- Exits 0 when all pass, 1 on any failure, 2 on a bad or missing value.
- Started without `-quit`; it exits from the run-finished callback.

`MissingReferenceAudit`:
- `RunBatch` scans every `*.unity` and `*.prefab` under `Assets/` for missing scripts and dangling object references (`objectReferenceValue == null && objectReferenceInstanceIDValue != 0`).
- Writes `production/qa/audit/missing-references.json` = `{"generated", "missingScripts":[{"asset","object"}], "missingReferences":[{"asset","object","component","property"}]}`.
- Exit 1 if either list is non-empty.
- The menu version saves and restores the open scenes.

`ProjectSettingsCheck`:
- Checks:
  - `force-text`: `EditorSettings.serializationMode == ForceText`
  - `visible-meta`: `VersionControlSettings.mode == "Visible Meta Files"`
  - `input-system`: `activeInputHandler` is 1 or 2, read from `ProjectSettings/ProjectSettings.asset`
- Writes `production/qa/audit/project-settings.json` = `{"generated","checks":[{"id","pass","actual"}]}`.
- Exit 1 on any failure.

**4.6 Template project**
- Create the project in batch mode in `D:/scratch/unity-skel`, then copy its `Assets/`, `Packages/` and `ProjectSettings/` into the repo.
- `Packages/manifest.json` adds `"com.unity.inputsystem": "1.20.0"` and `"testables": ["com.unknownow.studio-tools"]`. The embedded package needs no dependency entry.
- `ProjectSettings.asset` sets `activeInputHandler: 1`. Also use Force Text and Visible Meta.
- `Assets/README.md` explains the layout.
- `Packages/packages-lock.json` is committed once Unity regenerates it after the edits (S15 batch runs). Re-copy it then.

**4.7 Failure handling**
- A Unity licence or activation error in any batch run → stop and report it to the user.
- Any need to edit a base file → stop and report. That would be a base PR, never a fork edit.
- Generated files untracked after `.gitignore` (for example under `Library/`, `production/qa/**` outputs, `.claude/`) → don't commit them. Delete scratch outputs inside the repo that the checks create.
- If they aren't covered by `.gitignore`, stop and report.

**4.8 Scale**
- The Python fast suite (~225 tests, ~40–60 s) must stay under 2 min.
- `check` must stay under 5 s for 1,000 stories. `Library/` is skipped.
- The EditMode run takes about 3–6 min. Each batch check takes 1–2 min.
- The audit runs in one process and is fine up to a few thousand scenes and prefabs. Beyond that a game must scope it, which is not part of 0.1.0.

**4.9 Alternatives rejected**
- Editing base files in the fork: breaks D2.
- Cloning from base `v0.1.0`: it lacks the fixes.
- Adding the Unity roles to `catalog.toml`: that is a base file.
- A `scene-files` rule in base: it is engine-specific (D20).
- Running `EvidenceCapture` in the batch tests: it needs a GPU.

### 5. Steps

#### Rules for every step
- Read the CCGS source before porting.
- After porting, grep the new files for `\.claude`, `CLAUDE_`, `` !` ``, `Task(Create|Update|List|Get|Output|Stop)`, `subagent`, `spawn`, `Agent tool`, `[Gg]odot`, `GDScript`, `[Uu]nreal`, `Blueprint`, `\.sh\b`, `AskUserQuestion` and "Claude", and fix every hit by hand.
- Text rewrites:
  - agent spawn → `Act as <role>: read roles/<role>.md, then …`
  - `.claude/docs/` → `docs/studio/`
  - "Claude's cutoff" → "your model's knowledge cutoff"
- Check `git status` and the branch before changing anything.
- Pushes are standalone bash commands, run after a judge pass.

### Stage 1: Base engine-layer fixes (delivered)
**S1.** Done: branch `fix/engine-layer-support` from `063372c`.

**S2.** Done: `check_engine_hooks` scans `roles/` (`check.py:227`).

**S3.** Done: `classify` precedence with `_layer` (`upstream.py:18`, `:32-51`).

**S4.** Done: `test_repo_content.py` engine-layer exclusion and the leftover test.

**S5.** Done: `.gitignore` patterns.

**S6.** Done: leftovers removed.

**S7.** Done: suite 216 OK, `check` 0 errors, `--coverage` exit 0, judge PASS.

**S8.** Done: PR #2 merged, base `main` = `48ccc4c`. No action in this stage beyond confirming that base `main` = `48ccc4c`.

### Stage 2: Unity fork and package
**S9.** Clone base `main` into `D:/personal/game-studio-unity`:
- Clone from `git@github-personal:Unknownow/game-studio-base.git` and confirm HEAD = `48ccc4c`.
- Rename `origin` to `base`, and add `origin` = `git@github-personal:Unknownow/game-studio-unity.git`.
- Confirm `git config user.name` = `Cuong Bui` and `user.email` = `cuong.bpt82@gmail.com`.
- Run `python tools/studio.py setup` so the hooks are active. Base has no plugin yet, so it changes nothing else.

**S10.** Unity project per 4.6:
- Run `"C:/Program Files/Unity/Hub/Editor/6000.3.25f1/Editor/Unity.exe" -batchmode -quit -createProject D:/scratch/unity-skel -logFile D:/scratch/unity-skel.log` in the foreground (timeout 900 s). Check the exit code and grep the log for `licen`.
- Copy `Assets/`, `Packages/` and `ProjectSettings/` into the repo, then apply 4.6.
- Record the `com.unity.test-framework` version for S14.
- On a licence error, stop and report.
- Confirm `git status` shows no `Library/` or other generated files.

**S11.** Unity content, per 4.2 and 4.3:
- `engine.toml`.
- `engine-reference/unity/`: the 16 files ported from CCGS. `VERSION.md` has a `| **Engine Version** | Unity 6.3 LTS |` row, and its text targets 6.3 LTS.
- The 5 `roles/unity-*.md`.
- The 9 `rules/unity/*.md`.
- `files.manifest.d/unity.manifest`.
- `UPSTREAM.unity.toml`.
- The 5 role specs in `studio-tests/agents/engine/unity/`.
- Model the frontmatter on an existing base role (`roles/qa-tester.md`) and an existing base rule (`rules/ai-code.md`).

**S12.** Write `ENGINE.md` per 4.3: one section per hook ID, filled from the CCGS Unity branches, `engine-checks.md` and `D:/scratch/port/stage3/`. `python tools/studio.py check` must show no `engine-hooks` finding.

**S13.** Write `tools/gamestudio/engines/unity.py` per 4.4, and `tools/gamestudio/tests/test_engine_unity.py` (§6).
- Model the plugin shape on the §3 call sites, and the tests on `RepoCase` (`tests/_util.py:30`) and `tests/test_check.py`.
- Tests that need git set the origin in the temporary repo.
- After this, the real repo's `check` must be clean of `engine-pin` errors.

**S14.** Create `Packages/com.unknownow.studio-tools/` per 4.5, with the 4 EditMode test classes (§6).
- Every Unity asset and folder in the package needs a `.meta` file. Let Unity generate them in the S15 batch runs, then commit them.
- Never hand-write a GUID that collides with another one.

**S15.** Run the §6 commands in order:
1. fast suite
2. `check`
3. `--coverage`
4. `claude-sync`, then delete `.claude/`
5. the Unity EditMode run
6. `ProjectSettingsCheck`
7. `MissingReferenceAudit`

Then:
- Copy in or confirm the `.meta` files and `packages-lock.json` that Unity generated.
- Delete the run outputs under `production/qa/` unless they are gitignored.
- Commit per §9.
- Confirm `git diff --diff-filter=MDR base/main..main` is empty.
- Call `judge` with `full=true` and `base=48ccc4c`.

**S16.** Deliver: the first push of the §9 commits straight to `main` of `game-studio-unity` (D14), after a judge pass. CI on `main` must be green; confirm with the Unknownow `GH_CONFIG_DIR`.

**S17.** Deliver: tag `v0.1.0` on `game-studio-unity` `main` → call `deliver {tag: {name: "v0.1.0", repo: "D:/personal/game-studio-unity"}, step: "S17"}`.

**S18.** Mark `Unknownow/game-studio-unity` as a template:
- With the Unknownow `GH_CONFIG_DIR`, send a GitHub API PATCH on `repos/Unknownow/game-studio-unity` with `is_template=true`.
- Read it back with `gh api repos/Unknownow/game-studio-unity --jq .is_template` and confirm `true`.
- Delete the temporary config folder.

**S19.** Verify: create a scratch game from the template, run `python tools/studio.py setup`, open it in Unity 6000.3.25f1, and try the four `Tools/Game Studio/*` menu items — look for:
- the package resolving from the git URL `#v0.1.0`, with no embedded copy left
- an evidence PNG under `production/qa/evidence/<slug>/`
- test XML files
- both audit JSON files reporting pass

**S20.** Verify: open pi in `D:/personal/game-studio-unity`, accept project trust, run `/skill:help`, and ask "what is the first command to run?" — look for: the skills load, and the answer is `python tools/studio.py status`.

### 6. Tests
**Unity, Python (`tools/gamestudio/tests/test_engine_unity.py`).** Temporary repos with the 4.3 `engine.toml`:

| Test | Input → expected |
|---|---|
| `test_status_warns_off_line_editor` | `m_EditorVersion: 6000.0.64f1` → `status` output contains `engine-pin: editor 6000.0.64f1 is not on the pinned line 6000.3` |
| `test_check_version_md_mismatch_errors` | `VERSION.md` row `Unity 6.4 LTS` → `check` exits 1 with an `engine-pin` ERROR. `Unity 6.3 LTS` with editor `6000.3.25f1` → no `engine-pin` finding |
| `test_setup_converts_embedded_package` | origin `https://github.com/someone/game.git`, embedded `package.json` version `0.1.0`, `testables` holding the package → the folder is removed, the dependency is `https://github.com/Unknownow/game-studio-unity.git?path=/Packages/com.unknownow.studio-tools#v0.1.0`, `testables` is gone, other keys keep their order |
| `test_setup_template_origin_noop` | origin `git@github-personal:Unknownow/game-studio-unity.git` → no file changes, `[]` |
| `test_test_run_missing_editor` | `engine.editor_path` pointing at a missing file → `test-run` exits 2, stderr starts `studio: Unity editor not found:` |
| `test_scaffold_files` | `test-scaffold --engine unity` (or the helper's equivalent) → creates the 4 `Assets/Tests/...` files, and the EditMode asmdef has `UNITY_INCLUDE_TESTS` and `includePlatforms` `Editor` |

**Unity, EditMode** (package `Tests/Editor/`):

| Class | What it checks |
|---|---|
| `EvidenceCaptureTests` | valid and invalid slugs; the path format `production/qa/evidence/<slug>/<slug>-yyyyMMdd-HHmmss.png` |
| `BatchTestsTests` | argument parsing: `EditMode`, `PlayMode`, `All` are OK; a missing or bad value → 2 |
| `MissingReferenceAuditTests` | temp prefabs under `Assets/_StudioToolsTestTemp/`: a missing script and a dangling reference are reported; a clean prefab gives empty lists. Teardown deletes the folder |
| `ProjectSettingsCheckTests` | `activeInputHandler` 0 fails, 1 and 2 pass; the JSON has `generated` and `checks[{id,pass,actual}]` |

**Commands** (repo root `D:/personal/game-studio-unity`)
- Fast suite: `python -m unittest discover -s tools/gamestudio/tests -t tools -q` → `OK`, under 2 min. `test_counts` still passes with 75/34/28/13/71/28.
- `python tools/studio.py check` → `check: 0 errors`, with no `engine-hooks` or `engine-pin` lines.
- `python tools/studio.py upstream-diff --clone D:/scratch/ccgs-v1.2.0 --to v1.2.0 --coverage` → exit 0. The 9 engine-layer paths show as mapped to their 4.3 targets.
- `python tools/studio.py claude-sync` → `75 skills, 39 agents`; then delete `.claude/`.
- `git diff --diff-filter=MDR base/main..main` → empty (after the commits).
- **Slow, Unity EditMode, about 3–6 min.**
  - Fast command while fixing: the full command below plus `-testFilter Unknownow.StudioTools.Tests.<Class>`.
  - Full command, run once before `judge`: `"C:/Program Files/Unity/Hub/Editor/6000.3.25f1/Editor/Unity.exe" -batchmode -nographics -projectPath D:/personal/game-studio-unity -runTests -testPlatform EditMode -testResults D:/scratch/unity-results/editmode.xml -logFile D:/scratch/unity-results/editmode.log` → exit 0, and the XML has `result="Passed"`.
- **Slow, batch checks, about 1–2 min each:**
  - `"…/Unity.exe" -batchmode -nographics -quit -projectPath D:/personal/game-studio-unity -executeMethod Unknownow.StudioTools.Editor.ProjectSettingsCheck.RunBatch -logFile -` → exit 0.
  - The same with `MissingReferenceAudit.RunBatch` → exit 0.

### 7. Done when
- Base `main` has the stage-1 fixes:
  - roles are scanned for hooks
  - engine-layer maps take precedence
  - the content tests handle an engine layer
  - `.gitignore` is extended
  - no leftovers
- On base: the suite passes, `check` exits 0, `--coverage` exits 0, CI is green. `v0.1.0` is unchanged.
- `Unknownow/game-studio-unity` `main`:
  - is base `main` history plus added files only (`git diff --diff-filter=MDR base/main..main` is empty)
  - is a valid Unity 6000.3 project
  - holds `ENGINE.md` covering all 19 hooks, with no `engine-hooks` findings
  - holds `engine.toml` pinned to 6.3 LTS, matching `VERSION.md`
  - holds 16 reference docs, 5 Unity roles and 9 Unity rules
  - holds the Unity plugin and package 0.1.0 with all 4 features
  - passes the Python suite, `check`, `--coverage`, the EditMode suite, `ProjectSettingsCheck` and `MissingReferenceAudit`
  - is tagged `v0.1.0`, with `is_template: true` and green CI
- A game installs the package from `https://github.com/Unknownow/game-studio-unity.git?path=/Packages/com.unknownow.studio-tools#v0.1.0`, and `setup` converts the embedded copy to that URL.
- No file in `D:/projects/pi-config` has changed.

### 8. Risks, rollback, and what not to touch
**Risks**
- A Unity licence or activation failure blocks S10 and S15: stop and report.
- `EvidenceCapture` needs a GPU and is not run in the batch tests. The path and slug tests cover its logic, and S19 covers the capture itself.
- `com.unity.test-framework` and the input system versions must match the 6000.3.25f1 defaults.
- Missing `.meta` files make Unity ignore package files. Let Unity generate them, and commit them.
- CI runs only the Python checks. If CI fails on Unity files, fix it in the fork's added files only.

**Rollback**
- Unity: the repo is new. Delete the tag and force-reset `main` only with the user's consent.
- Base: already merged; revert the PR #2 merge only if the user asks.

**Do not touch**
- Base files from the Unity repo.
- `catalog.toml`.
- Base tag `v0.1.0`.
- `~/.ssh`, `~/.gitconfig*`.
- The active `gh` account.
- `D:/projects/**`.

Never execute CCGS scripts. Never commit `D:/scratch/**`, `.claude/`, `Library/`, `project.local.toml` or the QA run outputs.

### 9. Commits
**`game-studio-base`, branch `fix/engine-layer-support`** (delivered in PR #2):
1. `fix(studio): engine-hooks check reads hook ids in roles`
2. `fix(studio): engine-layer upstream maps take precedence over engine-layer ignores`
3. `test: repo content tests tolerate an engine layer and catch other-engine leftovers`
4. `chore: ignore more Unity and IDE generated files`
5. `docs: remove Godot and Unreal leftovers from skills and studio docs`

**`game-studio-unity`, straight to `main` on top of base `48ccc4c`:**

6. `feat(unity): minimal Unity 6.3 LTS project`: `Assets/`, `Packages/manifest.json`, `Packages/packages-lock.json`, `ProjectSettings/`
7. `feat(unity): engine pin, ENGINE.md hooks, reference docs, roles and rules`: `engine.toml`, `ENGINE.md`, `engine-reference/unity/**`, `roles/unity-*.md`, `rules/unity/**`, `files.manifest.d/unity.manifest`, `UPSTREAM.unity.toml`, `studio-tests/agents/engine/unity/**`
8. `feat(studio): Unity engine plugin`: `tools/gamestudio/engines/unity.py`, `tools/gamestudio/tests/test_engine_unity.py`
9. `feat(package): com.unknownow.studio-tools 0.1.0`: `Packages/com.unknownow.studio-tools/**`

<!-- pi-workflow:status -->
## Checklist
- [x] S1 Done: branch `fix/engine-layer-support` from `063372c`.
- [x] S2 Done: `check_engine_hooks` scans `roles/` (`check.py:227`).
- [x] S3 Done: `classify` precedence with `_layer` (`upstream.py:18`, `:32-51`).
- [x] S4 Done: `test_repo_content.py` engine-layer exclusion and the leftover test.
- [x] S5 Done: `.gitignore` patterns.
- [x] S6 Done: leftovers removed.
- [x] S7 Done: suite 216 OK, `check` 0 errors, `--coverage` exit 0, judge PASS.
- [x] S8 Done: PR #2 merged, base `main` = `48ccc4c`. No action in this stage beyond confirming that base `main` = `48ccc4c`.
- [ ] S9 Clone base `main` into `D:/personal/game-studio-unity`:
- [ ] S10 Unity project per 4.6:
- [ ] S11 Unity content, per 4.2 and 4.3:
- [ ] S12 Write `ENGINE.md` per 4.3: one section per hook ID, filled from the CCGS Unity branches, `engine-checks.md` and `D:/scra
- [ ] S13 Write `tools/gamestudio/engines/unity.py` per 4.4, and `tools/gamestudio/tests/test_engine_unity.py` (§6).
- [ ] S14 Create `Packages/com.unknownow.studio-tools/` per 4.5, with the 4 EditMode test classes (§6).
- [ ] S15 Run the §6 commands in order:
- [ ] S16 Deliver: the first push of the §9 commits straight to `main` of `game-studio-unity` (D14), after a judge pass. CI on `ma
- [ ] S17 Deliver: tag `v0.1.0` on `game-studio-unity` `main` → call `deliver {tag: {name: "v0.1.0", repo: "D:/personal/game-studi
- [ ] S18 Mark `Unknownow/game-studio-unity` as a template:
## For you after the flow
- S19 Verify: create a scratch game from the template, run `python tools/studio.py setup`, open it in Unity 6000.3.25f1, and t
- S20 Verify: open pi in `D:/personal/game-studio-unity`, accept project trust, run `/skill:help`, and ask "what is the first 
