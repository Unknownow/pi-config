<!-- pi-workflow plan v1 flow=20261031-1306-keep-the-workflow-prompt-sections-stable-a59a -->
## Plan: Keep the workflow prompt sections stable so pi-claude-bridge finds its saved prompt

### 1. Goal and non-goals
**Goal:**
- Stop `prompt-capture: no capture for this …-char system prompt` errors (`prompt_capture_unresolved` in `~/.pi/agent/claude-bridge-diag.log`) after the flow is switched on or off, or after folders are added or removed.
- The workflow extension never deletes its custom prompt sections `workflow` and `workspace` once a session starts. Their position therefore stays the same in pi's patch replay and in pi's prompt builder.
- After delivery, give the user a read-only inventory of everything the pi harness currently loads.

**Non-goals:**
- No changes to `pi-claude-bridge` or pi itself.
- No upstream issue.
- No fix for sessions that already switched the flow on and off.
- No changes to other extensions' sections (`mcp_servers`).

### 2. User decisions
- D1: Fix it in the workflow extension by always keeping the `workflow` and `workspace` sections present, never deleting them.
- D2: No upstream issue for `pi-claude-bridge`.
- D3: The fix comes with a regression test and an update to backlog item D24 in `docs/workflow-improvements.md`.
- D4: After the fix, list everything the harness uses: extensions, rules, code and config.
- D5: Deliver like recent flows: feature branch, pull request, merge.

### 3. Facts the executor needs
- `pi/agent/extensions/workflow/index.ts:3075-3108`, `before_agent_start` handler:
  - `opts.sections.workspace` is set only `if (folders.length || touched.length)` (3079-3096). Otherwise the section is missing from that run, and pi's section diff sends a removal patch.
  - Lines 3106-3107 set `sections.workflow` when `phaseText` is truthy and `delete` it otherwise.
- `pi/agent/extensions/workflow/prompts.ts:196-202`: `phaseSection(...)` returns `string | null`, and `null` for any phase other than discuss, plan, execute or test. Its only caller is `index.ts:3098`.
- `pi/agent/extensions/workflow/prompts.ts:366-378`: `workspaceSection(cwd, folders, touched, rules = [])`. Called with empty arrays, it returns the `Working folder:` line plus the two fixed lines ("Use absolute paths…", "The judge reviews…"). That is valid and accurate when no folders are added.
- `pi/agent/extensions/workflow/prompts.test.ts:50-52`: the test "phaseSection is null outside plan, execute and test" asserts `null` for `"off"`. It must change.
- `prompts.test.ts:148`: an existing `workspaceSection` test, to model the new one on. Tests run with `node --experimental-strip-types --test <file>` (header line 1 of the test files).
- No test file imports `index.ts`, so the handler itself has no unit test. Regression cover goes through the pure prompt functions.
- Where the order breaks:
  - pi-ai replays section patches into a `Map`: a removed and re-added section moves to the end (`~/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-ai/dist/utils/transcript.js:58-75`).
  - pi's builder uses the insertion order of `systemPromptOptions.sections` (`pi-coding-agent/dist/core/system-prompt.js:68`).
  - The bridge lists custom sections in replay order (`~/.pi/agent/npm/node_modules/pi-claude-bridge/src/transcript.ts`, comment above `SECTION_RANK`).
  - A flow toggle calls `setActiveTools` (`index.ts:520,556`), which rebuilds pi's base options with an empty `sections` object (`agent-session.js:1287-1313`).
- Backlog: `docs/workflow-improvements.md:124` (D24 row, "Idea only"), `:190` (D24 measurement row), `:5` (Status line), `:7-11` (rules for keeping the file current).
- Install: `./pi-config.sh import` copies the repo config to this machine. `./pi-config.sh status` shows what differs (`pi-config.sh:5-7`). The live copy is `~/.pi/agent/extensions/workflow`.

### 4. Design
- **`phaseSection`:** return type changes from `string | null` to `string`. For any phase other than discuss, plan, execute or test it returns a new exported constant:

  ```ts
  export const NO_WORKFLOW = "No workflow is active. Instructions from an earlier workflow phase no longer apply.";
  ```

- **`before_agent_start` contract:** after the handler, `sections.workspace` and `sections.workflow` are always non-empty strings, set in that order (workspace, then workflow).
  - The added-folder context-file loop (`loadProjectContextFiles`, `opts.contextFiles.push`) still runs only when folders exist.
  - `workspaceSection(ctx.cwd, folders, touched, listed)` is called every time. `listed` is empty when there are no folders.
  - No `delete` of either section is left.
- **Why the order now holds:** both sections exist from the first message of a session. Content changes keep their position in pi's replay, and they are set before the MCP extension's `mcp_servers`. If `mcp_servers` is removed and later re-added, it goes last in both the replay and the builder.
- **Compatibility and limits:**
  - Sessions that switched the flow on and off before this fix keep the old order in their history and stay broken. Start a new session.
  - Cost: about 300 extra characters per prompt (workspace text plus the note) when the flow is off or no folders are added.
- **Rejected options:**
  - Patching the bridge's lookup: not our code, and an npm update would overwrite it.
  - An upstream issue: D2.
  - Reordering sections to copy the replay: our handler can't see the transcript replay.
  - A new `NO_WORKSPACE` text: `workspaceSection` with empty lists is already accurate.

### 5. Steps

**S1.** In `pi/agent/extensions/workflow/prompts.ts:196-202`:
- Add the exported `NO_WORKFLOW` constant from §4 next to the phase constants (near `DISCUSS_PHASE`, `prompts.ts:70`).
- Make `phaseSection` return it instead of `null`, with return type `string`.
- Add a one-line comment saying why it is never empty. Model the comment on the style of nearby comments, e.g. `prompts.ts:227`.

**S2.** In `pi/agent/extensions/workflow/index.ts:3075-3108` (`before_agent_start`):
- Keep the folder context-file loop inside `if (folders.length)` or the existing condition.
- Move the `opts.sections.workspace = prompts.workspaceSection(ctx.cwd, folders, touched, listed)` assignment outside the condition, so it runs on every call. Declare `listed` before the condition.
- Replace lines 3106-3107 with an unconditional `event.systemPromptOptions.sections.workflow = phaseText`.
- Add a short comment above the two assignments: pi's patch replay moves a deleted and re-added section to the end, which then no longer matches the prompt pi-claude-bridge saved (`prompt_capture_unresolved`). So both sections are always set, in this order.
- Make sure TypeScript still compiles: `phaseText` is now `string`.

**S3.** Update the tests in `pi/agent/extensions/workflow/prompts.test.ts`. Details in §6.

**S4.** Update `docs/workflow-improvements.md` per its rules (`:7-11`):
- **D24 row (`:124`):** replace "Idea only:" with the confirmed cause and a **Done:** note.
  - Cause: pi 1.4's section replay puts a deleted and re-added custom section last, while the builder uses insertion order. The flow toggle's `setActiveTools` resets the base sections, and `index.ts` `before_agent_start` deleted `workflow` and skipped `workspace`.
  - The two candidate causes the row lists today were not it.
  - Done: `workflow` and `workspace` are always set (`prompts.ts` `NO_WORKFLOW`, `index.ts` `before_agent_start`). Sessions toggled before the fix need a new session.
  - Keep the remaining columns consistent with other Done rows.
- **Status line (`:5`):** add D24 to the implemented list, e.g. "D26, D27 and D28 are implemented" becomes "D24, D26, D27 and D28 are implemented".
- **Measurement row (`:190`):** label it "prompt capture", not "(idea)". Keep the metric and say "Implemented, not measured yet", like D27/D28 at `:193-194`.

**S5.** Run the tests in §6 and fix any failures.

**S6.** Deliver: merge — the stable prompt sections fix and the D24 backlog update, on a feature branch such as `fix/workflow-stable-prompt-sections`, after a judge pass.

**S7.** Install the merged change on this machine with `./pi-config.sh import`. Then run `./pi-config.sh status` and confirm that no file under `extensions/workflow` differs from the repo. Ignore the `README.md.bak-*` files, which exist only in the live copy.

**S8.** Verify: start a new pi session (`/new`), switch the flow to discuss (`/flow`), send a message, switch the flow off, send a message, switch it back on, and send a message — look for: every turn answers, and `grep -c prompt_capture_unresolved ~/.pi/agent/claude-bridge-diag.log` stays at 39, the count before the fix.

**S9.** Inventory (read-only, a report to the user, no file changes). List with paths:
- The pi version and install path (`~/.pi/agent/install/releases/`, the active one).
- Packages in `~/.pi/agent/settings.json` and their versions (e.g. `pi-claude-bridge` 0.9.3 in `~/.pi/agent/npm/package.json`).
- `extensions` entries (`D:\projects\pi-config\extension`) and the auto-discovered extensions in `~/.pi/agent/extensions/` (workflow, worktree, sandbox).
- pi's built-in extensions that are active (for example MCP).
- MCP servers (from pi's `mcp.json`).
- Rules files: global `~/.pi/agent/AGENTS.md`, the project `AGENTS.md` files.
- Skills.
- Config files: `settings.json`, `workflow.json` (roles and models), and any others found.
- For each extension, one line with its tools and event hooks. Find these by grepping `registerTool`/`pi.on(` in each extension's entry file.

### 6. Tests
All in `pi/agent/extensions/workflow/prompts.test.ts`. Import `NO_WORKFLOW` in the import list at line 4.
- **Changed:** rename "phaseSection is null outside plan, execute and test" (`:50`) to "phaseSection gives the inactive note outside discuss, plan, execute and test".
  - Input: `phaseSection("off", SECTION_OPTS)` and `phaseSection("", SECTION_OPTS)`.
  - Expected: both are `NO_WORKFLOW`, and `NO_WORKFLOW` is a non-empty string.
- **New:** "phaseSection is never empty, so the workflow section is never deleted".
  - Input: each of `"off"`, `"discuss"`, `"plan"`, `"execute"`, `"test"`.
  - Expected: a non-empty string for each.
- **New:** "workspaceSection with no folders still gives the working folder".
  - Input: `workspaceSection("/w", [], [], [])`.
  - Expected: starts with `Working folder: /w`, has no `Added folders` line, non-empty.
- Commands (fast, a few seconds each):
  - `node --experimental-strip-types --test pi/agent/extensions/workflow/prompts.test.ts`
  - Then the whole suite once: `node --experimental-strip-types --test pi/agent/extensions/workflow/*.test.ts`
  - Expected: `# fail 0`.

### 7. Done when
- The workflow extension no longer deletes or skips the `workflow` or `workspace` section. Both are set on every `before_agent_start` (D1).
- The workflow test suite passes with the changed and new tests (D3).
- D24 in `docs/workflow-improvements.md` is marked done in its row, the Status line and the measurement row, in the same commit as the code (D3).
- The change is merged through a pull request from a feature branch (D5), with no bridge changes and no upstream issue (D2).
- The live copy under `~/.pi/agent/extensions/workflow` matches the repo.
- In a new session, switching the flow on and off adds no `prompt_capture_unresolved` entry. This is a person's check (S8).
- The inventory has been reported to the user (D4).

### 8. Risks, rollback, what not to touch
- **Risks:**
  - About 300 extra prompt characters when the flow is off.
  - Sessions toggled before the fix stay broken; tell the user to start a new session.
  - Another extension that deletes its own custom section could still cause the error; out of scope.
- **Rollback:** revert the merge commit and run `./pi-config.sh import` again.
- **Don't touch:**
  - `~/.pi/agent/npm/node_modules/pi-claude-bridge` and the pi install.
  - Other phase texts.
  - The `contextFiles` loading behaviour for added folders.
  - `refilterTools` and `setActiveTools` logic.

### 9. Commits
- `fix(workflow): always set the workflow and workspace prompt sections (D24)`: `pi/agent/extensions/workflow/prompts.ts`, `pi/agent/extensions/workflow/index.ts`, `pi/agent/extensions/workflow/prompts.test.ts`, `docs/workflow-improvements.md`.

<!-- pi-workflow:status -->
## Checklist
- [x] S1 In `pi/agent/extensions/workflow/prompts.ts:196-202`:
- [x] S2 In `pi/agent/extensions/workflow/index.ts:3075-3108` (`before_agent_start`):
- [x] S3 Update the tests in `pi/agent/extensions/workflow/prompts.test.ts`. Details in §6.
- [x] S4 Update `docs/workflow-improvements.md` per its rules (`:7-11`):
- [x] S5 Run the tests in §6 and fix any failures.
- [x] S6 Deliver: merge — the stable prompt sections fix and the D24 backlog update, on a feature branch such as `fix/workflow-st
- [x] S7 Install the merged change on this machine with `./pi-config.sh import`. Then run `./pi-config.sh status` and confirm tha
- [x] S9 Inventory (read-only, a report to the user, no file changes). List with paths:
## For you after the flow
- S8 Verify: start a new pi session (`/new`), switch the flow to discuss (`/flow`), send a message, switch the flow off, send
## Outcome
2026-10-31T06:11:29.266Z — ok: master, 2 commits since the review base, PR #19 MERGED https://github.com/Unknownow/pi-config/pull/19 · 1 human check(s) for you (see the card)
