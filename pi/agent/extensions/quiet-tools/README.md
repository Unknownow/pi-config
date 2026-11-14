# quiet-tools

Hides finished tool rows (bash, read, judge, explore, codemode, ...) in the pi transcript so you scroll
only through messages and answers. A running tool shows one dim line (`⋯ <tool> <args>`).

- `alt+o` toggles quiet mode; `/quiet [on|off]` sets it. It is **on** at the start of every session
  (not saved), and the footer shows `tools hidden (alt+o)` while it is on.
- With quiet mode off, rows look exactly as without the extension.
- Not hidden: thinking blocks (use `Ctrl+T` / `hideThinkingBlock`), assistant text between tool calls,
  custom messages from other extensions (judge reports, nudges). Image results still render.
- Hidden rows cannot be clicked open; turn quiet mode off to see them. `/export` stays complete.

## Conflict check for `alt+o`

- pi 1.5.2: no built-in binding uses `alt+o` (`docs/keybindings.md`); `Ctrl+O` expands tools.
- Windows Terminal: this machine binds only `ctrl+c`, `ctrl+v`, `alt+shift+d`; its default alt keys are
  `alt+enter`, `alt+F4`, `alt+space`, `alt+shift+d/-/+`, arrows.
- cmd/conhost: `alt+enter`, `alt+space`, `alt+F4`. PSReadLine only acts at the PowerShell prompt.
- `/quiet` is not a pi command nor used by another extension here.

## pi internals it relies on (check after a pi upgrade)

Paths relative to `@earendil-works/pi-coding-agent/`:

- `dist/modes/interactive/components/tool-execution.js`: the constructor reads `renderShell` once (~L57) to
  pick the child (`"self"` container vs Spacer + `contentBox`); `render` (~L174) and `updateDisplay` (~L220)
  read it again every time; `renderCall`/`renderResult` are read on each `updateDisplay`; a missing or
  throwing renderer falls back to the built-in preview. In `"self"` an empty container renders no lines.
- `dist/core/extensions/runner.js:550-553`: the resolver's object is used as is (getters survive).
- `dist/modes/interactive/interactive-mode.js`: `setToolsExpanded` returns early when unchanged, so the
  refresh flips it and flips it back.
- `dist/core/export-html/tool-renderer.js`: export calls `renderCall`/`renderResult` and never reads
  `renderShell`; a wrapper whose `renderShell` was never read therefore always delegates.

- Built-in renderers reuse `context.lastComponent` and assume their own type (`core/tools/renderers/grep.js:59`,
  `read.js:115`, `write.js:133`). Right after quiet mode is turned off, the first `updateDisplay` passes the
  quiet part as `lastComponent`; it throws, pi falls back and clears it (`tool-execution.js:205-208`), and the
  second flip of the refresh renders the row correctly. Keep the two-step refresh (flip, flip back).
- A running tool shows one blank line (pi's self-shell framing) plus the dim line.

The first `renderShell` read of a wrapper must return the base shell, otherwise a row built while quiet
would stay blank after quiet mode is turned off. Failure mode on a pi change is cosmetic.

## Tests

```
cd pi/agent/extensions/quiet-tools && node --experimental-strip-types --test quiet.test.ts
```

## Completions

`/quiet ` offers `on` and `off` (table in `commands.ts`).
