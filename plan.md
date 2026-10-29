<!-- pi-workflow plan v1 flow=20261029-1000-stage-3-base-engine-layer-fixes-then-the-980f -->
I found three more base-side gaps while confirming details. The Unity fork can't fix any of them without editing base files, so I've added them to the agreed base PR:
- `upstream.classify` checks ignores before maps, so the Unity map could never override base's `engine-layer:` ignores.
- `test_repo_content.py` hard-codes the role and rule counts and doesn't skip `Library/`.
- `.gitignore` is missing some files that Unity and IDEs generate.

## Plan: Stage 3: base engine-layer fixes, then the `game-studio-unity` fork and the `com.unknownow.studio-tools` 0.1.0 package

### 1. Goal and non-goals
**Goal.** First, land a small base PR. Then build `Unknownow/game-studio-unity`.

The base PR prepares `Unknownow/game-studio-base` `main` for an engine layer that only adds files:
- `engine-hooks` also scans `roles/`.
- Engine-layer upstream maps take precedence over `engine-layer:` ignores.
- The repo content tests tolerate engine-layer files and skip generated folders.
- The Unity and IDE generated files are gitignored.
- The Godot and Unreal leftovers in base content are removed.

Then build `Unknownow/game-studio-unity` as a real fork of base `main` that only adds files. It contains:
- a minimal Unity 6000.3 project
- `ENGINE.md`, which covers all 19 hook IDs
- `engine.toml`, pinned to 6.3 LTS
- 16 reference docs, 5 Unity roles and 9 Unity rules
- the `engines/unity.py` plugin
- the UPM package `com.unknownow.studio-tools` 0.1.0 with its 4 Editor features

The repo is tagged `v0.1.0` and marked as a GitHub template repository.

**Non-goals:**
- Any change to `D:/projects/pi-config`.
- pi workflow integration.
- Godot or Unreal content.
- A Unity build or Unity tests in CI.
- A UPM registry server.
- A real game.
- Third-party Python dependencies.
- Retagging base.
- Removing Godot/Unreal mentions in `studio-tests/**`, `tools/**` or `UPSTREAM.toml`.
- Fixing the staged skill-lint advice, which reads the working tree.

### 2. User decisions
- D1: The templates stand alone. They are not tied to pi or Claude Code. They work with pi, Codex, Cursor, Claude Code and humans. Every skill is a numbered checklist.
- D2: Unity comes first. Base is engine-agnostic. The Unity repo is a real fork of base that only adds files, in its own places.
- D3: The repos are `Unknownow/game-studio-base` and `Unknownow/game-studio-unity`. Both are public, and no repo name contains "claude". Local folders are under `D:/personal/`. Remotes are `git@github-personal:Unknownow/<repo>.git`, and Unity also has a `base` remote.
- D4: The runtime is Python 3.11+, standard library only, with `tomllib`. Config is in `project.toml`, a gitignored `project.local.toml`, and `UPSTREAM*.toml`.
- D5: Git hooks are tiny bash scripts that fail loudly when Python is missing. CI runs the same checks.
- D6: Only config, story sections, data JSON, evidence and frontmatter checks block, plus Unity's `engine-pin`. Style rules are advice.
- D7: The default rigor is `minimal`.
- D8: The Claude Code add-on ships in base. `claude-sync` generates `.claude/`.
- D9: Games update through `files.manifest`, `files.manifest.d/*.manifest` and the `update` command.
- D10: Upstream sync works per CCGS release tag, with one upstream map per repo. The flow is upstream → base → Unity (git merge) → games.
- D11: The UPM package:
  - name `com.unknownow.studio-tools`, display name "Game Studio Tools"
  - assemblies `Unknownow.StudioTools.Editor` and `Unknownow.StudioTools.Tests`
  - lives at `Packages/com.unknownow.studio-tools/`
  - games use the git URL `?path=/Packages/com.unknownow.studio-tools#vX.Y.Z`
  - one tag versions both the template and the package
- D12: The licence is MIT. Copyright is Cuong Bui and Donchitos. `NOTICE` is as in base.
- D13: The git identity under `D:/personal/` is `Cuong Bui <cuong.bpt82@gmail.com>`.
- D14: The first commit of `game-studio-unity` goes straight to `main`. Base changes use a branch and a pull request.
- D15: The 5 Unity agents become Unity roles. Only Claude Code runtime files, Godot/Unreal content and CCGS metadata are ignored.
- D16: Base was delivered in stages 1 and 2. This is the last stage.
- D17: Role frontmatter is `name`, `description`, `tier`, `can`, `memory` and `skills`.
- D19: Agent memory lives in `.agents/memory/<role>.md`.
- D20: `scene-files` is rewritten for Unity. Engine path patterns live in the Unity rules, which use `extends:`.
- D24: Frontmatter stays portable and is validated.
- D25: Base skills and roles call `ENGINE.md` hook sections. Unity never overrides a skill.
- D26: Unity 6.3 LTS is pinned in `engine.toml`, and the pin must match `VERSION.md`. `status` warns when the editor is on another line. The `setup-engine` upgrade mode covers moving to a newer LTS. The package minimum is `6000.3`.
- D27: Package 0.1.0 ships `EvidenceCapture`, `BatchTests`, `MissingReferenceAudit` and `ProjectSettingsCheck`.
- D28: Python 3.12 is used (`/c/Users/IEC-WW/AppData/Local/Programs/Python/Python312`).
- D29: `game-studio-unity` is marked as a template repository at its first release.
- D31 (new, approved): Before the fork, a small base PR makes the `engine-hooks` check scan `roles/` and removes the Godot/Unreal leftovers. Unity is cloned from base `main`, not from `v0.1.0`. Base is not retagged.

### 3. Facts the executor needs
**Shell and tools**
- Every bash call starts with `export PATH="/c/Users/IEC-WW/AppData/Local/Programs/Python/Python312:$PATH"`.
- Unity editor: `C:/Program Files/Unity/Hub/Editor/6000.3.25f1/Editor/Unity.exe`. The built-in `com.unity.inputsystem` is `1.20.0` (`…/Editor/Data/Resources/PackageManager/Editor/com.unity.inputsystem-1.20.0.tgz`).
- `gh` against Unknownow repos: use a temporary `GH_CONFIG_DIR` whose `hosts.yml` holds `gh auth token -u Unknownow`, and delete it afterwards. This is how PR #1 was merged; the guard refused `GH_TOKEN=$(…)` on merges. Never print the token. Never run `gh auth switch`.
- `git ls-remote git@github-personal:Unknownow/game-studio-unity.git` returns nothing: the repo exists and is empty.
- Base `main` = `063372c` (tag `v0.1.0`), clean.

**Base code anchors**
- Hook check: `tools/gamestudio/check.py:17-18` (`HOOK_RE`, `HOOK_HEADING_RE`); `check_engine_hooks` at `:221-235` scans `walk(root, ".agents/skills") + walk(root, "docs/studio")` only.
- The one role hook: `roles/qa-tester.md:91` (`qa-tester/test-pattern`).
- The 19 hook IDs in base:
  - `dev-story/engine-checks`, `dev-story/specialists`
  - `qa-tester/test-pattern`
  - `run-and-observe/capture`, in `docs/studio/run-and-observe.md`
  - `security-audit/patterns`
  - `setup-engine/commands`, `language`, `naming`, `scaffold`, `specialists`, `stack`, `testing`, `upgrade`, `version`
  - `smoke-check/run-tests`
  - `soak-test/memory-tool`
  - `test-helpers/engine-helpers`
  - `test-setup/ci-workflow`, `test-setup/engine-files`
- Upstream: `tools/gamestudio/upstream.py:8-21` `load_maps` reads every `UPSTREAM*.toml`. Only `UPSTREAM.toml` sets the tag unless none is set. `classify` at `:32-40` checks every ignore before any map.
- The 9 `engine-layer:` ignores in `UPSTREAM.toml`:
  - `.claude/skills/dev-story/references/engine-checks.md` (:890)
  - `docs/engine-reference/unity/**` (:1074)
  - the 5 `.claude/agents/unity-*.md` (:1118-1135)
  - `studio-tests/agents/engine/unity/**` (:1146)
  - `.claude/rules/scene-files.md` (:1150)
- Repo content test: `tools/gamestudio/tests/test_repo_content.py:14-17` (`ADDON_OK`; local `SKIP_DIRS = {".git", ".claude", "__pycache__"}`). `test_counts` (:26) hard-codes 34 roles and 13 rules. `count` (:20) walks recursively.
- `tools/gamestudio/common.py:6` `SKIP_DIRS` already holds `Library`, `Temp`, `Logs`, `UserSettings` and `obj`.
- `.gitignore:38-47` "Engine folders": `Library/ Temp/ Logs/ UserSettings/ obj/ Build/ Builds/ *.csproj *.sln`.
- `.gitattributes:23-27` has `unityyamlmerge` for `*.unity`, `*.prefab`, `*.asset` and `*.meta`.
- Rules: `check.py:206-218`. `extends` is a repo-relative path that must exist (for example `rules/ai-code.md`). Rules under `rules/unity/` are checked, because `src.files()` walks the whole repo.
- Manifests: `check.py:238-252` reads `files.manifest` plus `files.manifest.d/*.manifest`.

**Plugin interface** (`tools/gamestudio/engines/__init__.py`)
- `Ctx(root, cfg)` at :11 (`ctx.root`, `ctx.cfg.value(key)`, `ctx.engine_toml` = the `[engine]` table).
- `load_by_name` :22, `load_plugin` :31, `call(plugin, fn, ctx, *args)` :35, `code_root` :42, `data_globs` :55.
- Calls:
  - `check.py:283` `project_marker(ctx)`
  - `check.py:333` `check(ctx, report)`
  - `cli.py:96` `setup(ctx)` → list of lines
  - `status.py:80` `status(ctx)` → list of lines
  - `helpers/project_coherence.py:94` `installed_version(ctx)` → str or None
  - `helpers/test_run.py:135` `test_command(ctx)` → list
  - `helpers/test_scaffold.py:139` `scaffold_files(ctx)` → dict `{rel_path: text}`
- `Report.error(id, path, msg)` and `Report.warn(id, path, msg)` are at `common.py:83-86`.

**Config**
- `config.py:55` already allows `engine.editor_path`.
- Unset (empty) values fall through to `engine.toml [defaults]` (`config.py:238-251`). Base `project.toml` has `engine.name = ""`, so `engine.toml` supplies `unity`.

**Leftover hits** (regex `[Gg]odot|GDScript|[Uu]nreal|gdshader|Blueprint`) in base content:
- `.agents/skills/brainstorm/references/full-concept.md:121`
- `.agents/skills/code-review/SKILL.md:172`
- `.agents/skills/dev-story/CONTRACT.md:58`
- `.agents/skills/setup-engine/SKILL.md:31` and `references/2-guided-mode.md:40-108`, `5.5-project-toml.md:26`, `6-knowledge-gap.md:13-15`
- `.agents/skills/upstream-sync/SKILL.md:32`: legitimate, keep it
- `docs/AGENTS.md:33`
- `docs/studio/code-root-resolution.md:14-67`, `coding-standards.md:97`, `directory-structure.md:45-58`, `WORKFLOW-GUIDE.md:109,149,266,279-280,1380-1385,1544-1557`, `workflow-catalog.yaml:108`

**CCGS sources** (`D:/scratch/ccgs-v1.2.0`, data only; never run its scripts)
- Agents: `.claude/agents/unity-{specialist,addressables-specialist,dots-specialist,shader-specialist,ui-specialist}.md`.
- Reference docs: `docs/engine-reference/unity/` (16 files: `PLUGINS.md`, `VERSION.md`, `breaking-changes.md`, `current-best-practices.md`, `deprecated-apis.md`, `modules/*`, `plugins/*`).
- Role specs: `studio-tests/agents/engine/unity/*.md` (5).
- Rules with Unity patterns:

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

- The Unity text behind each hook: the CCGS skill of the same name (`.claude/skills/<skill>/**`, its Unity branches), `.claude/skills/dev-story/references/engine-checks.md`, and the stash `D:/scratch/port/stage3/` (`smoke-check-run-tests-engines.md`, `test-helpers-engine-sections.md`, `test-setup-ci-engines.md`, `test-setup-directories-engines.md`).

**Port tooling:** `D:/scratch/port/port.py` (`port_text` :18 does the text rewrites, `port_role` :147, `port_rule` :196). Scratch only, never committed.

### 4. Design
**4.1 Base changes (stage 1)**
- `check_engine_hooks`:
  - Also collects hook IDs from `walk(root, "roles", ".md")`.
  - An unreferenced heading warns `section \`hook: <id>\` is not referenced by any skill, role or studio doc`.
  - A missing heading stays an ERROR, naming the first file that uses the ID.
- `upstream.classify(maps, ignores, path)` has this precedence:
  1. ignores whose `reason` does not start with `engine-layer:` → `IGNORED (…)`
  2. maps → `-> …`
  3. `engine-layer:` ignores → `IGNORED (…)`
  4. `UNMAPPED`

  Base output is unchanged, because base has no maps for engine-layer paths.
- `test_repo_content.py`:
  - Use `common.SKIP_DIRS` plus `.claude`.
  - Base-only counting excludes engine-layer files. Engine names are the stems of `tools/gamestudio/engines/*.py` other than `__init__`. Excluded are `roles/<engine>-*.md`, `rules/<engine>/**`, `.agents/skills/<engine>-*` and `studio-tests/agents/engine/**`.
  - Base counts stay 75 skills / 34 roles / 13 rules.
  - The leftover test `test_no_other_engine_leftovers` scans `.md`, `.yaml` and `.toml` files under `.agents/`, `docs/`, `roles/`, `rules/`, `gates/`, `templates/`, plus `AGENTS.md` and `README.md`. It skips `engine-reference/` and the engine-layer exclusions. Its allowlist is exactly `.agents/skills/upstream-sync/SKILL.md`.
- `.gitignore` "Engine folders" adds `*.slnx *.user *.pidb *.booproj *.svd *.pdb *.mdb *.opendb *.VC.db .vs/ .idea/ MemoryCaptures/ Recordings/ ExportedObj/ .utmp/`.
- **Leftover policy:**
  - Engine choice prompts offer `Unity` / `Another engine (you write its ENGINE.md)` / `No preference — help me decide`.
  - The guided-mode comparison keeps only the Unity entry, plus one line: other engines are supported by writing `ENGINE.md` hooks yourself.
  - Per-engine path and test tables keep the neutral default row (`src/`, `tests/`) and a Unity row.
  - Knowledge-gap lines keep Unity only.
  - Examples use `unity` or `/setup-engine unity 6.3`.
  - The `godot-*`, `unreal-*` and `ue-*` roster and table rows are removed.
  - Unity role rows stay, with the suffix `(game-studio-unity)`.
  - `code-review:172` becomes `` (`.shader`, `.hlsl`, shader graph) ``.
  - `coding-standards:97` loses the Unreal bullet.
  - `dev-story/CONTRACT.md:58` drops `; tests/ on Godot`.
  - `workflow-catalog.yaml:108` uses `Unity 6.3 LTS` in the comment.

**4.2 Unity repo layout** (new files only):
- `ENGINE.md`, `engine.toml`
- `engine-reference/unity/**` (16)
- `roles/unity-*.md` (5)
- `rules/unity/*.md` (9)
- `tools/gamestudio/engines/unity.py`, `tools/gamestudio/tests/test_engine_unity.py`
- `files.manifest.d/unity.manifest`, `UPSTREAM.unity.toml`
- `studio-tests/agents/engine/unity/*.md` (5)
- `Assets/README.md` and the other `Assets/` files Unity creates
- `Packages/manifest.json`, `Packages/packages-lock.json`, `ProjectSettings/**`
- `Packages/com.unknownow.studio-tools/**`

No Unity-only skills. `catalog.toml` is not edited.

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
- A short intro: what it is, and that skills and roles call its sections.
- Then exactly one `## hook: <id>` heading per hook ID (19), each followed by numbered steps for Unity 6.3 LTS.
- The commands are exact: `python tools/studio.py test-run`, the `Unity.exe` batch lines, and the package menu and batch methods from 4.5.
- No other `## hook:` headings.
- `run-and-observe/capture` names `EvidenceCapture.CaptureBatch`.
- `smoke-check/run-tests` names `python tools/studio.py test-run`.
- `setup-engine/upgrade` says, as numbered steps:
  1. install the new LTS
  2. update `engine.toml` `lts` and `editor_line`
  3. update the `VERSION.md` Engine Version row
  4. update `package.json` `unity`
  5. open the project and commit the upgraded `ProjectSettings/`
  6. run `check` and the EditMode suite
- `qa-tester/test-pattern` describes NUnit `[Test]` in EditMode and PlayMode asmdefs under `Assets/Tests/`.

Roles (`roles/unity-*.md`):
- base role frontmatter (D17), ported with `port_role`
- `unity-specialist` has `can: [read, write, shell, delegate]`; the others have `can: [read, write, shell]`
- `tier: standard`
- the body line `**Allowed actions:** …`

Rules (`rules/unity/<name>.md`):
- frontmatter `paths:` = the Unity patterns from §3, and `extends: rules/<name>.md`
- the body holds only the Unity additions: the Unity-specific lines from the CCGS rule body that base removed
- `scene-files.md` has the scene-files paths, no `extends`, and covers the S10 points

`files.manifest.d/unity.manifest`, one per line: `ENGINE.md`, `engine.toml`, `engine-reference/**`, `roles/unity-*.md`, `rules/unity/**`, `tools/gamestudio/engines/unity.py`, `studio-tests/agents/engine/unity/**`. It contains no game-owned paths, so the `manifest-game-owned` check stays clean.

`UPSTREAM.unity.toml`:
- a header comment
- `[upstream] tag = "v1.2.0"`, so `upstream-tag` sees no disagreement
- `[[map]]` entries for all 9 engine-layer paths:

  | `from` | `to` |
  |---|---|
  | `engine-checks.md` | `ENGINE.md` |
  | `docs/engine-reference/unity/**` | `engine-reference/unity/` |
  | each agent | `roles/<name>.md` |
  | `studio-tests/agents/engine/unity/**` | `studio-tests/agents/engine/unity/` |
  | `scene-files.md` | `rules/unity/scene-files.md` |

**4.4 Unity plugin (`engines/unity.py`):**
- Helpers:
  - `_project_version(ctx)` reads `m_EditorVersion:` from `ProjectSettings/ProjectVersion.txt`, or returns None.
  - `_editor_path(ctx)` returns `engine.editor_path` if it is set, otherwise the Hub path for that version: `C:/Program Files/Unity/Hub/Editor/<v>/Editor/Unity.exe` on Windows, `/Applications/Unity/Hub/Editor/<v>/Unity.app/Contents/MacOS/Unity` on macOS, `~/Unity/Hub/Editor/<v>/Editor/Unity` on Linux.
- `status(ctx)` → `["editor: <v> (pinned line <editor_line>, Unity <lts> LTS)"]`. If `<v>` does not start with `editor_line + "."`, it adds `WARN engine-pin: editor <v> is not on the pinned line <editor_line> (Unity <lts> LTS); see the setup-engine upgrade mode`. No `ProjectVersion.txt` gives `editor: unknown`.
- `check(ctx, report)`:
  - ERROR `engine-pin` on `engine-reference/unity/VERSION.md` when it is missing, or when its `| **Engine Version** |` row lacks `Unity <lts> LTS`.
  - ERROR when `engine.toml` lacks `lts` or `editor_line`.
  - WARN `engine-pin` on `ProjectSettings/ProjectVersion.txt` for an editor mismatch.
- `installed_version(ctx)` → `m_EditorVersion` if `_editor_path` exists, otherwise None.
- `test_command(ctx)` → `[<editor>, "-batchmode", "-projectPath", <root>, "-executeMethod", "Unknownow.StudioTools.Editor.BatchTests.Run", "-testPlatform", "All", "-logFile", "production/qa/test-results/unity.log"]`. If the editor file does not exist, it writes `studio: Unity editor not found: <path>; set engine.editor_path in project.local.toml` to stderr and calls `sys.exit(2)`.
- `scaffold_files(ctx)`:
  - Returns `{"Assets/Tests/EditMode/<Name>.Tests.EditMode.asmdef": …, "Assets/Tests/EditMode/SampleEditModeTest.cs": …, "Assets/Tests/PlayMode/<Name>.Tests.PlayMode.asmdef": …, "Assets/Tests/PlayMode/SamplePlayModeTest.cs": …}`.
  - `<Name>` is `project.name` with non-alphanumerics removed, or `Game` if that is empty.
  - The asmdefs reference `UnityEngine.TestRunner` and `UnityEditor.TestRunner`, use `overrideReferences: true` with `nunit.framework.dll`, and have `defineConstraints: ["UNITY_INCLUDE_TESTS"]`. EditMode has `includePlatforms: ["Editor"]`.
- `setup(ctx)`:
  - `origin` = `git remote get-url origin`. If it matches `Unknownow/game-studio-unity(\.git)?$`, return `[]`.
  - Otherwise, if `Packages/com.unknownow.studio-tools/package.json` exists, read its `version` V and delete the folder.
  - In `Packages/manifest.json`, set `dependencies["com.unknownow.studio-tools"] = "https://github.com/Unknownow/game-studio-unity.git?path=/Packages/com.unknownow.studio-tools#vV"`, remove the name from `testables`, and drop `testables` if it becomes empty. Write back with 2-space indent, key order kept and a trailing newline.
  - Return the lines `removed Packages/com.unknownow.studio-tools (embedded copy)` and `Packages/manifest.json: com.unknownow.studio-tools -> <url>`.
  - No origin counts as "otherwise". No embedded folder → `[]`.
- `code_root`, `data_globs` and `project_marker` come from `ctx.engine_toml`.

**4.5 Package `com.unknownow.studio-tools` 0.1.0:**
- `package.json`: `name`, `version "0.1.0"`, `displayName "Game Studio Tools"`, `unity "6000.3"`, `description`, `author {"name":"Cuong Bui"}`, `license "MIT"`, `dependencies {"com.unity.test-framework": <the version in the 6000.3.25f1 default manifest>}`.
- Also `LICENSE.md` (MIT, Cuong Bui), `README.md` (install URL, menus, batch lines) and `CHANGELOG.md` (`## [0.1.0]`).
- `Editor/Unknownow.StudioTools.Editor.asmdef` and `Tests/Editor/Unknownow.StudioTools.Tests.asmdef`. Both are Editor-only. Tests reference the Editor assembly and the test runner, with `UNITY_INCLUDE_TESTS`.
- Logic lives in pure static methods. Reports go under `<project>/production/qa/`, where project = the parent of `Application.dataPath`.
- Batch methods parse `Environment.GetCommandLineArgs()` and end with `EditorApplication.Exit(code)`: 0 pass, 1 findings, 2 bad argument or setup error.
- Menu items are under `Tools/Game Studio/`: `Capture Evidence`, `Run All Tests`, `Missing Reference Audit`, `Project Settings Check`. Each logs a summary and shows a dialog.

**`EvidenceCapture`**
- `CaptureBatch -story <slug> -scene <path> [-width <int>] [-height <int>]`; the size defaults to 1920×1080.
- The slug must match `^[a-z0-9][a-z0-9._-]*$`.
- Output: `production/qa/evidence/<slug>/<slug>-<yyyyMMdd-HHmmss>.png`.
- In Play Mode it uses `ScreenCapture`; otherwise it renders `Camera.main` (or the first camera) to a RenderTexture.
- No camera → 2. It needs a GPU, so it is never run with `-nographics`.

**`BatchTests`**
- `Run -testPlatform EditMode|PlayMode|All` through `TestRunnerApi`.
- Writes `production/qa/test-results/editmode.xml` and/or `playmode.xml`.
- Exits 0 when all pass, 1 on any failure, 2 on a bad or missing value.
- Started without `-quit`; it exits from the run-finished callback.

**`MissingReferenceAudit`**
- `RunBatch` scans every `*.unity` and `*.prefab` under `Assets/` for missing scripts and dangling object references (`objectReferenceValue == null && objectReferenceInstanceIDValue != 0`).
- Writes `production/qa/audit/missing-references.json` = `{"generated", "missingScripts":[{"asset","object"}], "missingReferences":[{"asset","object","component","property"}]}`.
- Exit 1 if either list is non-empty.
- The menu version saves and restores the open scenes.

**`ProjectSettingsCheck`**
- Check IDs:
  - `force-text`: `EditorSettings.serializationMode == ForceText`
  - `visible-meta`: `VersionControlSettings.mode == "Visible Meta Files"`
  - `input-system`: `activeInputHandler` is 1 or 2, read from `ProjectSettings/ProjectSettings.asset`
- Writes `production/qa/audit/project-settings.json` = `{"generated","checks":[{"id","pass","actual"}]}`.
- Exit 1 on any failure.

**4.6 Template project**
- Created in batchmode in `D:/scratch/unity-skel`. `Assets/`, `Packages/` and `ProjectSettings/` are copied in.
- `manifest.json` adds `"com.unity.inputsystem": "1.20.0"` and `"testables": ["com.unknownow.studio-tools"]`.
- `activeInputHandler: 1`, Force Text, Visible Meta.
- `Assets/README.md` explains the layout.

**4.7 Failure handling**
- A Unity licence or activation error in any batch run → stop and report it to the user.
- If a Unity file needs a base edit → stop. Do it as a base PR, never in the fork.
- If generated files remain untracked after 4.1's `.gitignore` → do not commit them; stop and report.

**4.8 Scale**
- The Python fast suite (~211+ tests, ~20 s) must stay under 2 min.
- `check --all` must stay under 5 s for 1,000 stories. `Library/` is skipped by `common.SKIP_DIRS`.
- The EditMode run takes about 3–6 min, and each batch check about 1–2 min.
- The audit scans every scene and prefab in one process. It is fine up to a few thousand assets; beyond that a game should scope it, which is not part of 0.1.0.

**4.9 Alternatives rejected**
- Accepting 1 `engine-hooks` warning in Unity: the user chose the base fix.
- Editing base files in the fork: this breaks D2.
- Cloning from base `v0.1.0`: it lacks the fixes.
- Adding the Unity roles to `catalog.toml`: that is a base file.
- A `scene-files` rule in base: it is engine-specific (D20).

### 5. Steps

#### Rules for every step
- Read the CCGS source before porting.
- After porting, grep the new files for `\.claude`, `CLAUDE_`, `` !` ``, `Task(Create|Update|List|Get|Output|Stop)`, `subagent`, `spawn`, `Agent tool`, `[Gg]odot`, `GDScript`, `[Uu]nreal`, `Blueprint`, `\.sh\b`, `AskUserQuestion` and "Claude", and fix every hit by hand.
- Text rewrites:
  - agent spawn → `Act as <role>: read roles/<role>.md, then …`
  - `.claude/docs/` → `docs/studio/`
  - "Claude's cutoff" → "your model's knowledge cutoff"
- Check `git status` and the branch before changing anything.
- Pushes and merges are standalone commands, run after a judge pass.

### Stage 1: Base engine-layer fixes
**S1.** In `D:/personal/game-studio-base`, confirm `main` = `origin/main` = `063372c` and a clean tree. Create the branch `fix/engine-layer-support`.

**S2.** `tools/gamestudio/check.py:221` `check_engine_hooks`: add `roles/*.md` to the scanned files and change the warning text, per 4.1. Model it on the existing loop at :227-230.

**S3.** `tools/gamestudio/upstream.py:32` `classify`: apply the 4.1 precedence. Model it on the existing two loops.

**S4.** `tools/gamestudio/tests/test_repo_content.py`:
- Import `SKIP_DIRS` from `gamestudio.common` and add `.claude`.
- Add the engine-layer exclusion helper and use it in `test_counts`.
- Add `test_no_other_engine_leftovers` per 4.1.

**S5.** `.gitignore` "Engine folders" (:38): append the 4.1 patterns.

**S6.** Remove the leftovers in the §3 list by the 4.1 policy. Afterwards, `test_no_other_engine_leftovers` passes and the meaning of each section is kept.

**S7.** Run the fast suite, `check`, and `upstream-diff --clone D:/scratch/ccgs-v1.2.0 --to v1.2.0 --coverage`. Then call `judge` (`full=true`, `base=063372c`).

**S8.** Deliver: merge the base engine-layer fixes. PR `fix/engine-layer-support` → `main` of `Unknownow/game-studio-base`, with green CI, using the Unknownow credentials.

### Stage 2: Unity fork and package
**S9.** Clone base `main` (after S8) into `D:/personal/game-studio-unity`:
- Rename `origin` to `base`, and add `origin` = `git@github-personal:Unknownow/game-studio-unity.git`.
- Confirm `git config user.name` = `Cuong Bui` and `user.email` = `cuong.bpt82@gmail.com`.
- Run `python tools/studio.py setup` so the hooks are active.

**S10.** Unity project per 4.6:
- Run `"C:/Program Files/Unity/Hub/Editor/6000.3.25f1/Editor/Unity.exe" -batchmode -quit -createProject D:/scratch/unity-skel -logFile -` (timeout 900 s).
- Copy its `Assets/`, `Packages/` and `ProjectSettings/` into the repo.
- Apply 4.6. Note the default `com.unity.test-framework` version for S13.
- On a licence error, stop and report.

**S11.** Unity content, per 4.2 and 4.3:
- `engine.toml`.
- `engine-reference/unity/` (16 files) ported from CCGS; `VERSION.md`'s Engine Version row says `Unity 6.3 LTS`.
- The 5 `roles/unity-*.md`.
- The 9 `rules/unity/*.md`. `scene-files.md` covers:
  - YAML and merge-sensitive files
  - never hand-edit `fileID` or `guid`
  - commit `.meta` files with their assets
  - edit in the Editor
  - Force Text and Visible Meta are required
  - UnityYAMLMerge (base `.gitattributes:23-27`)
- `files.manifest.d/unity.manifest`.
- `UPSTREAM.unity.toml`.
- The 5 role specs in `studio-tests/agents/engine/unity/`.

**S12.** `ENGINE.md` per 4.3: one section per hook ID in §3, filled from the CCGS Unity branches and `D:/scratch/port/stage3/`. `python tools/studio.py check` must show no `engine-hooks` findings.

**S13.** `tools/gamestudio/engines/unity.py` per 4.4, and `tools/gamestudio/tests/test_engine_unity.py` (§6). Model the plugin shape on the call sites in §3, and the tests on `RepoCase` (`tests/_util.py:30`).

**S14.** `Packages/com.unknownow.studio-tools/` per 4.5, with the 4 EditMode test classes (§6).

**S15.** Run the S15 checks in §6, then call `judge` (`full=true`, `base=` the base `main` sha from S9).

**S16.** Deliver: commit per §9 and make the first push straight to `main` of `game-studio-unity` (D14), after a judge pass. CI must be green.

**S17.** Deliver: tag `v0.1.0` on `game-studio-unity` `main` → call `deliver {tag: {name: "v0.1.0", repo: "D:/personal/game-studio-unity"}, step: "S17"}`.

**S18.** Mark `Unknownow/game-studio-unity` as a template:
- Send a GitHub API PATCH `repos/Unknownow/game-studio-unity` with `is_template=true`, using the Unknownow credentials.
- Read it back with `gh api repos/Unknownow/game-studio-unity --jq .is_template` and confirm `true` (D29).

**S19.** Verify (you): check S19 below.
1. Create a scratch game from the template.
2. Run `python tools/studio.py setup`.
3. Open it in Unity 6000.3.25f1.
4. Try the four `Tools/Game Studio/*` menu items.

Look for:
- the package resolving from the git URL `#v0.1.0`, with no embedded copy left
- an evidence PNG under `production/qa/evidence/<slug>/`
- test XML files
- both audit JSON files reporting pass

**S20.** Verify (you): check S20 below.
1. Open pi in `D:/personal/game-studio-unity` and accept project trust.
2. Run `/skill:help`, then ask "what is the first command to run?".

Look for: the skills load, and the answer is `python tools/studio.py status`.

### 6. Tests
**Base (stage 1)**

| File | Test | Input → expected |
|---|---|---|
| `test_check.py` | `test_engine_hooks_role_reference` | `ENGINE.md` with `## hook: qa-tester/test-pattern` plus a role using that ID, and no skill using it → exit 0, no `engine-hooks` warning. A role using `x/y` with no heading → exit 1, `engine-hooks` ERROR on `roles/<file>` |
| `test_upstream.py` | `test_engine_layer_ignore_yields_to_map` | `UPSTREAM.toml` ignores `a/**` with `engine-layer: …`, and `UPSTREAM.unity.toml` maps `a/**` → `b/`. Then `a/x.md` → `-> b/x.md`; an `other-engine:` ignore on `c/**` plus a map for `c/**` → `IGNORED` |
| `test_repo_content.py` | `test_no_other_engine_leftovers` | the real repo → no hits outside the allowlist |
| `test_repo_content.py` | `test_counts` | unchanged numbers (75/34/28/13/71/28), now with engine-layer exclusion |

**Unity, Python (`test_engine_unity.py`)**, temporary repos with `engine.toml` from 4.3:

| Test | Input → expected |
|---|---|
| `test_status_warns_off_line_editor` | `ProjectVersion.txt` `m_EditorVersion: 6000.0.64f1` → `status` output contains `engine-pin: editor 6000.0.64f1 is not on the pinned line 6000.3` |
| `test_check_version_md_mismatch_errors` | `VERSION.md` row says `Unity 6.4 LTS` → `check` exits 1 with an `engine-pin` ERROR. With `Unity 6.3 LTS` and editor `6000.3.25f1` → no `engine-pin` finding |
| `test_setup_converts_embedded_package` | origin `https://github.com/someone/game.git`, an embedded `package.json` version `0.1.0`, `testables` with the package → the folder is removed, the dependency is `…#v0.1.0`, `testables` is gone |
| `test_setup_template_origin_noop` | origin `git@github-personal:Unknownow/game-studio-unity.git` → no change |
| `test_test_run_missing_editor` | `engine.editor_path` pointing at a nonexistent file → `test-run` exits 2, stderr `studio: Unity editor not found:` |
| `test_scaffold_files` | `test-scaffold --engine unity` → creates the 4 `Assets/Tests/...` files |

**Unity, EditMode** (package `Tests/Editor/`):

| Class | What it checks |
|---|---|
| `EvidenceCaptureTests` | valid and invalid slugs; the path format `production/qa/evidence/<slug>/<slug>-yyyyMMdd-HHmmss.png` |
| `BatchTestsTests` | argument parsing: `EditMode`, `PlayMode`, `All` are OK; a missing or bad value → 2 |
| `MissingReferenceAuditTests` | temp prefabs under `Assets/_StudioToolsTestTemp/`: a missing script and a dangling reference are reported; a clean prefab gives empty lists. Teardown deletes the folder |
| `ProjectSettingsCheckTests` | `activeInputHandler` 0 fails, 1 and 2 pass; the JSON has `generated` and `checks[{id,pass,actual}]` |

**Commands**
- Fast suite in each repo: `python -m unittest discover -s tools/gamestudio/tests -t tools -q` → `OK`, under 2 min.
- `python tools/studio.py check` → `check: 0 errors`, with no `engine-hooks` warnings.
- `python tools/studio.py upstream-diff --clone D:/scratch/ccgs-v1.2.0 --to v1.2.0 --coverage` → exit 0 in both repos. In Unity, the 9 engine-layer paths show as mapped.
- Unity only:
  - `python tools/studio.py claude-sync` → `75 skills, 39 agents`; then delete `.claude/`.
  - `git diff --diff-filter=MDR base/main..main` is empty (after the commits).
- **Slow: Unity EditMode, about 3–6 min.**
  - Fast command while fixing: add `-testFilter Unknownow.StudioTools.Tests.<Class>`.
  - Full command, run once before `judge`: `"C:/Program Files/Unity/Hub/Editor/6000.3.25f1/Editor/Unity.exe" -batchmode -nographics -projectPath D:/personal/game-studio-unity -runTests -testPlatform EditMode -testResults D:/scratch/unity-results/editmode.xml -logFile D:/scratch/unity-results/editmode.log` → exit 0, `result="Passed"`.
- **Slow: batch checks, about 1–2 min each.** The same editor with `-batchmode -nographics -quit -projectPath D:/personal/game-studio-unity -executeMethod Unknownow.StudioTools.Editor.ProjectSettingsCheck.RunBatch -logFile -`, then the same with `MissingReferenceAudit.RunBatch`. Each exits 0.

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
- A Unity licence or activation failure blocks S10 and S15. Stop and report.
- `EvidenceCapture` needs a GPU and is not run in batch tests; its logic is covered by the path and slug tests.
- `com.unity.test-framework` and the input system versions must match the 6000.3.25f1 defaults.

**Rollback**
- Base: revert the merge commit of the S8 PR.
- Unity: the repo is new. Delete the tag and force-reset `main` only with the user's consent.

**Do not touch**
- Base files from the Unity repo.
- `catalog.toml`.
- Base tag `v0.1.0`.
- `~/.ssh`, `~/.gitconfig*`.
- The active `gh` account.
- `D:/projects/**`.

Never execute CCGS scripts. Never commit `D:/scratch/**`, `.claude/`, `Library/` or `project.local.toml`.

### 9. Commits
**`game-studio-base`, branch `fix/engine-layer-support`:**
1. `fix(studio): engine-hooks check reads hook ids in roles`: `tools/gamestudio/check.py`, `tools/gamestudio/tests/test_check.py`
2. `fix(studio): engine-layer upstream maps take precedence over engine-layer ignores`: `tools/gamestudio/upstream.py`, `tools/gamestudio/tests/test_upstream.py`
3. `test: repo content tests tolerate an engine layer and catch other-engine leftovers`: `tools/gamestudio/tests/test_repo_content.py`
4. `chore: ignore more Unity and IDE generated files`: `.gitignore`
5. `docs: remove Godot and Unreal leftovers from skills and studio docs`: the `.agents/skills/**` and `docs/**` files from §3

**`game-studio-unity`, straight to `main` on top of base history:**
6. `feat(unity): minimal Unity 6.3 LTS project`: `Assets/`, `Packages/manifest.json`, `Packages/packages-lock.json`, `ProjectSettings/`
7. `feat(unity): engine pin, ENGINE.md hooks, reference docs, roles and rules`: `engine.toml`, `ENGINE.md`, `engine-reference/unity/**`, `roles/unity-*.md`, `rules/unity/**`, `files.manifest.d/unity.manifest`, `UPSTREAM.unity.toml`, `studio-tests/agents/engine/unity/**`
8. `feat(studio): Unity engine plugin`: `tools/gamestudio/engines/unity.py`, `tools/gamestudio/tests/test_engine_unity.py`
9. `feat(package): com.unknownow.studio-tools 0.1.0`: `Packages/com.unknownow.studio-tools/**`

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 In `D:/personal/game-studio-base`, confirm `main` = `origin/main` = `063372c` and a clean tree. Create the branch `fix/e
- [ ] S2 `tools/gamestudio/check.py:221` `check_engine_hooks`: add `roles/*.md` to the scanned files and change the warning text,
- [ ] S3 `tools/gamestudio/upstream.py:32` `classify`: apply the 4.1 precedence. Model it on the existing two loops.
- [ ] S4 `tools/gamestudio/tests/test_repo_content.py`:
- [ ] S5 `.gitignore` "Engine folders" (:38): append the 4.1 patterns.
- [ ] S6 Remove the leftovers in the §3 list by the 4.1 policy. Afterwards, `test_no_other_engine_leftovers` passes and the meani
- [ ] S7 Run the fast suite, `check`, and `upstream-diff --clone D:/scratch/ccgs-v1.2.0 --to v1.2.0 --coverage`. Then call `judge
- [ ] S8 Deliver: merge the base engine-layer fixes. PR `fix/engine-layer-support` → `main` of `Unknownow/game-studio-base`, with
- [ ] S9 Clone base `main` (after S8) into `D:/personal/game-studio-unity`:
- [ ] S10 Unity project per 4.6:
- [ ] S11 Unity content, per 4.2 and 4.3:
- [ ] S12 `ENGINE.md` per 4.3: one section per hook ID in §3, filled from the CCGS Unity branches and `D:/scratch/port/stage3/`. `
- [ ] S13 `tools/gamestudio/engines/unity.py` per 4.4, and `tools/gamestudio/tests/test_engine_unity.py` (§6). Model the plugin sh
- [ ] S14 `Packages/com.unknownow.studio-tools/` per 4.5, with the 4 EditMode test classes (§6).
- [ ] S15 Run the S15 checks in §6, then call `judge` (`full=true`, `base=` the base `main` sha from S9).
- [ ] S16 Deliver: commit per §9 and make the first push straight to `main` of `game-studio-unity` (D14), after a judge pass. CI m
- [ ] S17 Deliver: tag `v0.1.0` on `game-studio-unity` `main` → call `deliver {tag: {name: "v0.1.0", repo: "D:/personal/game-studi
- [ ] S18 Mark `Unknownow/game-studio-unity` as a template:
- [ ] S19 Verify (you): check S19 below.
- [ ] S20 Verify (you): check S20 below.
