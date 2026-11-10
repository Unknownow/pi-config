<!-- pi-workflow plan v1 flow=20261111-0224-quiet-tools-mode-hide-finished-tool-rows-ac44 -->
## Plan: Quiet tools mode: hide finished tool rows with a shortcut

**Goal:** add a new extension, `quiet-tools`. When quiet mode is on, finished tool rows (bash, read, judge, explore, codemode and so on) take no lines in the TUI transcript. While a tool is running it shows one dim line. That leaves your messages, the assistant's text and custom messages. `alt+o` or `/quiet` turns quiet mode on or off. With quiet mode off, tool rows look exactly as they do today.

**Non-goals:**
- Not hiding thinking blocks. The built-in `Ctrl+T` / `hideThinkingBlock` already does that, and extensions have no API to set it.
- Not hiding assistant text between tool calls. A markdown transformer can't tell the final answer from interim text.
- Not hiding custom messages from other extensions, such as the workflow's judge report and nudges.
- Not changing other extensions.
- Quiet mode is not saved between sessions.

**User decisions:**
- D1. A shortcut toggles it. I checked for conflicts with pi, Windows Terminal and cmd/PowerShell; see Facts. I chose **`alt+o`**, which pairs with `Ctrl+O`.
- D2. Finished tool rows are fully hidden, so you scroll only through answers. Normal mode must look exactly as it does today.
- D3. Quiet mode is **on** at the start of every session. My recommendation from the discussion was "turn collapsed mode on at startup".

### Facts the executor needs
In the pi 1.5.2 install, relative to `C:/Users/unkno/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent/`:

**Hooks the extension uses:**
- `pi.registerToolRenderer((toolName, next) => def)` is described in `docs/extensions.md:2123`. Resolvers are chained in `dist/core/extensions/runner.js:550-553`, and the object you return is used as is.
- The TUI resolves a definition once per tool row (`dist/modes/interactive/interactive-mode.js:1816`; callers at `:2961`, `:3032`, `:3380`) and passes it to the `ToolExecutionComponent` constructor.

**How a tool row renders** (`dist/modes/interactive/components/tool-execution.js`):
- `:57`: the constructor reads `renderShell` once to choose its child. `"self"` attaches `selfRenderContainer`; otherwise it attaches `contentBox` (a `Box(outputPad,1,bg)`) after a `Spacer(1)`.
- `:174` (`render`) and `:220` (`updateDisplay`) read `toolDefinition.renderShell` again every time.
  - In `"self"`, `render` draws only `selfRenderContainer`, and returns `[]` (no lines, not even the spacer) when it is empty.
  - In `"default"`, it draws Spacer + `contentBox`, which is the look you have today.
- `:65`/`:68`: `renderCall`/`renderResult` are read from the definition on every `updateDisplay`. If one is missing or throws, pi uses its built-in fallback (`:226-265`).
- `:27`/`:89`: `context.isPartial` is `true` until the final result arrives.

**Consequence for rows built while quiet mode is on:** if the first `renderShell` read returned `"self"`, `contentBox` would never be attached, and the row would stay blank after quiet mode is turned off. So the first read must return the base shell.

**Export:** `dist/core/export-html/tool-renderer.js:63-100` calls `renderCall`/`renderResult` directly and never reads `renderShell`. A wrapper whose `renderShell` was never read is therefore an export or other non-TUI use, and must always delegate.

**Refreshing the rows:**
- `ctx.ui.getToolsExpanded()` and `setToolsExpanded(x)` are in `docs/extensions.md:2978`.
- `setToolsExpanded` returns early when the value doesn't change (`interactive-mode.js:3869-3871`). Otherwise it calls `setExpanded` on every row, which runs `updateDisplay`.
- So to re-render all rows: set it to the opposite of the current value, then back.

**Shortcut and command conflicts** for `alt+o`:
- pi: no built-in binding uses `alt+o` in `docs/keybindings.md` or `dist`. pi's alt bindings are `alt+b/f/d/y/v/p/q/z`, `alt+enter`, `alt+arrows`, `alt+backspace` and `alt+delete`.
- Windows Terminal: your `settings.json` binds only `ctrl+c`, `ctrl+v` and `alt+shift+d`. WT's default alt bindings are `alt+enter`, `alt+F4`, `alt+space`, `alt+shift+d/-/+`, `alt+arrows` and `alt+shift+arrows`.
- cmd/conhost: alt bindings are `alt+enter`, `alt+space` and `alt+F4`.
- PowerShell's PSReadLine only handles keys at the PowerShell prompt. While pi runs, it reads raw input.
- `/quiet` is not a pi built-in command (`docs/slash-commands.md`), and none of this repo's extensions uses it.

**Repo conventions:**
- Extensions live in `pi/agent/extensions/<name>/` and are mirrored to `~/.pi/agent/extensions` by the sync extension. Each folder has `index.ts`, a README and `*.test.ts`, run with `node --experimental-strip-types --test`.
- Model on `pi/agent/extensions/markdown-view/` (`README.md`, `index.ts`, pure logic in `view.ts`, `view.test.ts`).
- `Text`/`Component` come from `@earendil-works/pi-tui` (`agents/render.ts:3-4`).
- The root `README.md:66` lists the extensions.

### Design
**Components:**
- `quiet.ts`: pure logic, only `import type` from pi packages, so tests run without pi installed.
- `index.ts`: the pi wiring.

**`quiet.ts` contract:**
- `quietDefinition<D>(base: D, isQuiet: () => boolean, parts: { empty(): Component; running(toolName: string, args: unknown, theme, ctx): Component }, toolName: string): D`.
  - It returns `Object.create(base, { renderShell, renderCall, renderResult })`, with all three as **getters**: never spread, so the getters survive and every other property is inherited.
  - **`renderShell`:**
    - If `base.renderShell === "self"`, always `"self"`.
    - Otherwise, the first read on this wrapper returns `base.renderShell ?? "default"` and marks the wrapper as a TUI row.
    - Later reads return `isQuiet() ? "self" : (base.renderShell ?? "default")`.
  - **`renderCall`:** when the wrapper is a TUI row and `isQuiet()` is true, a function that returns `parts.running(...)` while `ctx.isPartial` is true, and `parts.empty()` otherwise. In every other case it is exactly `base.renderCall`, which may be `undefined` so the fallback stays.
  - **`renderResult`:** when it's a TUI row and quiet, `() => parts.empty()`. Otherwise exactly `base.renderResult`.
- `summarizeArgs(args: unknown): string`. It picks the first present key out of `command, path, file_path, pattern, url, focus, question, step, code, queries, tasks, done`, then falls back to the first string value. Rules:
  - a string is used as is;
  - an array of strings becomes its first item plus ` (+N)`;
  - an array of objects with `id` becomes the ids joined by `, `;
  - anything else is `JSON.stringify`.
  - Whitespace collapses to single spaces, and the result is cut to 200 characters with `…`.

**`index.ts` wiring:**
- `let quiet = true`.
- The resolver is `(toolName, next) => { const d = next(); return d ? quietDefinition(d, () => quiet, parts, toolName) : d; }`. A tool with no definition (an MCP tool from a disconnected server) is left as it is.
- **Running line:** one dim line, `<pad>⋯ <toolName> <summarizeArgs>`. It is a component whose `render(width)` returns `[truncateToWidth(line, width)]`. `parts.empty()` is an empty `Container`.
- **`toggle(ctx, on?)`:**
  - set `quiet`;
  - refresh the rows (if `ctx.hasUI`: `const was = getToolsExpanded(); setToolsExpanded(!was); setToolsExpanded(was)`);
  - `ctx.ui.setStatus("quiet-tools", quiet ? "tools hidden (alt+o)" : undefined)`;
  - `notify("Quiet tools: on" | "off", "info")`. This also covers the "Tool output: …" status messages that the refresh briefly shows.
- **Shortcut:** `pi.registerShortcut("alt+o", { description: "Hide or show finished tool rows", handler: toggle })`.
- **Command:** `pi.registerCommand("quiet", …)` takes `on`, `off` or empty (toggle). Any other argument gets a usage notify.
- **Session start:** on `session_start`, set the status line when `ctx.hasUI`.

**Failure handling:** a quiet renderer never throws. If pi's internals change, the worst case is that rows render as today or stay hidden until quiet mode is turned off. The internals this relies on are pinned in the README.

**Limits:**
- Hidden rows can't be clicked to expand. Turn quiet mode off to see them.
- `/export` stays complete, because export never reads `renderShell`.
- A tool call that was interrupted in a resumed session stays `isPartial` and shows one running line.
- Images in tool results still render.

**Rejected alternatives:**
- Default shell with empty slots: this leaves one blank spacer line for each hidden tool.
- Self shell for every tool with copied framing: this is a visual risk in normal mode and puts that framing into the export.

### Steps
**S1.** Create `pi/agent/extensions/quiet-tools/quiet.ts` with `quietDefinition` and `summarizeArgs` exactly as described in Design. Use only `import type` from `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`. Keep the TUI-row flag and the first-read logic in a closure per wrapper.

**S2.** Create `pi/agent/extensions/quiet-tools/index.ts` with the wiring from Design. Model it on `markdown-view/index.ts` for the module header comment, `registerCommand` and the notify style.
- Import `Container` and `truncateToWidth` from `@earendil-works/pi-tui`. `truncateToWidth` is exported in `pi-tui/dist/index.d.ts:35`.
- Every `ctx.ui` call is guarded by `ctx.hasUI`.

**S3.** Create `pi/agent/extensions/quiet-tools/README.md`, modelled on `markdown-view/README.md`. It covers:
- what quiet mode hides and what it doesn't (thinking blocks: `Ctrl+T`; assistant text; custom messages);
- `alt+o`, `/quiet [on|off]`, and that it is on at session start;
- the results of the conflict check;
- the pi internals it relies on, with the file:line facts above, and "check these after a pi upgrade";
- the test command.

**S4.** In the root `README.md:66`, add `quiet-tools` to the extensions list: "`quiet-tools`: `alt+o` / `/quiet` hides finished tool rows".

### Tests
In the new file `pi/agent/extensions/quiet-tools/quiet.test.ts`, use a fake `base` with `name`, `renderCall`, `renderResult` and no `renderShell`, plus fake `parts` that return tagged objects:
- **"normal mode delegates":** with quiet off, after one `renderShell` read, `renderCall`/`renderResult` are the base functions, `renderShell === "default"`, and `name` is inherited. For a base without `renderResult`, the wrapper's `renderResult` is `undefined`.
- **"first shell read keeps the base shell":** with quiet on, the first read is `"default"` and the second is `"self"`.
- **"quiet hides finished rows and shows running ones":** with quiet on, after one read:
  - `renderCall(args, theme, { isPartial: true })` returns the running part;
  - with `isPartial: false` it returns the empty part;
  - `renderResult()` returns the empty part.
- **"export path always delegates":** with quiet on and `renderShell` never read, `renderCall`/`renderResult` are the base functions.
- **"toggling back restores":** quiet on, then off, gives the base renderers and `"default"`.
- **"self-shell tools stay self":** a base with `renderShell: "self"` gives `"self"` with quiet on and with quiet off.
- **"summarizeArgs":** `{command:"git  status\n -s"}` gives `"git status -s"`. `{queries:["a","b","c"]}` gives `"a (+2)"`. `{tasks:[{id:"x"},{id:"y"}]}` gives `"x, y"`. A 300-character string is cut to 200 characters ending in `…`. `{}` gives `"{}"`.

Commands, from `pi/agent/extensions/quiet-tools`:
- `node --experimental-strip-types --test quiet.test.ts`: all pass.
- `cd ../workflow && node --experimental-strip-types --test boundary.test.ts`, and the same for `../agents` and `../shared`: all pass. The new extension imports nothing from them.

**S5.** Verify: restart pi so the sync extension mirrors `quiet-tools` into `~/.pi/agent/extensions`, then ask for something that runs several tools.
- **Look for:**
  - the footer shows "tools hidden (alt+o)";
  - running tools show one dim `⋯ <tool> …` line, and that line disappears when the tool finishes, leaving no blank gaps;
  - `alt+o` brings back every row exactly as before, including rows that ran while quiet mode was on;
  - `alt+o` again hides them;
  - `/quiet off` and `/quiet on` work;
  - `/export` with quiet mode on still contains the tool calls.

### Done when
- In quiet mode, finished tool rows take no lines and a running tool takes one line.
- Turning quiet mode off shows every row exactly as pi does without the extension.
- `alt+o` and `/quiet` toggle it. Quiet mode is on at session start, and the footer shows its state.
- `quiet.test.ts` passes, and the boundary tests still pass.
- The READMEs are updated.

### Risks, rollback, what not to touch
- **Relies on pi 1.5.2 internals:** `renderShell` is read on every render, and the shell is chosen in the constructor. A pi upgrade can break this. The README lists what to re-check. The failure mode is cosmetic (rows visible, or hidden until quiet mode is off).
- Rollback: delete the folder, or revert the one commit.
- Don't touch other extensions, `settings.json` or keybindings.

### Commits
One commit: `quiet-tools: alt+o hides finished tool rows`, with `pi/agent/extensions/quiet-tools/{quiet.ts,quiet.test.ts,index.ts,README.md}` and `README.md`.

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 Create `pi/agent/extensions/quiet-tools/quiet.ts` with `quietDefinition` and `summarizeArgs` exactly as described in Des
- [ ] S2 Create `pi/agent/extensions/quiet-tools/index.ts` with the wiring from Design. Model it on `markdown-view/index.ts` for 
- [ ] S3 Create `pi/agent/extensions/quiet-tools/README.md`, modelled on `markdown-view/README.md`. It covers:
- [ ] S4 In the root `README.md:66`, add `quiet-tools` to the extensions list: "`quiet-tools`: `alt+o` / `/quiet` hides finished 
## For you after the flow
- S5 Verify: restart pi so the sync extension mirrors `quiet-tools` into `~/.pi/agent/extensions`, then ask for something tha
