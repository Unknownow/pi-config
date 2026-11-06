<!-- pi-workflow plan v1 flow=20261106-1412-game-configs-fix-round-configs-0-2-0-the-a9d0 -->
## Plan: Game configs fix round (configs 0.2.0, then the game-template and knowledge parts of stage 3)

Stages:
1. **configs 0.2.0:** the package fixes in unity-packages, merged and published.
2. **Game and playbook:** game-template PR #238 and knowledge PR #237 updated to configs 0.2.0, fixed and merged.

### 1. Goal and non-goals

**Goal:** finish stage 3 of the server-time, remote config and game configs plan. That means fixing every judge finding on game-template #238, the plan flaw (the linker ignores `configs.link.xml`) and the leftover minors in `com.iecgames.configs`, then delivering:
- `com.iecgames.configs` 0.2.0, merged and published;
- game-template #238 and knowledge #237, merged.

**Non-goals:**
- Stage 4 (A/B integration).
- The stage 2 core minors: `Save` returning bool, the Fetch-and-apply counter, the `ActivateAsync` fault and `Origin` for an empty file provider.
- Publishing `com.iecgames.build` 0.4.2.
- The two clipboard `Game.Tests` failures.
- Any write to maze-flow, shiny-loop or pi-config.

### 2. User decisions

- **D1.** Fix the plan flaw, then do the rest of stage 3, and fix anything else found ("continue, fix the plan then finish the rest, fix anything you find too").
- **D2.** Fixes ship as `com.iecgames.configs` **0.2.0**, and game-template pins 0.2.0.
- **D3.** IL2CPP stripping is handled inside the package by an `IUnityLinkerProcessor`, modelled on `FacebookLinkXml`. The game-template `configs.link.xml` file and its generator (`generateLinkXml`, `assemblyOf`) are removed.
- **D4.** New path rule:
  - Once the build file passes its own checks, it is filled in from the class: every field with its default, and every existing row with all its fields.
  - Each layer is filtered against the document built so far, filled in again after each kept layer.
  - Unknown fields are refused, a row or dictionary key must exist below the layer, and `null` deletes a row only.
  - The tools (window, `remote-diff`, `remote-config check`) use the same filled-in document.
  - Stage 4 A/B layers use the same rule.
- **D5.** Also fix the leftover package minors:
  - ISO date strings are kept as text.
  - A fractional number in an integral field is a `type` rejection, while `7.0` is accepted.
  - A row deleted by a lower layer is a new row for the layers above.
  - Each rejected remote layer gets one `Reject` call.
- **D6.** Merges use a merge commit after a judge PASS. The merge is run as its own `git_task` command (`gh pr merge N -R iecgames/<repo> --merge --delete-branch`).

### 3. Facts the executor needs

All paths are under `D:/projects/wt/progression-report/`.

**unity-packages:**
- `main` is checked out in another worktree. The local branch `flow/game-configs` is merged and gone upstream; start a new branch `flow/configs-0.2` from `origin/main`.
- Package `com.iecgames.configs` is at 0.1.0 and published.
- **Model for the linker processor:** `com.iecgames.thirdparty.facebook/Editor/FacebookLinkXml.cs:14-30` (`IUnityLinkerProcessor`, `callbackOrder => 0`, `GenerateAdditionalLinkXmlFile(BuildReport, UnityLinkerBuildPipelineData)` returns a path), with its tests in `.../Tests/Editor/FacebookLinkXmlTests.cs`.
- **`Runtime/ConfigResolver.cs`:**
  - `Resolve` is at `:45`.
  - It parses the build with `JObject.Parse` at `:51`.
  - It filters each layer against the raw `build` at about `:96` (`PatchFilter.Filter(build, layer.Patch, info.Type, refused)`).
  - The `TryBuild` of the build is at about `:105`.
  - The bottom-up loop is at about `:112-127`.
  - `CheckDocument` is at `:133` and parses at `:149`.
  - The serializer settings at about `:30-43` already set `DateParseHandling.None`, `ObjectCreationHandling.Replace` and `StringEnumConverter`.
- **`Runtime/PatchFilter.cs`:** `FilterObject` (`:57`) refuses a field missing from `build`. It has a dictionary branch at about `:93` and `FilterTable` at about `:122`. `RowTypeOf` is at `:37` and `IsNested` at `:26`.
- **`Runtime/GameConfigService.cs`:**
  - The reject loop is at `:162-175` and calls `_remote.Reject(RemoteNames.ForConfig(info.Name), rejected.Id, rejected.Reason)` for every remote rejection.
  - `TryParse` uses `JObject.Parse` at `:206`.
- **`Editor/ConfigEditing.cs`:** `Load` is at `:20` and `ToJson(info, config, likeJson)` at `:33` (it writes every public field). It calls `JObject.Parse` at `:47`; `Diff` is at `:59` with parses at `:61-62`.
- **`Editor/ConfigManifest.cs`:** row fields have the path `x.*.f`. `default` is missing when the type has no parameterless constructor (`:48`, `:105-113`).
- **Tests:** `Tests/Editor/ConfigResolveTests.cs:179` hides duplicate rejects with `.Distinct()`. The test types are in `Tests/Editor/ConfigTestTypes.cs` (`DailyRewardConfig` with table `days`, the `steps` list and the `bonuses` dictionary, plus `NestedConfig`, `FakeRemote.Rejects` and `ConfigTestData`).
- **Helpers:** metas come from `scripts/lib/package-dev.mjs` (`writeMetas`).

**game-template, branch `flow/game-configs` (PR #238, pushed at `5aacc65`):**
- **`scripts/lib/configs.mjs`:**
  - `LINK_XML_PATH` is at `:13`, `assemblyOf`/`findClassFile` at `:241-275` and `generateLinkXml` at `:277-281`.
  - The generated-files list entry is at `:313`.
  - `checkPatch(config, build, patch, label)` is at `:185`; `walkField` errors when a key is not in the build file (`:209`).
  - `checkScalar` is at about `:132`.
- **`scripts/configs.mjs`:**
  - It imports `generateLinkXml`/`LINK_XML_PATH` at `:55-56`.
  - `generate` is at `:215-216`.
  - `done()`/`problem()` are at `:109`/`:115`.
  - The `remote-diff` diff is at `:341-343`, and the `set-patch` call through `remoteMain(..., log)` at `:349-350`.
- **`scripts/lib/remote-config.mjs`:** `RESERVED_NAMES` is used for settings at `:366`; the config-name loop starts at about `:373`.
- **`scripts/configs.test.mjs:88-97`** asserts the link.xml.
- **Generated file:** `unity/Assets/_Project/Config/configs.link.xml` and its `.meta`.
- **`unity/Assets/_Project/Scripts/Editor/ConfigsWindow.cs`:**
  - `_buildJson` is set at `:99` and `:373`.
  - `Revalidate` is at `:112-116`.
  - The patch button disable condition is at `:284`.
  - `LoadRemote` is at `:299-315` (`_remote = null` at `:310`).
  - `SetPreview` is at `:319-337`.
  - `MakePatch` is at `:340-354`, and uses the branch at `:354`.
- **`ConfigsWindowModel.cs`** parses at `:78`, `:90`, `:96-97` and `:121`.
- **Docs:** `AGENTS.md:156` mentions `configs.link.xml`. README has the configs rows.
- **Package pins:** `unity/Packages/manifest.json` and `packages-lock.json` pin `com.iecgames.configs` 0.1.0. The lock is hand-edited because there is no Editor to run `package_resolve`.

**knowledge, branch `flow/game-configs` (PR #237):** `entries/eng/playbook/game-configs.md` mentions `configs.link.xml` at step 3 (`:31`) and in Pitfalls (`:51`).

**Registry:** publish with `publish_packages`.

### 4. Design

**Linker processor.**
- `ConfigsLinkXml.Build(IEnumerable<ConfigInfo>)` is a pure function returning the text.
- The processor writes it to `<project>/Library/Iec/configs.link.xml` (creating the folder), with the project path from `Path.GetDirectoryName(Application.dataPath)`, and returns that path.
- It returns null when there are no configs.

The type walk:
- It starts from each config class and follows its public instance fields, recursively, visiting each type once.
- It collects nested classes (`PatchFilter.IsNested`), table row types (`RowTypeOf`), enums, and the element types of arrays, `List<T>` and `Dictionary<K,V>` values.
- It skips `System*` and `UnityEngine*` types, primitives, strings and the generic definitions themselves.

Output format: LF line endings, assemblies and types sorted ordinally.

```xml
<linker>
  <assembly fullname="Game.Runtime">
    <type fullname="Game.DailyRewardConfig" preserve="all" />
    <type fullname="Game.DailyRewardConfig/DayRow" preserve="all" />
  </assembly>
</linker>
```

**Filled-in layer base.**
- After the build passes `TryBuild`, set `current` to `JObject.FromObject(value, serializer)` (the resolver's serializer) and remove `schema`.
- For each active layer, in order:
  1. `filtered = PatchFilter.Filter(current, layer.Patch, info.Type, refused)`. Refused paths become `path` rejections.
  2. If `filtered` is empty, skip the layer.
  3. `next = MergePatch.Apply(current.DeepClone(), filtered)`.
  4. If `TryBuild(next)` passes, keep the layer and set `current = FromObject(value)`.
  5. Otherwise reject the layer with its reason.

Filtering therefore moves from the up-front pass into the loop. Schema skips and `parse` stay in the up-front pass. Because `PatchFilter` already refuses fields missing from its base, no `PatchFilter` change is needed beyond its summary text.

**Whole-number check.** A walk before deserialization, inside `TryBuild`:
- Integral types are `int`, `long`, `short`, `byte`, `sbyte`, `uint`, `ulong` and `ushort`.
- A `JTokenType.Float` whose value has a fraction fails with reason `type` and the dotted path (row ids included) as detail.
- It follows nested classes, table rows, list and array elements, and dictionary values.

**`ConfigJson`.**
- It is a public static class with `Parse(string) → JToken` and `ParseObject(string) → JObject`.
- It uses a `JsonTextReader` with `DateParseHandling.None` and `FloatParseHandling.Double`.
- `ParseObject` throws `JsonReaderException` when the text is not an object.

**Tool fill-in.** `normalizeDoc(config, doc)` in node mirrors the runtime fill-in using the manifest:
- It works on a deep copy.
- For every field path, it sets the manifest default where the key is missing, creating intermediate objects.
- A `*` segment fills every row the document already has.
- A table field with no rows gets `{}` when missing.
- A field without `default` is skipped.

**Failure handling.**
- The processor never throws into the build. On a write error it logs `IecLog.Error` and returns null.
- `Normalize` returns the input unchanged on invalid JSON.

**Scale.** One extra `FromObject` per kept layer, at most about 5 layers × a few KB per config: well under 1 ms each. This stops being cheap above roughly 1 MB per config, which the remote size limit (64 KB per value) already prevents.

**Rejected alternative:** renaming the file to `Config/Configs/link.xml`. Each game would still have a generated file that drifts, plus the per-config `.cs` scan; the package knows the types at build time.

### 5. Steps

### Stage 1: configs 0.2.0

**S1.** Check `git status` and the branch in unity-packages, then create branch `flow/configs-0.2` from `origin/main`. Add `com.iecgames.configs/Editor/ConfigsLinkXml.cs` as in §4: `public sealed class ConfigsLinkXml : IUnityLinkerProcessor`, `public static string Build(IEnumerable<ConfigInfo>)`, and `public static string Write(string projectRoot, IEnumerable<ConfigInfo>)`, which returns the path or null. `GenerateAdditionalLinkXmlFile` calls `Write` with `ConfigInfo.Scan()`. Model on `FacebookLinkXml.cs`. The Editor asmdef already references `UnityEditor` (check for `UnityEditor.UnityLinker` and add nothing if it compiles).

**S2.** Add `Runtime/ConfigJson.cs` (§4). Replace every `JObject.Parse`/`JToken.Parse` in `Runtime/` and `Editor/` with it: `ConfigResolver.cs:51`, `:149`, `GameConfigService.cs:206`, `ConfigEditing.cs:47`, `:61-62`. Check with `grep -rn "JObject.Parse\|JToken.Parse" com.iecgames.configs/Runtime com.iecgames.configs/Editor`, which must be empty.

**S3.** `ConfigResolver.Resolve` uses the filled-in base and filters inside the loop (§4). Add the whole-number walk to `TryBuild`. A build document that fails it gets a `build` rejection with reason `type`, handled as the existing build-failure path. Update the `Resolve` XML doc and the `PatchFilter` class summary: "a patch may change any field the class has and rows or keys the document below it has".

**S4.** `GameConfigService` reject loop (`:162-175`): keep a `HashSet<string>` of remote layer ids already sent, and send `Reject` only for the first rejection of each id. Logging stays as it is, one line per rejection.

**S5.** In `Editor/ConfigEditing.cs`, add `public static string Normalize(ConfigInfo info, string json)`:
- It parses with `ConfigJson`, deserializes with `ConfigResolver.Parse` (or the resolver's serializer), and writes it back with `ToJson(info, value, json)` so the key order is kept and `schema` stays.
- Invalid JSON, or a value that cannot be built, returns `json` unchanged.

**S6.** Bump the package to 0.2.0 and update README "Layers" and the path rule section. Add a CHANGELOG `## [0.2.0]` entry listing:
- the linker processor;
- the filled-in layer base and the row-deleted-below rule;
- the whole-number check;
- date strings kept;
- one `Reject` per layer;
- `ConfigJson` and `ConfigEditing.Normalize`.

Generate metas for the new files with `writeMetas`.

**S7.** Write the tests in §6 (stage 1), then run `node scripts/package.mjs check` and the configs test run. Commit, push, open the PR and run `judge`. Fix blocker and major findings.

**S8.** Deliver: merge — the `com.iecgames.configs` 0.2.0 PR in unity-packages.

**S9.** Publish: com.iecgames.configs

### Stage 2: game-template and knowledge (after: stage 1 published)

**S10.** Check `git status` and the branch in game-template (`flow/game-configs`). Bump `com.iecgames.configs` from 0.1.0 to 0.2.0 in `unity/Packages/manifest.json` and `packages-lock.json` (version only, same shape as the 0.1.0 entry). Note in the PR body that `unity cmd package_resolve` must be run in an Editor.

**S11.** Remove the link.xml generator:
- Delete `unity/Assets/_Project/Config/configs.link.xml` and its `.meta`.
- In `scripts/lib/configs.mjs`, remove `LINK_XML_PATH`, `assemblyOf`, `findClassFile`, `generateLinkXml` and the generated-list entry (`:313`), so `check` no longer looks at it.
- `scripts/configs.mjs`: remove the imports (`:55-56`). `generate` writes and reports only `GameConfigs.Generated.cs`.
- Update `AGENTS.md:156`, the README configs rows and the `configs.mjs` help text: config types are kept from stripping by `com.iecgames.configs` at build time.

**S12.** Add `export function normalizeDoc(config, doc)` to `scripts/lib/configs.mjs` (§4). Use it:
- In `remote-config.mjs` check, before calling `checkPatch` on a config patch (normalize the build document).
- In `configs.mjs remote-diff` (`:341-343`), on both `from` and `to` before `diff`, and as the build passed to `checkPatch`.

**S13.** `remote-diff --json` (`configs.mjs:349-350`): when `args.json` is set, pass `remoteMain` a logger whose `log` and `error` push into an array instead of printing. Add the lines to the payload as `remote`, so `done(args, log, { patch, remote }, ...)` prints one JSON object. On a non-zero code, return `problem(args, log, remoteLines)`.

**S14.** `scripts/lib/remote-config.mjs`, config-name loop (after `:373`): when `RESERVED_NAMES.includes(pascal(config.name))`, push the error `Config ${config.name}: its Name ${Name} is reserved for A/B control. Rename the config.`

**S15.** `Scripts/Editor/ConfigsWindow.cs`:
- **Filled-in build.** Add a field `_baseJson = ConfigEditing.Normalize(info, _buildJson)`, set wherever `_buildJson` is set (`:99`, `:373`). Use `_baseJson` as the `from` side in `Revalidate` (`:116`), `SetPreview` (`:336-337`, and `ApplyPatch` on `_baseJson`) and `MakePatch` (`:342`, `:349`). `ShowDocument(_buildJson)` for preview 0 may stay.
- **Patch button.** The disable condition at `:284` becomes `_errors.Count > 0 || _changes.Count == 0`.
- **`LoadRemote`.** Set `_preview = 0` and call `ShowDocument(_buildJson)` before `_remote` is replaced, on success and on failure (`:310`).
- **`MakePatch`.** If `_preview > 0` and (`_remote == null` or `_preview - 1 >= _remote.branches.Length`), show `EditorUtility.DisplayDialog` "The previewed branch is gone; load the branches again." and return without writing.
- **`ConfigsWindowModel.cs`** (`:78`, `:90`, `:96-97`, `:121`): parse with `Iec.Configs.ConfigJson`.

**S16.** Write the game-template tests in §6 (stage 2), run them and `check-rules`, then commit and push to PR #238.

**S17.** Check `git status` in knowledge (`flow/game-configs`) and update `entries/eng/playbook/game-configs.md`:
- Step 3: drop `configs.link.xml`; the package keeps config types during the build.
- Step 7: a patch can change any field the class has, and only rows that the build file or a lower layer has.
- Pitfalls: add that a fractional number in an integer field is refused, and that a row deleted by a lower layer counts as a new row above it. Remove `configs.link.xml` from the "do not edit" list (`:51`).

Run `npm run check`, then commit and push to PR #237.

**S18.** Run `judge` over game-template and knowledge and fix blocker and major findings.

**S19.** Deliver: merge — game-template PR #238 and knowledge PR #237.

**S20.** Verify: in the game-template Editor, run `package_resolve`. Then use IEC > Configs > New config... to create `daily_reward` with a `days` table, and open Edit configs. Look for:
- the table shows as rows;
- Save writes `days` keyed by id;
- with no edits, Make remote patch is disabled;
- Preview as a remote branch marks only the changed fields;
- a `cycleDays` outside its `[Range]` shows an error, disables Make remote patch and fails a build;
- after an IL2CPP Android build with stripping Low, `Library/Iec/configs.link.xml` lists `DailyRewardConfig` and its row type.

### 6. Tests

**Stage 1, unity-packages `com.iecgames.configs/Tests/Editor`:**
- **`ConfigsLinkXmlTests`:**
  - `BuildListsTheConfigItsRowsNestedTypesAndEnums`: `Build(new[] { ConfigInfo.Of(typeof(DailyRewardConfig)), ConfigInfo.Of(typeof(NestedConfig)) })` contains `<assembly fullname="Iec.Configs.Tests">`, the config types, the row type and the nested type (with `/` for nested CLR types), and any enum used. It has no `System.` type.
  - `NothingToKeepGivesNoFile`: `Write(tempDir, empty)` returns null and creates no file.
  - `WriteGivesTheLinkerAFileWithTheText`: `Write(tempDir, configs)` returns an existing path under `tempDir/Library/Iec`, whose text equals `Build(configs)`.
- **`ConfigResolveTests`:**
  - `AFieldMissingFromTheBuildDocumentCanBePatched`: the build row 7 has no `gems`, and a remote patch `{"days":{"7":{"gems":5}}}` gives `gems == 5` with no rejection.
  - `ARowDeletedBelowIsANewRowAboveIt`: a remote patch `{"days":{"7":null}}` and a cheat `{"days":{"7":{"coins":3}}}` give row 7 absent and one cheat `path` rejection with detail `days.7`.
  - `AFractionInAnIntegerFieldIsATypeRejection`: `days.7.coins` set to `7.6` gives reason `type` with detail `days.7.coins`; `7.0` is applied as 7.
  - `ADateLikeStringStaysAString`: a string field patched to `"2026-11-06T10:00:00Z"` reads back exactly that text. Add a string field to a test type if none exists.
  - `ARemoteLayerIsRejectedOnce`: one remote layer with two unknown paths and a range error gives `_remote.Rejects.Count == 1`.
  - Line 179: replace `.Distinct().ToArray()` with the exact expected array.
  - Existing tests that relied on the old base must still pass unchanged, except ones whose expectation was the false refusal of a missing field.
- **`ConfigEditingTests.NormalizeFillsMissingFieldsAndAnUneditedCopyHasNoChanges`:** for a build `b` without `days.7.gems`, `Normalize` contains `gems`, and `Diff(Normalize(b), ToJson(Load(b).config))` is empty. Destroy the temporary asset.
- **Commands:**
  - `node scripts/package.mjs check`: expect all packages OK.
  - While fixing: `node scripts/test-packages.mjs --template D:/projects/wt/progression-report/game-template --package com.iecgames.configs --variant lite`. This is **slow** (about 10 min). Expect everything to pass except, at most, the 2 known clipboard tests.
  - Once before S8: `... --variant both --fresh` (**slow**).

**Stage 2, game-template node (`scripts/configs.test.mjs`):**
- Change `generate writes the handles...` (`:88-97`): there is no link.xml, `files` is `[GENERATED_PATH]`, and `check` passes.
- New `normalizeDoc fills nested objects and every existing row`.
- New `remote-diff ignores a field that the old file left at its default`: the old file has no `gems`, the new file has `gems` equal to the default, and the result is "no differences".
- New `remote-diff --json prints one JSON object`: `JSON.parse(out)` has `ok: true`, `patch` and `remote`.

**Stage 2, other tests:**
- `scripts/remote-config.test.mjs`: new `a config named ab_control is refused`, where a manifest config `ab_control` makes `check` exit 1 with "reserved".
- Unity `Scripts/Tests/ConfigsWindowModelTests.cs`: new `AnUnchangedNormalizedBuildHasNoChanges`, with a small `[GameConfig("window_test", 1)]` class in the test file (`Scan` skips `*.Tests` assemblies). `ConfigsWindowModel.Changes(Normalize(b), Normalize(b))` is empty for a `b` missing a field.
- **Commands:**
  - `node --test scripts/configs.test.mjs scripts/remote-config.test.mjs scripts/check-build-config.test.mjs scripts/iec.test.mjs`: all pass.
  - `node scripts/check-rules.mjs --base origin/main`: passes.
  - Unity tests: the stage 1 `test-packages.mjs ... --variant lite` run with game-template on this branch (**slow**), once.
  - knowledge: `npm run check` gives "All checks passed".

### 7. Done when

- `com.iecgames.configs` 0.2.0 is merged and published. Its linker processor hands the linker a file listing every config type, and the stage 1 tests pass.
- A field missing from the build file can be patched remotely. A row deleted below is a new row above it. A fractional number in an integral field is a `type` rejection. Date-like strings stay strings. Each rejected remote layer calls `Reject` once.
- game-template pins configs 0.2.0 and has no `configs.link.xml`, `assemblyOf` or `generateLinkXml`. `normalizeDoc` is used by `remote-diff` and `remote-config check`. `remote-diff --json` prints valid JSON, and a config named `ab_control` is refused.
- The Edit configs window diffs against the filled-in build, Make remote patch is disabled with errors or no changes, and a failed or stale branch load can't write to the wrong branch.
- The playbook matches. Game-template #238 and knowledge #237 are merged after a judge PASS. All listed test commands pass.

### 8. Risks, rollback and what not to touch

- **Risks:**
  - `FromObject` writes fields whose default is `null` as `null`. A nested object patched over a `null` nested field is still refused, as today; that's acceptable.
  - The filled-in base makes `remote-config check` accept patches on fields that older 0.1.0 builds refuse. Only game-template pins 0.1.0, and it moves to 0.2.0 in the same stage.
  - `Library/` paths for the linker: `FacebookLinkXml` proves that a non-Assets path is accepted.
- **Rollback:** revert the merge commits. A published 0.2.0 stays on the registry, so game-template can pin 0.1.0 again.
- **Do not touch:** core and `remoteconfig.firebase`, stage 4 code, maze-flow, shiny-loop, pi-config, and `packages-lock.json` beyond the version bump.

### 9. Commits

- **unity-packages:** "configs 0.2.0: linker file at build time, filled-in layer base, whole-number check, date strings kept, one Reject per layer, ConfigEditing.Normalize". Files: `com.iecgames.configs/**`.
- **game-template, first commit:** "configs: pin 0.2.0, drop configs.link.xml and assemblyOf, normalizeDoc for patches and remote-diff, remote-diff --json, ab_control reserved". Files: `scripts/**`, `unity/Packages/manifest.json`, `unity/Packages/packages-lock.json`, `unity/Assets/_Project/Config/configs.link.xml*`, `README.md`, `AGENTS.md`.
- **game-template, second commit:** "configs: Edit configs window diffs the filled-in build, patch button off on errors, safe branch reload". Files: `unity/Assets/_Project/Scripts/Editor/ConfigsWindow*.cs`, `unity/Assets/_Project/Scripts/Tests/ConfigsWindowModelTests.cs`.
- **knowledge:** "game-configs playbook: linker handled by the package, path rule wording". File: `entries/eng/playbook/game-configs.md`.

<!-- pi-workflow:status -->
## Checklist
- [x] S1 Check `git status` and the branch in unity-packages, then create branch `flow/configs-0.2` from `origin/main`. Add `com.
- [x] S2 Add `Runtime/ConfigJson.cs` (§4). Replace every `JObject.Parse`/`JToken.Parse` in `Runtime/` and `Editor/` with it: `Con
- [x] S3 `ConfigResolver.Resolve` uses the filled-in base and filters inside the loop (§4). Add the whole-number walk to `TryBuil
- [x] S4 `GameConfigService` reject loop (`:162-175`): keep a `HashSet<string>` of remote layer ids already sent, and send `Rejec
- [x] S5 In `Editor/ConfigEditing.cs`, add `public static string Normalize(ConfigInfo info, string json)`:
- [x] S6 Bump the package to 0.2.0 and update README "Layers" and the path rule section. Add a CHANGELOG `## [0.2.0]` entry listi
- [x] S7 Write the tests in §6 (stage 1), then run `node scripts/package.mjs check` and the configs test run. Commit, push, open 
- [x] S8 Deliver: merge — the `com.iecgames.configs` 0.2.0 PR in unity-packages.
- [x] S9 Publish: com.iecgames.configs
- [ ] S10 Check `git status` and the branch in game-template (`flow/game-configs`). Bump `com.iecgames.configs` from 0.1.0 to 0.2.
- [ ] S11 Remove the link.xml generator:
- [ ] S12 Add `export function normalizeDoc(config, doc)` to `scripts/lib/configs.mjs` (§4). Use it:
- [ ] S13 `remote-diff --json` (`configs.mjs:349-350`): when `args.json` is set, pass `remoteMain` a logger whose `log` and `error
- [ ] S14 `scripts/lib/remote-config.mjs`, config-name loop (after `:373`): when `RESERVED_NAMES.includes(pascal(config.name))`, p
- [ ] S15 `Scripts/Editor/ConfigsWindow.cs`:
- [ ] S16 Write the game-template tests in §6 (stage 2), run them and `check-rules`, then commit and push to PR #238.
- [ ] S17 Check `git status` in knowledge (`flow/game-configs`) and update `entries/eng/playbook/game-configs.md`:
- [ ] S18 Run `judge` over game-template and knowledge and fix blocker and major findings.
- [ ] S19 Deliver: merge — game-template PR #238 and knowledge PR #237.
## For you after the flow
- S20 Verify: in the game-template Editor, run `package_resolve`. Then use IEC > Configs > New config... to create `daily_rewa
