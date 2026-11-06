<!-- pi-workflow plan v1 flow=20261106-1117-server-time-remote-config-game-configs-a-ac0b -->
## Plan: Server time, remote config, game configs and their A/B integration

Stages:
1. **Server time:** `IServerClock` in core, the cheats badge, wiring, the cheat section and tools in the template, and a playbook.
2. **Remote config:** the remote config service and providers in core, the Firebase provider package, the settings Remote layer, `remote-config.mjs` and its menus, and the IEC server spec.
3. **Game configs:** the `com.iecgames.configs` package, `configs.mjs` (Sheets import, generators, checks), the Edit configs window, and the issue for the ScriptableObject export.
4. **A/B integration:** layer order, the freeze, `ab` cohort patches, `ab_control`, variant config patches, tracking, and the `ab-tests.mjs remote` commands with their window.

Each stage merges the unity-packages part, publishes it, then delivers game-template and knowledge.

### 1. Goal and non-goals
**Goal**
- A trusted clock for features, offline-safe, with saved cheats.
- Remote config that works with any backend (Firebase now), combined by provider priority. It patches settings, feature config documents and A/B variants, for all players, for one app version (a Firebase condition plus an `only` guard) or for one A/B cohort (`ab`).
- One general game config system: a class plus JSON, sheet import, generators.
- An A/B integration that keeps local tests valid while remote can stop, roll out or patch them.
- All tools in both the Unity `IEC/` menu and `iec.bat`.

**Non-goals**
- Moving existing code (cheat daily code, notifications, LiveOps, analytics) to `IServerClock`.
- The IEC remote config provider and server: only the spec is written.
- `remote push` through the Firebase API.
- CDN pointers for large content.
- Folder or level configs: level remote config stays game-specific, read with `IRemoteConfigService.TryGet`.
- The ScriptableObject export: an issue only.
- The #198 custom-event kill switch, and filling `remote_ab_name` / `test_remote`.
- Firebase A/B Testing assigning cohorts.
- Changing values in the middle of a session (only the cheat "Fetch and apply now" does).
- Any change in maze-flow, shiny-loop or pi-config.

### 2. User decisions
**Server time**
- D1. The time API is `IServerClock` in core. Sources are tried in order: `https://network.haleinteractive.vn/api/helper/get-time-utc` (plain Unix seconds), then the HTTP `Date` header of an IEC server.
- D2. One sync per session. Resync on resume after ≥ 5 minutes in the background. Retries after 2, 4, 8… seconds, at most every 60 s.
- D3. Offline it uses device time guarded against the clock moving back (the latest trusted time is saved). Each feature decides online or offline through `IsSynced`; there is no global mode.
- D4. The Editor uses the server like a device. The cheats "time shift" (+1 h, +1 d, custom, reset) and "Use device clock" are saved between sessions, also apply in release builds, show a "TIME CHEAT" label and are ignored by the guard. Save data / Delete all clears them.
- D5. `IAppClock`, sessions and analytics timestamps stay on device time. No existing feature moves now.

**Remote config**
- D6. Interfaces `IRemoteConfigService` and `IRemoteConfigProvider` in core, with all rules in core. Firebase is the first provider, in its own package that joins `tracking-set`. Core has file and mock providers. The IEC server comes later and its spec is written now.
- D7. Each provider has a priority; per key, the highest-priority provider that sends the key wins. A provider that fails keeps its last values.
- D8. Values apply at the next launch. The first launch waits up to 3 s, settable per game. Values are fetched regardless of consent.
- D9. One shared Firebase project, and each game reads only its prefix. One key per feature, `<PREFIX>_<Name>_Parameters`. Settings are grouped by the first part of their name (`ads.*` → `SFP_Ads_Parameters`), with `remoteGroup` as an override.
- D10. Values are written and checked only by the tool. Each has an `id`, a patch per schema, and an optional `only` (versions, platforms). The tool writes the full condition branches (Default plus the branch's changes), warns about stale branches and checks their order. For now GD copies the values into the Firebase console; push comes later.
- D11. Targeting: all players use the Default branch; one app version uses a Firebase condition with `only` as a second guard; one A/B cohort uses the value's `ab` part, applied by the game.
- D12. Tracking: `remote_config_fetch`, `remote_config_rejected`, `remote_config_applied`; the user property `RC_Version` (readable, or a short hash when longer than 36 characters); a publish log in the repo.
- D13. Cheat menu: provider status, values with their provider, Fetch now, Fetch and apply now, Ignore remote this session.

**Configs**
- D14. A config is a `GameConfig` class (`[GameConfig(name, schema, sheet)]`, plain fields, `[Range]`/`[Min]`/`Validate()`) plus a JSON file. Tables are `ConfigTable<T>` keyed by row ID.
- D15. General only, no level-specific parts.
- D16. Package `com.iecgames.configs` with Newtonsoft.
- D17. Sheet layout: row 1 names, row 2 types, first column ID. Configs that come from a sheet are read only in the Editor and change only by import.
- D18. Generators for both: a sheet tab from the class, and a markdown reference per config.
- D19. No ScriptableObject export now: open an issue to catch up later (maze-flow).

**A/B**
- D20. Layer order: Build/Default < AbResult < Remote < AbVariant < AbVariantRemote < Cheat, for settings and configs.
- D21. The freeze: a running test protects every key and path that its variants set, plus the paths its remote `ab` patches set, from general Remote values, for the players in that test.
- D22. `ab_control` holds `ratios` and `force` (new players only) and `stop` and `winner` (they also change players already in the test, at their next launch). Players keep their `AB_Version` label.
- D23. Variants can carry `configs` patches; an ended test keeps `resultConfigs`; the A/B window gets a config patch panel.
- D24. Remote ratios and force apply at the first launch only if the fetch arrives within the wait. This is logged as `control=remote` or `control=build`.
- D25. One assignment system, the local one. Firebase A/B Testing experiments may change remote keys, but never the paths of a running local test (the tool checks this). Tracking: `AB_<date>.control`, `ab_control_applied`, `AB_Patch`.
- D26. Every tool appears in the Unity `IEC/` menu and in `iec.bat`, through the same scripts.

### 3. Facts the executor needs
Paths: `UP` = `D:/projects/wt/progression-report/unity-packages`, `GT` = `.../game-template`, `KN` = `.../knowledge`.

**Settings (core)**
- The precedence is an explicit array, `UP/com.iecgames.core/Runtime/Settings/SettingsService.cs:11-14` (`Priority`, highest first). The `SettingSource` enum order is documentation only (`SettingSource.cs`).
- `Resolve` is at :220-248. `SetLayer` is at :92-111 and refuses Default and Cheat. `CheckValue` is at :82-90. `All` / `SettingInfo` are at :33-46.
- `Settings.Define<T>(key, default)` is at `Settings.cs:19-23`.

**Startup**
- `StartupRunner` starts each component when its `Requires` are provided and re-checks on every `Provide` (`StartupRunner.cs:41,64-91`). It has no timeout, only a 20 s stall log.
- The model for a value provided later, with a timeout fallback, is `ConsentStartupComponent.cs:20,41-69`.
- The game's list is `GT/unity/Assets/_Project/Scripts/Runtime/GameBootstrap.cs:126-150`: AppState :131, AbTests :133, Analytics :134. `LoadingNames` is at :189-201.

**A/B**
- `AbTestService` constructor: `AbTestService.cs:49`, `AssignCohort`/`LoadForce`/`ApplyLayers` at :57-59, `ApplyLayers` at :317-349 (`SetLayer` calls at :348-349).
- The user property is set around :142; `Changed()` is at :147.
- `AbTestsStartupComponent.cs` requires `IAppState` and builds the service.

**Analytics**
- `IAnalyticsService.LogEvent(AnalyticsEvent)` at :51 and `SetUserProperty(string, string)` at :57.
- Test fakes: `FakeAnalyticsProvider` with the real `AnalyticsService` (`Tests/Editor/AbTestServiceTests.cs:286-287`), `MemorySecureStore`, `FakeAppClock` (`Tests/Editor/FakeAppClock.cs`), `ManualScheduler` (`Tests/Editor/ManualScheduler.cs`).
- Tests are EditMode only, asmdef `Tests/Editor/Iec.Core.Tests.asmdef`.

**HTTP**
- The only pattern is `IHttpPoster` / `UnityHttpPoster` (`IecAttReportComponent.cs:9-35`, injected at :66,73; `FakePoster` in `Tests/Editor/StartupTests.cs:425`).
- Core's `package.json` doesn't declare `com.unity.modules.unitywebrequest`.
- The IEC events host is `https://event-api.haleinteractive.vn` (`UP/com.iecgames.analytics.iec/Runtime/IecEventsConfig.cs:13`).

**App state** (`IAppState.cs`): `IsFirstLaunch` :20-21, `InstallId` :17, `DaysSinceInstall` :45, `FirstVersion`/`CurrentVersion` :23-26. `AbVersions` holds the label per app version.

**Config loading**: `IecConfig.TryLoad<T>(resourceName)` and `TryParse` (`Runtime/IecConfig.cs`) use JsonUtility. Core has its own `Runtime/Json/JsonReader.cs`.

**Cheats package**
- `Cheats.Section(name)` returns `CheatSection` with `Button`/`Toggle`/`Int`/`Float`/`Text`/`Choice`/`Info(label, Func<string>)` (`CheatSection.cs:19-39`). Info rows refresh every 0.25 s.
- The only always-visible label is FPS (`CheatMenuView.cs:43-48`). The package doesn't depend on core and stores its data in PlayerPrefs.
- The game's sections are `GT/.../Runtime/GameCheats.cs:20-42` and `AbCheats.cs:19,53-76`, re-registered at `GameBootstrap.cs:269-271`.

**Save data**: `IEC/Save data/Delete all` deletes the secure store folder (`UP/com.iecgames.core/Editor/SaveDataMenu.cs:31-38`), not PlayerPrefs.

**Firebase**
- `FirebaseBootstrap.WhenReady(Action<bool>)` is at `UP/com.iecgames.firebase/Runtime/FirebaseBootstrap.cs:27`.
- The registration model is `UP/com.iecgames.analytics.firebase/Runtime/FirebaseAnalyticsRegistration.cs:18-40` (AfterAssembliesLoaded, Android/iOS only). Its asmdef versionDefine model is `Iec.Analytics.Firebase.asmdef:4-6,15-21`.
- Google 13.17.0 is pinned. `config/vendor-registries.json` pins vendor tgz files by sha256 (`name@version`). The hash is computed by hand (`UP/README.md:73-74`).
- `tracking-set/package.json` pins `com.iecgames.firebase` 0.3.1 and `analytics.firebase` 0.3.2.

**Newtonsoft**: `com.unity.nuget.newtonsoft-json` 3.2.2 is already in `GT/unity/Packages/packages-lock.json:659-664`, and `attribution.adjust` pins 3.2.2.

**Firebase Remote Config limits**, per project and so shared by every game: 3,000 parameters, 2,000 conditions, keys up to 256 characters, **1,000,000 characters of values in total**.

**game-template tools**
- `scripts/ab-tests.mjs` (main :289; `runCheck` :159-168; `runChange` :239-270; `generate` :272-285).
- `scripts/lib/ab-settings.mjs` (`SETTINGS_PATH` :9, `KEY` regex :15, `generateCs` :102-121, `validateSettings` :260).
- The Editor window `Scripts/Editor/AbTestsWindow.cs:40,83,406-429` shells out through `NodeRunner.cs:23-38`.
- Flows: `scripts/iec.mjs:69-90` (labels), :355 (`FLOW_SCRIPTS`), :492-526 (`runFlow`), template flows in `scripts/lib/iec-flows.mjs:72-80`.
- The xlsx reader is `scripts/lib/gd-xlsx.mjs` (`readWorkbook` :133). The sheet download pattern is `scripts/gd-sheet.mjs:406`.

**game-template rules**
- New C# goes in `Runtime/`, `Editor/` or `Tests/`, one asmdef each (`AGENTS.md:49-50`).
- Every tool needs a help line and a README "Tools" row with its playbook (:281).
- Run `check-rules.mjs --base origin/main` (:261-266).
- `packages-lock.json` is changed only through `unity cmd package_resolve` (:271-272).
- No downgrades (:268-273).

**unity-packages rules**
- Version bumps go through `edit-package.mjs`, with a CHANGELOG entry; every file needs a `.meta`; dependencies are pinned exactly; `node scripts/package.mjs check` runs before push.
- A new package is created with `scripts/new-package.mjs` (scaffold at `scripts/lib/package-dev.mjs:240-310`).

**knowledge**
- Required front matter: `id`, `title`, `type`, `domain`, `status`, `summary` (20-300 characters), `tags`, `sources`. A playbook needs the sections Goal, Steps and Verification. Follow `templates/`.
- Migration rows: `docs/plans/moon-template-migration.md:57` (Remote config + A/B, up#198/#199) and :83 (Server time, gt#40).
- The tracking plan `docs/plans/analytics-tracking-plan.md` has rows at :50 (`firebase_exp`) and :148.
- `eng.rule.use-sdk-wrappers` already names `IRemoteConfigService` (:19) and bans `Firebase.RemoteConfig` (:37).

**Issues**: up#198 (Remote Config, open), up#199 (remote A/B, open), gt#40 (server time and encrypted saves, open).

### 4. Design

**4.1 Server time (core, `Runtime/Time/`, asmdef `Iec.Core.Time`, namespace `Iec.Core.Time`)**
```csharp
public interface IServerClock {
  DateTime UtcNow { get; }            // synced: server + elapsed; else guarded device; plus the cheat shift
  bool IsSynced { get; }  bool ClockMovedBack { get; }
  DateTime? LastServerUtc { get; }  TimeSpan? DeviceOffset { get; }  string SourceName { get; }
  TimeCheat Cheat { get; }  void SetCheat(TimeCheat cheat);   // saved
  event Action Synced;  void Resync();
}
public readonly struct TimeCheat { TimeSpan Shift; bool UseDeviceClock; bool IsActive; }
public interface ITimeSource { string Name { get; } void Fetch(TimeSpan timeout, Action<TimeSourceResult> done); }
```
**Time computation**
- On a reply: `UtcNow = serverUtc + rtt/2 + (realtime − realtimeAtReply)`.
- A reply more than 3,650 days from the device time is rejected.
- **Saved keys:**
  - `iec.time.trusted`: the highest real (unshifted) UTC seen, written on every sync and on pause.
  - `iec.time.cheat`: `{"shiftSeconds":n,"useDevice":b}`.
- **Not synced:** if the device time is more than 5 minutes before the trusted value, `ClockMovedBack` is true and the time is trusted + realtime since start. Otherwise the device time is used.
- **`UseDeviceClock`:** returns the raw device time, but syncing continues so the trusted value stays fresh.
- **Cheat shift:** added last, never saved as trusted.

**Sources**
- `IecTimeSource` and `HttpDateTimeSource` (`https://event-api.haleinteractive.vn/`, `Date` header, RFC 7231).
- Both make requests through an injected `IHttpGetter` (modelled on `IHttpPoster`), so tests can fake them.

**Tracking**
- `server_time_sync`, once per session: `source`, `status` (`ok`/`failed`), `ms`, `offset` (`<1m`, `<1h`, `<1d`, `>=1d`).
- `clock_moved_back`, once per session.

**4.2 Remote config core (`Runtime/RemoteConfig/`, asmdef `Iec.Core.RemoteConfig`)**
```csharp
public interface IRemoteConfigProvider { string Name { get; } int Priority { get; }
  void Fetch(RemoteFetchRequest request, Action<RemoteFetchResult> done); }   // done on the main thread
public sealed class RemoteFetchRequest { string Prefix, InstallId, Platform, AppVersion, AbLabel; int DaysSinceInstall;
  string LastVersion; TimeSpan Timeout; }
public sealed class RemoteFetchResult { RemoteFetchStatus Status /*Ok, NotModified, Failed*/;
  IReadOnlyDictionary<string,string> Values /*by Name*/; string Version; string Error; }
public interface IRemoteConfigService {
  RemoteOrigin Origin { get; }   // BuildOnly, Saved, Fresh
  IReadOnlyList<RemoteProviderStatus> Providers { get; }
  IReadOnlyCollection<string> Names { get; }
  bool TryGet(string name, out RemoteValue value);
  bool IgnoreThisSession { get; set; }
  void FetchNow(bool applyNow);
  void Reject(string name, string id, string reason);
  event Action Applied;  event Action<RemoteFetchReport> Fetched;
}
public sealed class RemoteValue { string Name, Provider, Raw, Id; IReadOnlyDictionary<string,string> Patches; // schema -> JSON
  IReadOnlyDictionary<string, RemoteAbEntry> Ab; }      // cohort label -> { int Rev; Patches }
public static class RemoteConfigProviders { static void Register(string name, Func<IRemoteConfigProvider> create); }
public static class RemoteNames { string ForSetting(string key, string remoteGroup); string FieldOf(string key, string remoteGroup);
  string ForConfig(string configName); }   // "daily_reward" -> "Daily_Reward"
```

**Names**
- A **Name** is the PascalCase-with-underscores key without the prefix and the `_Parameters` suffix. Each provider maps it; Firebase uses `<Prefix>_<Name>_Parameters`.
- A setting's group is the first segment of its key; with `remoteGroup` set, the group is that value. A key without a dot goes to the group `Other`.
- A setting's field is its key minus the first segment, or the full key when `remoteGroup` is set or the key has no dot.

**Value envelope** (each remote value's JSON):
```json
{ "id": "ads-def-r2", "only": { "versions": ["2.5.0"], "platforms": ["android"] },
  "patches": { "1": { "inter_interval": 60 } },
  "ab": { "AB_20261106_v51": { "rev": 1, "patches": { "1": { "inter_interval": 75 } } } } }
```
- `only` is optional and compared exactly against `Application.version` and the platform. A mismatch acts as if the key were absent, with `Reject(reason "version"/"platform")`.
- Settings groups always use schema `"1"`. `ab` is ignored until stage 4.
- The game's own sections read `Raw`. A value that isn't an envelope still gives `Raw` and empty `Patches`.

**Snapshots** (secure store `iec.remote.active` and `iec.remote.staged`)
```json
{ "version": 1, "providers": { "firebase": { "version": "…", "fetchedAt": "…Z", "values": { "Ads": "{…}" } } } }
```
**Start**
- If a staged snapshot exists, it becomes active.
- The active snapshot is applied: **Origin Saved**, or **BuildOnly** when there is none.
- Then the providers are fetched in the background, and their results update the staged snapshot. A failed provider keeps its previous entry.

**First launch** (`IsFirstLaunch` and no active snapshot)
- `IRemoteConfigService` is provided only when every provider has answered or `firstLaunchWaitSeconds` have passed.
- In-time results go straight into active: **Origin Fresh**. Late results are staged.

**Limits and cheats**
- At most one fetch per provider every 600 s; the first launch and the cheats bypass this.
- A provider's values over 65,536 characters make that result Failed (`size`).
- Two providers with the same priority: error log, and the later one is dropped.
- `FetchNow(applyNow:true)` promotes the fetched result and raises `Applied`.
- `IgnoreThisSession` raises `Applied`, and `TryGet` then returns false.

**Merging**: per Name, the provider with the highest priority that has the Name wins. The file provider has priority 0 and Firebase 100.

**Per-game file** `Config/Resources/iec-remote-config.json`: `{ "prefix": "SFP", "firstLaunchWaitSeconds": 3 }`, read with `IecConfig.TryLoad`. If it's missing, there is no prefix and the wait is 3 s.

**`RemoteSettingsLayer`** (core) applies the Remote settings layer on `Applied`:
- for each `SettingInfo`, it reads the group value's `patches["1"][field]`, then `CheckValue`;
- a bad value is rejected with reason `type`, and an unknown field in a group with reason `unknown`.

It is provided into the startup context before `IRemoteConfigService`.

**Tracking**
- `remote_config_fetch`: `provider`, `status`, `ms`, `first_launch`, `in_time`, `version`.
- `remote_config_rejected`: `name`, `id`, `reason`.
- `remote_config_applied`: once when the applied set of ids changes (saved as `iec.remote.applied`). One parameter per Name holding its id, at most 20; the rest are dropped with a warning.
- The user property `RC_Version`:
  - the ids sorted by Name and joined with `.`;
  - when that's longer than 36 characters, `h` plus the first 8 hex digits of FNV-1a 64 of the joined text;
  - `-` when there are no ids.

**4.3 Repo remote files (game-template, written only by the tools)**

`unity/Assets/_Project/Config/Remote/<Name>.json`:
```json
{ "name": "Ads", "code": "ads", "experiment": false,
  "branches": [ { "branch": "default", "code": "def", "rev": 2, "publishedRev": 2, "changes": { "1": { "inter_interval": 60 } }, "ab": {} },
                { "branch": "SFP Android hotfix 2.5.0", "code": "hf250", "rev": 1, "publishedRev": 0,
                  "only": { "versions": ["2.5.0"], "platforms": ["android"] }, "changes": { "1": { "banner_enabled": false } }, "ab": {} } ] }
```

**The value the tool writes for a branch**
- For a non-default branch: `{ id: "<code>-<branchCode>-r<rev>", only, patches: merge(default.changes, branch.changes) per schema, ab: merge(default.ab, branch.ab) }`. The Default branch is written alone, without `only`.
- Every change raises `rev` on each branch whose output changed.
- `published <Name> <branch|all>` sets `publishedRev = rev` and appends to `unity/Assets/_Project/Config/Remote/remote-config-log.json` an entry `{date, user (git config user.name), firebaseKey, branch, id, value, note}`.
- `check` warns about every branch where `rev ≠ publishedRev` ("not pasted yet").

`unity/Library/iec-remote-file.json` (gitignored) is the file provider's input in the Editor: `{ "<Name>": <envelope> }`. On devices it is `persistentDataPath/iec-remote-file.json`, read only in the Editor and development builds.

**4.4 Configs package (`com.iecgames.configs`, asmdefs `Iec.Configs`, `Iec.Configs.Editor`)**
```csharp
[AttributeUsage(AttributeTargets.Class)] public sealed class GameConfigAttribute : Attribute { GameConfigAttribute(string name, int schema); string Sheet { get; set; } }
public abstract class GameConfig { public virtual void Validate(ConfigErrors errors) {} }
[Serializable] public abstract class ConfigRow { public string id; }          // id is the JSON key, not inside the row
[Serializable] public sealed class ConfigTable<T> : IReadOnlyList<T> where T : ConfigRow { T this[string id]; bool TryGet(string id, out T row); }
[AttributeUsage(AttributeTargets.Field)] public sealed class ConfigAllowNewRowsAttribute : Attribute {}
public interface IGameConfigs { T Get<T>() where T : GameConfig; ConfigReport Report(string name); IReadOnlyList<string> Names;
  void SetCheatPatch(string name, string patchJson); event Action<string> Changed; }
public static class Configs { static IGameConfigs Service; static T Get<T>() where T : GameConfig; }
```
**Storage**
- The build document is `Resources/configs/<name>.json` and contains `"schema"`.
- `ConfigTable` is Unity-serializable (a `List<T>`), so the inspector can show it, and is written as a JSON object keyed by `id`, sorted numeric-aware.

**Resolution** happens on the first `Get<T>()` and again after `IRemoteConfigService.Applied`:
1. Load the build document.
2. Collect the layers. Stage 3: Remote (`RemoteNames.ForConfig(name)` → `Patches[schema]`) and Cheat. Stage 4 adds AbResult, AbVariant and AbVariantRemote.
3. Skip a layer whose schema doesn't match.
4. Drop patch paths that add a field not in the build document, unless they are under a `[ConfigAllowNewRows]` table (reason `path`). Also drop `null` on anything that isn't a table row.
5. Apply RFC 7396 in layer order.
6. Deserialize with Newtonsoft.
7. Check `[Range]`/`[Min]`, then `Validate()`.

On failure, drop the highest remaining layer and retry; the worst case is the build document. Each dropped remote layer calls `IRemoteConfigService.Reject`.

`ConfigsStartupComponent` requires `IRemoteConfigService` and provides `IGameConfigs`.

**Game-side files**
- `Config/iec-configs.json`: the manifest, written by an Editor `[InitializeOnLoad]` scanner through `TypeCache`. It lists name, type, schema, sheet and fields (path, type, default, min, max, tooltip, enum values, table, allowNewRows).
- `Config/iec-configs.settings.json`: `{ "sheetUrl": "" }`.
- `Scripts/Runtime/GameConfigs.Generated.cs` and `Config/configs.link.xml`: generated by `configs.mjs generate`.

**Sheets**
- Scalars come from the tab `<Sheet>`, laid out with `key` in A1 and `value` in B1.
- Each table field comes from the tab `<Sheet>.<field>`: row 1 names, row 2 types (`int|float|bool|string|enum|json`), first column `id`, dotted headers for nested fields.

**4.5 A/B integration (stage 4)**

**Precedence**: `Priority` becomes Cheat, AbVariantRemote, AbVariant, Remote, AbResult, then Default. `SettingSource.AbVariantRemote` is appended last in the enum, so the existing numbers don't change.

`IAbTestService` gains:
```csharp
string EffectiveLabel { get; }  bool IsRunning { get; }  string Control { get; } // "build"|"remote"
IReadOnlyCollection<string> FrozenSettingKeys { get; }
IReadOnlyCollection<string> FrozenConfigPaths(string config);
IReadOnlyList<AbConfigPatch> ResultConfigPatches(string config);   // oldest test first
AbConfigPatch VariantConfigPatch(string config);                   // null when none
public sealed class AbConfigPatch { public int Schema; public string PatchJson; public string Source; }
```
**`EffectiveLabel`**
- the cohort label;
- the winner's label after a remote `winner`;
- null after `stop`, or with no cohort.

**`IsRunning`**: the cohort's test has no `result`, and remote hasn't stopped it or picked a winner.

**The freeze** applies only while `IsRunning`. Frozen are the union of:
- every variant's `values` keys and `configs` leaf paths for that test;
- the `ab` patch leaf paths for every label of that test.

Settings: `RemoteSettingsLayer.SetFrozenKeys` removes those keys. Configs: the Remote patch loses each frozen path, and any leaf or null whose subtree holds a frozen path.

**`ab_control`** is the Name `Ab_Control` (`SFP_Ab_Control_Parameters`), `patches["1"]`:
```json
{ "AB_20261101": { "ratios": { "20": 1, "21": 3 }, "force": null, "stop": false, "winner": null } }
```
- It is ignored for a test that has a `result` in this build, and for unknown tests, variants or bad values (error log plus `Reject`).
- **New players:** a valid `force` or `ratios` changes the assignment and sets `Control = "remote"`. A `winner` assigns the winner, and `stop` gives no cohort, the same as a platform without a release test.
- **Existing players:**
  - **stop:** the AbVariant and AbVariantRemote layers are empty and the freeze ends;
  - **winner N:** the AbVariant values are N's and the AbVariantRemote entries are `ab[<N label>]`.
  - Their `AB_Version` label never changes.

**AbVariantRemote for settings**: every settings group value's `ab[EffectiveLabel].patches["1"]`.

**Catalog** (additive):
- each variant gains `"configs": { "<config>": { "schema": 2, "patch": {…} } }`;
- each test gains `"resultConfigs"` in the same shape.

**Tracking**
- `AB_<yyyyMMdd>` gains `control`.
- `ab_control_applied` is logged once per (test, action, rev), saved as `iec.ab.control.log`. Parameters: `test`, `action` (`stop`/`winner`/`patch`), `old_variant`, `new_variant`, `rev`.
- The user property `AB_Patch` is `<testKey>:<max rev of the applied ab entries>`, or empty.
- `rev` is one counter per test, written by the tool into every `ab` entry of that test.

**4.6 Rejected alternatives** (from the discussion)
- Firebase A/B Testing assigning cohorts.
- One settings layer per provider.
- One `<PREFIX>_Settings` key: a condition replaces the whole value.
- A rule engine in the app.
- Applying values mid-session.
- Patching ScriptableObjects at runtime.
- Newtonsoft in core.
- NTP.
- A section registration API: `TryGet` is enough.
- A merge cache and CDN pointers: deferred until measured.

**4.7 Scale and limits**
- One fetch per cold start: at 100k DAU, about 3.5 requests per second on average and about 35 at peak.
- At most 64 KB per provider.
- Firebase allows 1,000,000 characters of values per project, shared by every game. `check` warns above 100,000 characters for one game and fails above 1,000,000.
- At most 20 keys go into `remote_config_applied`. `RC_Version` is at most 36 characters.
- This design stops fitting when one game's remote content exceeds about 100 KB: that is when CDN pointers become necessary (a non-goal here).

### 5. Steps

### Stage 1: Server time

**S1.** Core `Runtime/Time/` (new asmdef `Iec.Core.Time`, which references `Iec.Core` and `Iec.Core.Storage`):
- add `IServerClock`, `TimeCheat`, `ITimeSource`, `TimeSourceResult`, `IHttpGetter` with `UnityHttpGetter`, `IecTimeSource`, `HttpDateTimeSource` and `ServerClock`, per §4.1;
- `ServerClock`'s internal constructor takes `IAppClock`, `ISecureStore`, `IScheduler`, the sources, a realtime function and the analytics service (attached later).

**Behaviour**
- Retry delays 2, 4, 8, 16, 32, 60, 60… s.
- `OnPause(true)` saves the trusted value. `OnPause(false)` after ≥ 300 s calls `Resync`.
- The sources parse with an invariant culture. The IEC source trims the body; anything that isn't a positive integer is a failure.
- `SetCheat` saves `iec.time.cheat`. When a cheat is active at start, a warning is logged.

Model `IHttpGetter` on `IecAttReportComponent.cs:9-35`. Add `com.unity.modules.unitywebrequest` 1.0.0 to core's `package.json`. Update the `IAppClock.cs` comment to point to `IServerClock`.

**S2.** Core: `ServerClockStartupComponent` in `Runtime/Startup/Components/`.
- `Requires` is empty. It provides `IServerClock` at once and starts the sync.
- It adds a hidden lifecycle `MonoBehaviour` for pause and resume, modelled on `AppStateLifecycleRunner.cs`.
- It attaches tracking through `context.When<IAnalyticsService>`.
- Add the event classes `ServerTimeSyncEvent` and `ClockMovedBackEvent`, modelled on the classes in `Runtime/Tracking`.
- Bump core (next minor through `edit-package.mjs`), with the CHANGELOG and a README section "Server time".

**S3.** Core Editor: menu `IEC/Server time/Test endpoint`.
- It calls both sources from the Editor (completion callbacks of `UnityWebRequest`, outside Play mode).
- It logs each source's result, round trip and offset from the device clock.

**S4.** `com.iecgames.cheats`: add `Cheats.SetBadge(string id, string text)`, where null or empty text removes the badge.
- Badges show stacked in the top-left corner, always visible (menu open or closed), drawn like the FPS label (`CheatMenuView.cs:43-48`) and created by the host (`CheatInstaller.cs:9-10`).
- Before the host exists, set badges are kept and shown once it's created.
- Bump the version, with the CHANGELOG and README.

**S5.** Tests in unity-packages: see §6 T1–T3. Run `node scripts/package.mjs check`.

**S6.** Deliver: merge — the unity-packages part of stage 1.

**S7.** Publish: com.iecgames.core, com.iecgames.cheats

**S8.** game-template:
1. **Packages:** bump `com.iecgames.core` and `com.iecgames.cheats` in `unity/Packages/manifest.json` to the published versions, and resolve with `unity cmd package_resolve` using the absolute `--project-path` of this worktree's `game-template/unity` (`AGENTS.md:271-272`).
2. **Startup:** in `GameBootstrap.CreateComponents` (:126-150), add `new ServerClockStartupComponent()` right after AppState (:131).
3. **Cheats:** add `Scripts/Runtime/TimeCheats.cs`, modelled on `AbCheats.cs:53-76`, with a section "Server time":
   - Info rows: Synced, Source, Offset, Clock moved back, Now (UTC);
   - Buttons "+1 hour", "+1 day", "Reset shift", "Resync now";
   - an `Int` "Shift (hours)" that sets an absolute shift;
   - a Toggle "Use device clock".

   Register it from `GameCheats` (:20-42) and when `IServerClock` is provided (as at `GameBootstrap.cs:269-271`). While `Cheat.IsActive`, call `Cheats.SetBadge("time", "TIME CHEAT")`, and clear it otherwise.

**S9.** game-template `scripts/server-time.mjs`, plus `lib/server-time.mjs` holding the pure parsing:
- `check [--json]` fetches both sources with Node `fetch`, prints each UTC time, round trip and the offset from this computer's clock, and exits 1 if both fail.
- Add the flow `servertime` in `lib/iec-flows.mjs` and `iec.mjs` (label "Server time  test the IEC time endpoints and show the clock offset"), with a help line and a README Tools row pointing to `eng.playbook.server-time`.

**S10.** knowledge:
- **New playbook** `entries/eng/playbook/server-time.md` (`eng.playbook.server-time`, status as in templates). It covers:
  - using `IServerClock`;
  - `IsSynced` for strict and lenient features, with a daily reward example;
  - the cheats and their badge;
  - the endpoint check;
  - what stays on device time.
- **Tracking plan:** add `server_time_sync` and `clock_moved_back` to `docs/plans/analytics-tracking-plan.md`.
- **Migration plan:** in `moon-template-migration.md:83`, mark Server time done, linking the PRs and the playbook, and update the status date.

**S11.** Deliver: merge — game-template and knowledge for stage 1. Then comment on gt#40 that server time has shipped (with the PR links), and leave the issue open for its encrypted-saves part.

**S12.** Verify: in the game-template Editor, enter Play mode and open the cheat menu (Backquote), section Server time — look for: Synced true with source `iec`; "+1 day" moves Now by 24 h and shows the TIME CHEAT badge; the shift survives a Play mode restart; "Use device clock" follows the computer's clock; after Delete all, no cheat remains.

### Stage 2: Remote config core and the Firebase provider

**S13.** Core `Runtime/RemoteConfig/` (asmdef `Iec.Core.RemoteConfig`, which references Core, Storage, Settings and Analytics), per §4.2:
- the interfaces and contracts;
- the envelope parser on core's `JsonReader` (extend `JsonReader` to return a sub-object's raw text if it can't yet);
- `RemoteNames`, `RemoteConfigService` (snapshots, promotion, first-launch wait, throttle, size limit, priority merge, `only`, `Reject`, tracking and `RC_Version`);
- `RemoteConfigProviders`, `FileRemoteProvider` (priority 0, the paths in §4.3, Editor and development builds only), `MockRemoteProvider` (public, for tests and QA) and `RemoteSettingsLayer`.

**S14.** Core settings: `Settings.Define<T>(string key, T defaultValue, string remoteGroup = null)`, and `SettingInfo.RemoteGroup`. Existing calls keep compiling. A repeated `Define` with a different `remoteGroup` logs an error and keeps the first.

**S15.** Core: `RemoteConfigStartupComponent` in `Runtime/Startup/Components/`.
- It requires `IAppState`, reads `iec-remote-config.json` and creates the providers from `RemoteConfigProviders` plus the file provider.
- It provides `RemoteSettingsLayer`, then `IRemoteConfigService`: at once, or after the first-launch wait, modelled on `ConsentStartupComponent.cs:41-69`.
- It attaches analytics through `When<IAnalyticsService>`.
- `RemoteFetchRequest.AbLabel` is the latest label in `IAppState.AbVersions`.
- Bump core, with the CHANGELOG and a README section "Remote config".

**S16.** unity-packages: add the sha256 pin of `com.google.firebase.remote-config@13.17.0` to `config/vendor-registries.json` (Google tgz URL pattern, hash computed as in `README.md:73-74`).

**S17.** Mirror: all; extras com.google.firebase.remote-config@13.17.0

**S18.** New package `com.iecgames.remoteconfig.firebase`, created with `scripts/new-package.mjs`.
- **Dependencies:** core (the S15 version), `com.iecgames.firebase` 0.3.1, `com.google.firebase.remote-config` 13.17.0.
- **asmdef:** `Iec.RemoteConfig.Firebase`, with defineConstraint and versionDefine `IEC_REMOTECONFIG_FIREBASE` on `com.google.firebase.remote-config`. Model: `Iec.Analytics.Firebase.asmdef`.
- **`FirebaseRemoteProvider`** (Name `firebase`, Priority 100):
  - waits for `FirebaseBootstrap.WhenReady`; `false` gives Failed;
  - calls `SetConfigSettingsAsync`, with a minimum fetch interval of 0 in development builds and 3,600,000 ms otherwise, and the fetch timeout set to `request.Timeout`;
  - then `FetchAsync`, `ActivateAsync`, and reads `AllValues`, keeping keys that start with `<Prefix>_`, end with `_Parameters` and come from the remote source;
  - maps each key to its Name. Version is the FNV-1a 64 hex of the sorted `name=value` pairs, and it returns NotModified when that equals `LastVersion`;
  - an empty prefix gives Failed `no prefix`;
  - callbacks run on the main thread, with a scheduler timeout so a hung SDK still answers.
- **Registration:** `[RuntimeInitializeOnLoadMethod(AfterAssembliesLoaded)]` on Android and iOS only, modelled on `FirebaseAnalyticsRegistration.cs:18-40`.
- README and CHANGELOG.

**S19.** `com.iecgames.tracking-set`: add the new package, bump the version, and update the CHANGELOG and README. Check `KN eng.rule.use-sdk-wrappers` `allowed_in`: if it lists packages one by one, add `com.iecgames.remoteconfig.firebase` in S24.

**S20.** Tests in unity-packages: see §6 T4–T7. Run `node scripts/package.mjs check`.

**S21.** Deliver: merge — the unity-packages part of stage 2.

**S22.** Publish: com.iecgames.core, com.iecgames.remoteconfig.firebase, com.iecgames.tracking-set

**S23.** game-template:
1. **Packages:** bump core and tracking-set, then resolve as in S8.
2. **Startup:** add `new RemoteConfigStartupComponent()` after `ServerClockStartupComponent` and before AbTests.
3. **Remote config file:** add `Config/Resources/iec-remote-config.json` with `{ "prefix": "", "firstLaunchWaitSeconds": 3 }`. The template's prefix is empty; a game sets it with `init`.
4. **Settings:** add `remoteGroup` to `lib/ab-settings.mjs`:
   - an optional entry field, validated in `validateSettings` against `^[A-Z][A-Za-z0-9]*(_[A-Z][A-Za-z0-9]*)*$`;
   - `generateCs` passes it as the third argument of `Settings.Define`;
   - `ab-tests.mjs setting add` gains `--remote-group <Name>`.
5. **Cheats:** add `Scripts/Runtime/RemoteConfigCheats.cs`, section "Remote config":
   - Info rows: origin; per provider, status, version and fetched at; per Name, id and provider; the rejected list;
   - Buttons "Fetch now" and "Fetch and apply now" (the latter then `SceneManager.LoadScene(0)`);
   - a Toggle "Ignore remote this session".

   Register it like `TimeCheats`.

**S24.** game-template `scripts/remote-config.mjs`, plus `lib/remote-config.mjs` with pure operations (model `ab-tests.mjs` and `lib/ab-settings.mjs`), working on the §4.3 files:
- `init --prefix <P> [--wait <s>]`
- `list [--json]`
- `set <setting-key> <value> [--branch <b>] [--clear]`: checks the type against `iec-settings.json`.
- `set-patch <Name> --schema <n> --file <patch.json> [--branch <b>] [--clear]`
- `branch add <Name> <branch> --code <c> [--versions a,b] [--platform android|ios]`, `branch remove`, `branch move <Name> <branch> <index>`
- `show <Name> [--branch <b>] [--json]`: the Firebase key, the exact value to paste per branch, and a plain description of the condition to create (exact app versions and platform).
- `published <Name> <branch|all> [--note <text>]`
- `local [--branch <b>|--clear]`: writes the chosen branches to `unity/Library/iec-remote-file.json`.
- `check [--template <firebase-template.json>] [--json]`. It reports:
  - name collisions (settings groups against each other and against `Ab_Control`, extended in later stages);
  - setting types and unknown fields;
  - branches not pasted yet;
  - the game's total characters (warning above 100,000, error above 1,000,000);
  - if a template is given (format `firebase remoteconfig:get`, with `parameters`, `parameterGroups` and `conditions` order): keys with the prefix that the tool doesn't know (info), values that differ from the repo, and branches with `only.versions` ordered below branches without it.

Missing arguments are asked for interactively, modelled on `lib/ab-prompts.mjs`. Agents pass every argument and `--json`.

Add the flow `remote` to `iec-flows.mjs` and `iec.mjs` (label "Remote config  remote values per feature key, branches, copy for Firebase, check a Firebase template"), with a help line and a README Tools row (`eng.playbook.remote-config`).

**S25.** game-template Editor, both shelling out through `NodeRunner` like `AbTestsWindow.cs:83,406-429`:
- `IEC/Remote config/Values...` (`RemoteConfigWindow.cs`): a key list; per key, its branches; per setting, a field that fits its type; Add branch; Copy value for the selected branch; Mark published; Write to local file. Errors come from `check --json`.
- `IEC/Remote config/Check Firebase template...`: a file picker, then `check --template`.

**S26.** knowledge:
- **New playbook** `eng.playbook.remote-config`: prefix setup, keys and groups, branches and conditions, pasting and marking published, the version guard, checking a template, the cheat menu, reading `RC_Version`.
- **New doc** `docs/plans/iec-remote-config-server.md`, the IEC server spec. It has the request and response contract:

  ```
  GET /remote-config?game=&platform=&version=&install=&ab=&days=
  If-None-Match
  200 { version, ttlSeconds, values: { Name: envelope-text } }
  304
  ```
  Also: an error keeps the last snapshot, the server does all the targeting, 64 KB inline at most, and a per-game key in a header.
- **Tracking plan:** the remote events and `RC_Version`.
- **Migration plan:** row :57, Remote Config part done.
- **A/B playbook:** update the pitfall "Remote Config not built yet" in `eng.playbook.ab-tests-and-releases`.
- **Rule:** `use-sdk-wrappers` `allowed_in`, if needed (S19).

**S27.** Deliver: merge — game-template and knowledge for stage 2. Then comment on up#198 with what shipped, and leave it open for the custom-event kill switch and `remote_ab_name` / `test_remote`.

**S28.** Verify: in a game-template build on an Android device, with prefix `SFP` and the test key `SFP_Ads_Parameters` holding the default branch from `remote-config.mjs show Ads` — look for: first launch logs `remote_config_fetch` with `in_time` true; the cheat menu shows `ads-def-r1` from `firebase`; a changed value applies only after a relaunch; "Fetch and apply now" applies it at once.

### Stage 3: Game configs package

**S29.** New package `com.iecgames.configs`, created with `new-package.mjs`.
- **Dependencies:** core (the stage 2 version) and `com.unity.nuget.newtonsoft-json` 3.2.2.
- **Runtime**, per §4.4:
  - the attributes and base classes;
  - `ConfigTable<T>` with a Newtonsoft converter that writes it keyed by `id`;
  - RFC 7396 apply and diff;
  - the path rule, schema skip, range checks, `Validate()`, and the drop-top-layer fallback;
  - `ConfigReport` (layers applied, with source and id; rejected entries with reasons);
  - `Configs`, `ConfigsStartupComponent`;
  - `SetCheatPatch`, which lasts for the session only.
- **Editor:**
  - `ConfigManifestWriter` (`[InitializeOnLoad]`, `TypeCache`) writes `Assets/_Project/Config/iec-configs.json` only when its content changes;
  - `ConfigEditing` loads a config into a `ScriptableObject` wrapper with `[SerializeReference]` for inspector drawing, saves back to JSON with keys in the build file's order, and gives a merge-patch diff between two JSON texts;
  - `ConfigsBuildCheck` (`IPreprocessBuildWithReport`) deserializes every build document and fails the build on type, range or `Validate()` errors.
- README and CHANGELOG.

**S30.** Tests: see §6 T8–T9. Run `node scripts/package.mjs check`.

**S31.** Deliver: merge — the unity-packages part of stage 3. Open the issue in iecgames/unity-packages titled "Configs: export ScriptableObject configs to JSON ([GameConfigSource]) for maze-flow". It describes option B from the discussion (keep the `.asset`, export to `configs/<name>.json` on save and on build) and links the stage 3 PR.

**S32.** Publish: com.iecgames.configs

**S33.** game-template:
1. **Packages:** add `com.iecgames.configs` to the manifest, then resolve as in S8.
2. **Startup:** add `new ConfigsStartupComponent()` after AbTests.
3. **Files:** add `Config/iec-configs.settings.json` (`{ "sheetUrl": "" }`) and an empty manifest.
4. **`scripts/configs.mjs`**, with the libs `lib/configs.mjs`, `lib/merge-patch.mjs` (apply and diff, the same rules as C#) and `lib/xlsx-write.mjs`:
   - `list`
   - `generate`: `GameConfigs.Generated.cs` handles (`public static DailyRewardConfig DailyReward => Configs.Get<DailyRewardConfig>();`) and `configs.link.xml`.
   - `check`: the manifest against the generated files and the docs; each JSON's types, ranges and enum values against the manifest; tables are objects.
   - `new <name> --class <ClassName> [--sheet <Tab>]`: writes `Scripts/Runtime/Configs/<ClassName>.cs`, a skeleton with `[GameConfig(name, 1, Sheet=…)]`, and `Config/Resources/configs/<name>.json` containing `{"schema":1}`.
   - `sheet-url <url>`
   - `import <name|all> [--yes]`: downloads as at `gd-sheet.mjs:406`, reads with `readWorkbook`, uses the §4.4 sheet layout, prints a diff, and writes only with `--yes` or after an interactive confirm. Sheet-sourced files are then checked.
   - `sheet-create <name> [--out <file.xlsx>]` and `sheet-update <name> [--out]`: write an xlsx with the tabs for that config (header, types row, current values), list validations for enum and bool columns, and range validations from min and max. It prints how to import it in Google Sheets ("File > Import > Upload > Insert new sheet" or "Replace current sheet").
   - `docs [<name>]`: writes `docs/configs/<name>.md` with each field's path, type, default, range, enum values and tooltip, plus the sheet tab and the Firebase key `<PREFIX>_<Name>_Parameters`. `check` reports when it's out of date.
   - `remote-diff <name> --against <git-ref> [--branch <b>]`: diffs the build document at that ref against the current one and writes the result through `remote-config.mjs set-patch` with the config's schema.
5. **Remote and build checks:** extend `remote-config.mjs check` so config Names count in the collision check, and so config patches are checked for schema and paths against the manifest and the build documents. Add `configs.mjs check` to `scripts/check-build-config.mjs`.
6. **Flow:** add `configs` to `iec-flows.mjs` and `iec.mjs` (label "Configs  list, new, import from sheet, sheet tab and docs generators, remote diff, check"), with a help line and a README Tools row (`eng.playbook.game-configs`).

**S34.** game-template Editor:
1. **Menu items:**
   - `IEC/Configs/Edit configs...` (`ConfigsWindow.cs`);
   - `IEC/Configs/Import from sheet...` (runs `configs.mjs import`);
   - `IEC/Configs/New config...` (runs `configs.mjs new`).
2. **The window:**
   - **Left:** the list with its check status.
   - **Right:** the inspector through `ConfigEditing`. A config with a `sheet` is read only, with Open sheet and Import from sheet. A file-sourced config has Save.
   - **Preview as:** Build, or a remote branch from `remote-config.mjs show --json`. Changed fields are marked with their layer.
   - **Make remote patch:** diffs the preview copy against the build document and calls `remote-config.mjs set-patch`.
3. **Cheats:** add `Scripts/Runtime/ConfigCheats.cs`, section "Configs": per config, the layers applied with source and id, and rejected entries. In development builds, a Text field "Load patch from file" (a path under `persistentDataPath`) that calls `SetCheatPatch`.

**S35.** knowledge: add the playbook `eng.playbook.game-configs` (declare a config, the sheet layout, import, generators, the Editor window, remote patches by schema, build checks), and update the remote-config playbook to cover config keys.

**S36.** Deliver: merge — game-template and knowledge for stage 3.

**S37.** Verify: in the game-template Editor, run `IEC/Configs/New config...` for `daily_reward`, add the fields from the discussion, then Edit configs — look for: the table shows as rows with inspector controls; Save writes `days` keyed by id; Preview as a remote branch marks changed fields; a `cycleDays` out of `[Range]` shows an error on that field and fails a build.

### Stage 4: A/B integration

**S38.** Core settings and A/B:
1. **Precedence:** add `SettingSource.AbVariantRemote` last. Set `SettingsService.Priority` (:11-14) to D20's order. `SetLayer` accepts AbVariantRemote. Update the comments at `ISettingsService.cs` and `SettingSource.cs`.
2. **Catalog:** `AbModels` and the catalog parser read `configs` and `resultConfigs` as raw JSON per config.
3. **`AbTestService`:**
   - it takes an optional `IRemoteConfigService` and `RemoteSettingsLayer`;
   - it reads `Ab_Control` before `AssignCohort` (:57) and applies §4.5 (ratios, force, stop, winner, `Control`, `EffectiveLabel`, `IsRunning`);
   - `ApplyLayers` (:317-349) also fills AbVariantRemote from the settings groups' `ab[EffectiveLabel]` and sets `RemoteSettingsLayer.SetFrozenKeys`;
   - it implements the new `IAbTestService` members;
   - it logs `ab_control_applied` and sets `AB_Patch` next to `AB_Version` (around :142);
   - it adds `control` to the assignment event;
   - it re-applies on `IRemoteConfigService.Applied`.
4. **`AbTestsStartupComponent`:** `Requires` gains `IRemoteConfigService`, and it passes `RemoteSettingsLayer`. A game without remote config still works: `RemoteConfigStartupComponent` with no providers is ready at once.
5. Bump core, with the CHANGELOG and README.

**S39.** `com.iecgames.configs`: the AbResult, AbVariant and AbVariantRemote layers from `IAbTestService` (`ResultConfigPatches`, `VariantConfigPatch`, `ab[EffectiveLabel]` of the config's remote value), the frozen-path removal from the Remote patch, and the report showing each layer. `ConfigsStartupComponent` requires `IAbTestService` too. Bump the version, with the CHANGELOG.

**S40.** Tests: see §6 T10–T12. Run `node scripts/package.mjs check`.

**S41.** Deliver: merge — the unity-packages part of stage 4.

**S42.** Publish: com.iecgames.core, com.iecgames.configs

**S43.** game-template:
1. **Packages:** bump core and configs, then resolve. Move `ConfigsStartupComponent` after AbTests if it isn't already.
2. **`lib/ab-tests.mjs` / `lib/ab-settings.mjs`:**
   - validate `configs` and `resultConfigs` (a known config, a matching schema, paths in the build document);
   - `end --winner N` writes N's `configs` into `resultConfigs`, using the build values for paths only other variants patch;
   - `end` gains `--fold-remote yes|no` (asked interactively, default yes): it folds the default branch's `ab[<N label>]` changes into `result` and `resultConfigs`, then removes those entries.
3. **`ab-tests.mjs` new commands:**
   - `config <test> <variant> <config> --file <patch.json> | --clear`
   - the `remote` group, writing the §4.3 files through `lib/remote-config.mjs`:
     - `remote ratios <test> <variant>=<n>...`
     - `remote force <test> <variant|--clear>`
     - `remote stop <test> [--clear]`
     - `remote winner <test> <variant|--clear>`
     - `remote patch <test> <variant|all> <setting-key> <value> [--clear]`
     - `remote patch-config <test> <variant|all> <config> --file <patch.json> [--clear]`

     `all` writes one entry per variant label. Every patch change raises the test's single `rev` in all of its `ab` entries.
4. **Warnings (not errors):**
   - changing ratios mid-test;
   - patching a running test splits its data at rev N;
   - after a patch, two variants are identical on a path;
   - a patch only on the lowest-numbered (control) variant;
   - a new patched key joins the freeze.
5. **`remote-config.mjs check`:**
   - `Ab_Control` entries for tests that are unknown or already have a result in this build;
   - a remote `winner` that disagrees with the build's ended result;
   - stale `ab` entries;
   - `branch add --experiment` branches whose changes touch frozen paths of a running test (error).
6. **Flow:** `abtests` in `iec-flows.mjs` gets a "Remote control" submenu.

**S44.** game-template Editor:
- **`IEC/A/B tests/Remote control...`** (`AbRemoteWindow.cs`):
  - per test: ratios, force, stop and winner;
  - per variant, plus All: setting patches with type-aware fields, and Edit config patch, which opens `ConfigsWindow` preview as that cohort;
  - the warnings above, Copy value for `SFP_Ab_Control_Parameters` and for each feature key, and Mark published.
- **The `AbTestsWindow` Tests tab** gets a "Config patches" panel per variant: the patched paths, Edit (preview as that variant, then `ab-tests.mjs config`) and Clear.
- **`ConfigsWindow` Preview as** gains an A/B cohort picker.
- **`AbCheats`** adds Info rows: Control, Effective label, Running, AB_Patch, frozen keys; and a Toggle "Ignore variant patches this session", which clears the AbVariantRemote layers of settings and configs for the session.

**S45.** knowledge:
- **A/B playbook** (`eng.playbook.ab-tests-and-releases`), new steps:
  - the layer order;
  - the freeze;
  - remote control (stop, winner, ratios, force);
  - cohort patches and `rev`, with the rule "compare variants only within the same rev";
  - variant config patches;
  - ending with `--fold-remote`;
  - Firebase experiments only on paths no running test uses.
- **Tracking plan:** add `control`, `ab_control_applied` and `AB_Patch`. Mark `firebase_exp` (:50, :251) as set by Firebase itself for console experiments.
- **Migration plan:** row :57 done.

**S46.** Deliver: merge — game-template and knowledge for stage 4. Then comment on up#199 with what shipped (`ab_control`, cohort patches, the experiment rule) and close it.

**S47.** Verify: in a game-template development build on a device with a two-variant test and `remote patch` on one variant pasted into Firebase — look for: after a relaunch, only that variant's players get the patched value and `ab_control_applied` (action patch); a general remote value for a frozen key doesn't reach the control group; `remote stop` returns test players to build + result + remote at the next launch, with `AB_Version` unchanged.

### 6. Tests
Unity tests are EditMode, in `UP/com.iecgames.core/Tests/Editor/` or each package's `Tests/Editor/`, using `MemorySecureStore`, `FakeAppClock`, `ManualScheduler`, `FakeAnalyticsProvider` and fake getters/providers.

**T1. `ServerClockTests`**
- A reply of `1793788852` gives that UTC time plus half the round trip.
- `UtcNow` advances with the fake realtime.
- The IEC source fails and the Date source wins, with `SourceName "date"`.
- Both fail, then the retry delays are 2, 4, 8 … 60, 60.
- A reply 11 years off is rejected.
- The device clock is moved back 1 h after a saved trusted value: `ClockMovedBack` is true and the time continues from the trusted value.
- Moved back by only 4 minutes: not flagged.
- A shift of +1 day moves `UtcNow` but not the saved trusted value; resetting it doesn't flag `ClockMovedBack`.
- `UseDeviceClock` returns the device time.
- The cheat is reloaded by a new instance on the same store.
- Pause for ≥ 300 s resyncs; a pause of 299 s doesn't.
- `server_time_sync` is logged once per session; `clock_moved_back` once.

**T2. `TimeSourceTests`**
- The body `" 1793788852\n"` is parsed.
- `"abc"`, `"-5"` and an empty body fail.
- `Date: Thu, 05 Nov 2026 04:00:52 GMT` is parsed with the invariant culture.

**T3. Cheats `BadgeTests`**
- `SetBadge` before the host exists is shown once the host is created.
- Null text removes the badge.
- Two badges stack.

**T4. `RemoteConfigServiceTests`**
- A staged snapshot is promoted at start.
- First launch with a provider answering at 1 s gives Fresh and the values apply; answering at 4 s gives BuildOnly and the values are staged.
- On a later launch the active snapshot applies at once, and a fetch updates only staged.
- Priority: a 200-priority provider wins its Names, and the 100-priority one keeps the others.
- A failed provider keeps its previous entry.
- Equal priorities: the second is dropped with an error.
- A provider's values over 65,536 characters fail with `size`.
- The throttle skips a fetch within 600 s; `FetchNow` bypasses it.
- `only.versions ["2.5.0"]` on app 2.6.0 is absent, with `Reject(version)`.
- `IgnoreThisSession` makes `TryGet` false and raises `Applied`.
- `RC_Version` is `ads-def-r2.dr-def-r5` for those ids, `h` plus 8 hex when over 36 characters, and `-` for none.
- `remote_config_applied` is logged only when the ids change.

**T5. `RemoteNamesTests`**
- `ads.inter_interval` → `Ads` and `inter_interval`.
- `daily_reward.cycle` → `Daily_Reward` and `cycle`.
- `rating.show_level` with group `Other` → `Other` and `rating.show_level`.
- `volume` → `Other` and `volume`.
- `ForConfig("daily_reward")` = `Daily_Reward`.

**T6. `RemoteSettingsLayerTests`**
- `{"patches":{"1":{"inter_interval":60}}}` gives `ads.inter_interval` = 60 with source Remote.
- `"sixty"` is rejected with `type` and keeps the default.
- An unknown field is rejected with `unknown`.
- `Define` with `remoteGroup` reports `SettingInfo.RemoteGroup`.
- The existing `SettingsTests` still pass in stage 2.

**T7. `FirebaseRemoteProviderTests`** (in `com.iecgames.remoteconfig.firebase/Tests/Editor`, the pure mapping only)
- `SFP_Daily_Reward_Parameters` → `Daily_Reward`.
- `WLP1_Ads_Parameters` and `SFP_Other` are skipped.
- The same values give the same version, and NotModified when it matches.

**T8. `ConfigResolveTests`**
- The build document with `days` keyed by id loads into `ConfigTable` in id order (`"2"` before `"10"`).
- A remote patch `days.7.coins=400` keeps `gems`.
- Schema 3 against build schema 2 is skipped.
- A new field `days.7.bonus` is dropped with `path`.
- A new row `"8"` is dropped without `[ConfigAllowNewRows]` and accepted with it.
- `cycleDays = 99` with `[Range(1,30)]` drops the remote layer and the build value is used, with `Reject` called.
- `Validate()` failing drops the layer.
- A cheat patch is above remote.

**T9. `MergePatchTests`** (C#) and `scripts/merge-patch.test.mjs` (Node), with the same cases:
- the RFC 7396 examples;
- diff then apply round-trips;
- `null` deletes a row.

**T10. Settings precedence**
- `SettingsTests.CheatBeatsVariantBeatsResultBeatsRemoteBeatsDefault` (:35) is renamed and changed to the new order: Cheat > AbVariantRemote > AbVariant > Remote > AbResult > Default.
- A test that a result is overridden by Remote.

**T11. `AbTestServiceTests` additions**
- Remote `force:21` for a new player gives v21 and `control=remote`.
- No `Ab_Control` gives `control=build`.
- `ratios` don't move an existing player.
- `stop` empties the variant layers, the freeze is off, the label is unchanged, and `ab_control_applied` is logged once.
- `winner:21` moves a v20 player to v21's values and `ab[AB_…_v21]`.
- An entry for a test with a result in the build is ignored.
- The freeze: a remote `ads.inter_interval=60` doesn't reach v20 when v21 sets that key, but reaches a player with no running test.
- A remote `ab` patch on v21 is above the build variant.
- A key added only by an `ab` patch is frozen for v20.
- `AB_Patch` = `AB_20261101:3`.
- A catalog with `configs`/`resultConfigs` parses, and an old catalog without them still parses.

**T12. `ConfigAbLayerTests`**
- The §7.2 worked example: build 200, result 300, remote 400, v21 600 and `ab` 550. v21 gets 550, v20 gets 300, a player with no test gets 400, and `days.1` from remote reaches everyone.

**Node tests** in `GT/scripts`, each run as `node --test scripts/<file>`:

| File | Cases |
|---|---|
| `server-time.test.mjs` | parse body and Date header; `check --json` with mocked fetch, both ok and both failed with exit 1 |
| `remote-config.test.mjs` | `init`; `set` type check; `branch add` and branch output equals default plus changes, with the id format `ads-hf250-r1`; rev raised only for branches whose output changed; `published` writes the log and clears pending; name collision; size warning above 100,000 and error above 1,000,000; template check of unknown keys, values differing and version branch order; `local` writes the Library file |
| `ab-settings.test.mjs` (extended) | `remoteGroup` validation and generated `Settings.Define(..., "Other")` |
| `configs.test.mjs` | `generate` output; `check` (type, range, enum, table-not-object, docs out of date); `import` from a fixture xlsx built with `xlsx-write`, covering the key/value tab, the table tab, dotted headers and a type mismatch error; `sheet-create` round-trips through `readWorkbook` with validations present; `remote-diff` from a temporary git repo |
| `merge-patch.test.mjs` | as T9 |
| `ab-tests.test.mjs` (extended) | `config` command; `end` with `configs` and `--fold-remote`; each `remote` command writes the expected `Ab_Control` and `ab` entries with the shared rev; the warnings; `check` errors for an experiment touching frozen paths, a winner mismatch and an unknown test |

**Commands**
- **unity-packages:** `node scripts/package.mjs check` (Node tests plus `check-packages --base origin/main`).
- **Unity, fast while fixing (slow, about 5 to 15 minutes):**
  `node scripts/test-packages.mjs --template D:/projects/wt/progression-report/game-template --package <changed package> --variant lite`
- **Unity, full, once before each Deliver step of unity-packages (slow):**
  `node scripts/test-packages.mjs --template D:/projects/wt/progression-report/game-template --package com.iecgames.core --package <other changed packages> --variant both --fresh`
- Expected: every EditMode test passes, and the full variant compiles the Firebase provider with `IEC_REMOTECONFIG_FIREBASE`.
- **game-template:** the touched `node --test scripts/<name>.test.mjs` files, then `node scripts/check-rules.mjs --base origin/main`. Expected: 0 failures.
- **knowledge:** `npm run check` (or `knowledge.bat check`). Expected: pass.

### 7. Done when
1. **Server time:** `IServerClock` is available in game-template. It syncs from the IEC endpoint with the Date fallback, guards against the clock moving back, keeps the cheats between sessions with a TIME CHEAT badge, and has the Editor and `iec.bat` endpoint checks.
2. **Remote config:**
   - It works with Firebase (prefix, `<PREFIX>_<Name>_Parameters`) and the file provider, merges by priority, and applies at the next launch with a first-launch wait of up to 3 s.
   - It fills the settings Remote layer with type checks, and logs the three events and `RC_Version`.
   - `remote-config.mjs` and its window write full branches with `id`, `only` and per-schema patches, and the publish log.
   - `check` validates the repo and a Firebase template.
3. **Configs:** `com.iecgames.configs` resolves Build, Remote and Cheat (stage 3), and AbResult, AbVariant and AbVariantRemote (stage 4) layers, with the schema, path, range and `Validate()` fallback. `configs.mjs` imports from Sheets, generates the sheet tab and docs, writes remote diffs and checks. The Edit configs window edits, previews and makes patches.
4. **A/B integration:**
   - The new precedence is in place.
   - The freeze works for settings and configs.
   - `ab_control` ratios, force, stop and winner work as in D22 and D24.
   - `ab` cohort patches only reach their label.
   - Variant `configs` and `resultConfigs` work.
   - Tracking: `control`, `ab_control_applied`, `AB_Patch`.
   - The remote commands and window work, and the experiment-path check runs.
5. **Menus:** every tool is in the `IEC/` menu and `iec.bat`, with help lines and README rows.
6. **Knowledge:** the three new playbooks, the IEC server spec, the updated A/B playbook and tracking plan, and the migration rows :57 and :83.
7. **Issues:** the ScriptableObject export issue is open; up#198 has a comment; up#199 is closed; gt#40 has a comment.
8. All the commands in §6 pass, and each stage is merged after a judge PASS.

### 8. Risks, rollback, what not to touch
**Risks**
- **Stage 4 precedence change:** shipped games' Remote layer is empty until they adopt stage 2, so there is no effect on live values. T10 guards it.
- **First-launch wait:** it delays loading on first launch by up to 3 s. Set `firstLaunchWaitSeconds` to 0 to disable it.
- **Firebase in the Editor:** the provider is registered only on Android and iOS, so the Editor uses the file provider.
- **Mirror:** the vendor tgz must match the pin, or the mirror refuses it. Recompute the hash and don't edit the package.
- **Shared Firebase budget:** the 1,000,000-character limit is for the whole project. `check` reports each game's share.
- **IL2CPP stripping:** a config type stripped by IL2CPP is covered by `configs.link.xml`. `ConfigsBuildCheck` catches type errors before a build.

**Rollback**
- Each package change is a new version: pin the previous version in the game manifest.
- Remote values are removed in Firebase, and the build values apply at the next launch.
- `ab_control` is cleared by `--clear`.

**Don't touch**
- maze-flow, shiny-loop and pi-config.
- `status --json` of the GD tooling.
- Existing `DateTime.UtcNow` callers.
- `iec-ab-tests.json` key names; the new fields are additive only.
- `SettingSource` numeric values.
- Vendor packages, which are mirrored unchanged.

**Environment rules**
- Files are CRLF: patch with Node scripts that normalise line endings.
- Never commit `_*.cjs` temp files, and never use bare `git stash`.
- Don't drive the other session's open Unity Editor. Unity commands only with an absolute `--project-path` inside `D:/projects/wt/progression-report`.

### 9. Commits
**Stage 1**
- unity-packages `core: server time (IServerClock, IEC and Date sources, guard, cheats, tracking)`: `com.iecgames.core/Runtime/Time/*`, `Startup/Components/ServerClockStartupComponent.cs`, `Tracking` events, `Editor` menu, tests, `package.json`, CHANGELOG, README.
- unity-packages `cheats: always-visible badges (Cheats.SetBadge)`: `com.iecgames.cheats/*`, tests.
- game-template `server time: startup, cheat section with badge, server-time.mjs flow`: manifest and lock, `GameBootstrap.cs`, `TimeCheats.cs`, `GameCheats.cs`, `scripts/server-time.mjs`, lib, test, `iec-flows.mjs`, `iec.mjs`, README.
- knowledge `server time playbook, tracking plan and migration row`.

**Stage 2**
- unity-packages `core: remote config service, providers, settings Remote layer, remoteGroup`: core RemoteConfig, Settings, startup component, tests, version files.
- unity-packages `vendor: pin com.google.firebase.remote-config 13.17.0`: `config/vendor-registries.json`.
- unity-packages `remoteconfig.firebase: Firebase Remote Config provider`: the new package.
- unity-packages `tracking-set: add remoteconfig.firebase`.
- game-template `remote config: startup, cheats, remoteGroup in settings`: manifest and lock, `GameBootstrap.cs`, `RemoteConfigCheats.cs`, `iec-remote-config.json`, `lib/ab-settings.mjs`, `ab-tests.mjs`, tests.
- game-template `remote-config.mjs: branches, values, publish log, Firebase template check, menus`: scripts, lib, tests, Editor windows, flows, README.
- knowledge `remote config playbook, IEC server spec, tracking plan, A/B playbook pitfall, migration row`.

**Stage 3**
- unity-packages `configs: GameConfig documents with merge patches, checks and Editor support`: the new package.
- game-template `configs: startup, configs.mjs (import, generators, docs, remote diff, check), Edit configs window, cheats`: manifest and lock, `GameBootstrap.cs`, the Config files, scripts, libs, tests, Editor, Runtime cheats, `check-build-config.mjs`, `remote-config` lib collision and patch checks, flows, README.
- knowledge `game configs playbook and remote-config playbook update`.

**Stage 4**
- unity-packages `core: A/B layer order, freeze, ab_control, cohort patches, variant config patches, tracking`: core Settings and AbTests, startup component, tests, version files.
- unity-packages `configs: A/B layers and freeze`.
- game-template `ab-tests: config patches, remote control commands, checks`: libs, `ab-tests.mjs`, `remote-config` lib checks, tests, flows.
- game-template `A/B remote control window, config patch panel, cheat rows`: Editor windows, `AbCheats.cs`, `ConfigsWindow.cs`, manifest and lock, `GameBootstrap.cs`.
- knowledge `A/B playbook, tracking plan and migration row for remote A/B`.

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 Core `Runtime/Time/` (new asmdef `Iec.Core.Time`, which references `Iec.Core` and `Iec.Core.Storage`):
- [ ] S2 Core: `ServerClockStartupComponent` in `Runtime/Startup/Components/`.
- [ ] S3 Core Editor: menu `IEC/Server time/Test endpoint`.
- [ ] S4 `com.iecgames.cheats`: add `Cheats.SetBadge(string id, string text)`, where null or empty text removes the badge.
- [ ] S5 Tests in unity-packages: see §6 T1–T3. Run `node scripts/package.mjs check`.
- [ ] S6 Deliver: merge — the unity-packages part of stage 1.
- [ ] S7 Publish: com.iecgames.core, com.iecgames.cheats
- [ ] S8 game-template:
- [ ] S9 game-template `scripts/server-time.mjs`, plus `lib/server-time.mjs` holding the pure parsing:
- [ ] S10 knowledge:
- [ ] S11 Deliver: merge — game-template and knowledge for stage 1. Then comment on gt#40 that server time has shipped (with the P
- [ ] S13 Core `Runtime/RemoteConfig/` (asmdef `Iec.Core.RemoteConfig`, which references Core, Storage, Settings and Analytics), p
- [ ] S14 Core settings: `Settings.Define<T>(string key, T defaultValue, string remoteGroup = null)`, and `SettingInfo.RemoteGroup
- [ ] S15 Core: `RemoteConfigStartupComponent` in `Runtime/Startup/Components/`.
- [ ] S16 unity-packages: add the sha256 pin of `com.google.firebase.remote-config@13.17.0` to `config/vendor-registries.json` (Go
- [ ] S17 Mirror: all; extras com.google.firebase.remote-config@13.17.0
- [ ] S18 New package `com.iecgames.remoteconfig.firebase`, created with `scripts/new-package.mjs`.
- [ ] S19 `com.iecgames.tracking-set`: add the new package, bump the version, and update the CHANGELOG and README. Check `KN eng.r
- [ ] S20 Tests in unity-packages: see §6 T4–T7. Run `node scripts/package.mjs check`.
- [ ] S21 Deliver: merge — the unity-packages part of stage 2.
- [ ] S22 Publish: com.iecgames.core, com.iecgames.remoteconfig.firebase, com.iecgames.tracking-set
- [ ] S23 game-template:
- [ ] S24 game-template `scripts/remote-config.mjs`, plus `lib/remote-config.mjs` with pure operations (model `ab-tests.mjs` and `
- [ ] S25 game-template Editor, both shelling out through `NodeRunner` like `AbTestsWindow.cs:83,406-429`:
- [ ] S26 knowledge:
- [ ] S27 Deliver: merge — game-template and knowledge for stage 2. Then comment on up#198 with what shipped, and leave it open fo
- [ ] S29 New package `com.iecgames.configs`, created with `new-package.mjs`.
- [ ] S30 Tests: see §6 T8–T9. Run `node scripts/package.mjs check`.
- [ ] S31 Deliver: merge — the unity-packages part of stage 3. Open the issue in iecgames/unity-packages titled "Configs: export S
- [ ] S32 Publish: com.iecgames.configs
- [ ] S33 game-template:
- [ ] S34 game-template Editor:
- [ ] S35 knowledge: add the playbook `eng.playbook.game-configs` (declare a config, the sheet layout, import, generators, the Edi
- [ ] S36 Deliver: merge — game-template and knowledge for stage 3.
- [ ] S38 Core settings and A/B:
- [ ] S39 `com.iecgames.configs`: the AbResult, AbVariant and AbVariantRemote layers from `IAbTestService` (`ResultConfigPatches`,
- [ ] S40 Tests: see §6 T10–T12. Run `node scripts/package.mjs check`.
- [ ] S41 Deliver: merge — the unity-packages part of stage 4.
- [ ] S42 Publish: com.iecgames.core, com.iecgames.configs
- [ ] S43 game-template:
- [ ] S44 game-template Editor:
- [ ] S45 knowledge:
- [ ] S46 Deliver: merge — game-template and knowledge for stage 4. Then comment on up#199 with what shipped (`ab_control`, cohort
## For you after the flow
- S12 Verify: in the game-template Editor, enter Play mode and open the cheat menu (Backquote), section Server time — look for
- S28 Verify: in a game-template build on an Android device, with prefix `SFP` and the test key `SFP_Ads_Parameters` holding t
- S37 Verify: in the game-template Editor, run `IEC/Configs/New config...` for `daily_reward`, add the fields from the discuss
- S47 Verify: in a game-template development build on a device with a two-variant test and `remote patch` on one variant paste
