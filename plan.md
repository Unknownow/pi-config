<!-- pi-workflow plan v1 flow=20261107-0220-view-opens-an-agent-reply-or-a-markdown-bb4c -->
## Plan: `/view` opens an agent reply or a markdown file in the browser, with real mermaid diagrams

**Goal.** Add a `/view` command that renders the markdown of an assistant reply, or of a file, as a local HTML page and opens it in the default browser. Mermaid diagrams of every type and size (like both of your examples) should render with mermaid.js, so you no longer copy code into an online viewer.

**Non-goals.**
- Changing Pi's terminal mermaid renderer or the `markdown.mermaid` setting.
- Changing the `read` tool, or any other tool's display.
- An interactive picker for recent replies, or a hint shown under replies.
- Bundling JS for offline use.
- Rendering subagent or tool-result text. To view those, have the agent write them to a `.md` file and use `/view <file>`.

### User decisions
- **D1.** Display-only. It is a `/view` command and never touches the model's context or the session.
- **D2.** `/view` shows the last assistant reply, `/view N` the N-th reply counting back from the last (1 = last), and `/view <path>` a markdown file.
- **D3.** Output is a temporary self-contained HTML file opened in the default browser. Diagrams are rendered by mermaid.js.
- **D4.** Libraries load from a CDN with pinned versions. You said "go" without picking, so this takes my stated default. Offline, the page still shows the text, and diagrams stay as code blocks.
- **D5.** No hint is added under replies (my stated default).
- **D6.** It lives in a new extension folder, `pi/agent/extensions/markdown-view/`.

### Facts the executor needs
- Pi automatically loads every folder in `pi/agent/extensions/` that has an `index.ts` with a default export `(pi: ExtensionAPI) => void`. The repo mirrors these folders to `~/.pi/agent/extensions` (`bin/lib.js:42`, `MIRROR_DIRS`), so no `settings.json` change is needed. Model it on `pi/agent/extensions/sandbox/index.ts:15`.
- **Command API:** `pi.registerCommand(name, { description, handler: async (args: string, ctx) => … })`. `ctx.ui.notify(text, "info" | "warning" | "error")`, as used in `pi/agent/extensions/agents/index.ts:330`. No other extension registers `view`.
- **Session entries:** `ctx.sessionManager.getBranch()` returns the current branch's entries, oldest first. An assistant reply looks like `{ type: "message", message: { role: "assistant", content: [{ type: "text", text }, { type: "thinking", … }, { type: "toolCall", … }] } }` (Pi's `docs/session-format.md:91`). The same `getBranch()` usage appears at `workflow/index.ts:358`.
- **Tests:** they use `node:test` and `node:assert/strict`, run with `node --experimental-strip-types --test …` on Node v24.21.0. See `pi/agent/extensions/sandbox/html-to-md.test.ts:1-3`.
- The extensions table in the repo README is at `README.md:66`.
- **Why this is needed:** Pi's terminal renderer, `pi-coding-agent/dist/modes/interactive/components/mermaid.js`, falls back to raw code when the art is wider than the terminal, when there are parse warnings, or when the block is not at the top level.

### Design
- **`view.ts`** holds only logic that can be tested without Pi:
  - `parseViewArgs(args: string): { kind: "reply"; index: number } | { kind: "file"; path: string } | { error: string }`
    - Empty or whitespace input gives `{reply, 1}`.
    - `/^\d+$/` gives `{reply, n}`. `0` gives an error (`"N must be 1 or more"`).
    - Anything else gives `{file, trimmed}`. Surrounding quotes are removed, so `"my notes.md"` works.
  - `replyTexts(entries: unknown[]): string[]` returns the text of each assistant message, oldest first.
    - Only `text` blocks are joined, with `"\n\n"`. `thinking` and `toolCall` blocks are skipped.
    - Messages with empty text (tool-call-only turns) are left out.
    - It must be defensive about malformed entries: skip them and never throw.
  - `buildHtml(markdown: string, title: string): string` returns one HTML document (format below).
  - `viewFileName(now: Date): string` returns `view-<YYYYMMDD-HHMMSS>-<ms>.html`.
- **`index.ts`** registers the command and does the I/O:
  - It resolves the source.
  - It writes the HTML to `path.join(os.tmpdir(), "pi-view", name)` and creates the folder if needed.
  - It deletes `view-*.html` files in that folder older than 24 h. Errors during cleanup are ignored.
  - It opens the file and notifies you.
- **HTML contract** (`buildHtml`):
  - `<title>`: the HTML-escaped title.
  - The markdown is embedded as `<script type="application/json" id="md">` holding `JSON.stringify(markdown)`, with every `<` replaced by `\u003c`. Text such as `</script>` in a reply then can't break out of the tag.
  - **Pinned CDN scripts** from `https://cdn.jsdelivr.net/npm/`:
    - `marked@15.0.12/marked.min.js`
    - `dompurify@3.2.6/dist/purify.min.js`
    - `@highlightjs/cdn-assets@11.11.1/highlight.min.js`
    - The styles `@highlightjs/cdn-assets@11.11.1/styles/github.min.css` and `github-dark.min.css`, chosen with `media="(prefers-color-scheme: …)"`.
    - `mermaid@11.6.0/dist/mermaid.min.js`
  - **Inline script, step by step:**
    1. Read the markdown with `JSON.parse` of `#md`'s text.
    2. If `marked` or `DOMPurify` is missing (offline), show the raw markdown in a `<pre>` with a note that the libraries could not load, then stop.
    3. Otherwise run `DOMPurify.sanitize(marked.parse(md, { gfm: true }))` into `<main>`. Agent text must not run scripts in the page.
    4. Each `code.language-mermaid` gets its text dedented (common leading whitespace removed, because your examples are indented). Its `<pre>` is replaced by a `<div class="diagram">`.
    5. Each diagram is rendered alone with `await mermaid.render("d" + i, src)` inside try/catch:
       - On success, insert the SVG.
       - On failure, show the source in a `<pre>` plus the error message in a red note. Other diagrams still render.
    6. Call `mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" })`. `strict` still allows `<br/>` in labels.
    7. If `window.mermaid` is missing, mermaid blocks stay as code.
    8. Call `hljs.highlightElement` on the other `pre code` blocks, if `hljs` loaded.
  - **CSS:** readable max width of about 960 px, light and dark via `prefers-color-scheme`, tables with borders, and diagrams that scroll horizontally (`overflow-x: auto`) when wide.
- **Opening the browser:** `spawn` with `{ detached: true, stdio: "ignore", windowsHide: true }`, then `unref()`, with no shell:
  - win32: `rundll32 url.dll,FileProtocolHandler <file>`
  - darwin: `open <file>`
  - other: `xdg-open <file>`
  - A spawn `error` event is caught and turned into a warning that includes the file path.
- **Failures:** each one gives a `ctx.ui.notify` warning and nothing is written:
  - No assistant reply yet gives `"view: no assistant reply yet"`.
  - `N` larger than the number of replies gives `"view: only K replies"`.
  - A missing or unreadable file gives `"view: cannot read <path>: <reason>"`.
  - A directory gives the same message.
- **Success:** notifies `view: opened <title> → <file path>` (info), so you can open the file yourself if the browser doesn't open.
- **Rejected alternatives:**
  - Terminal rendering can't draw large diagrams.
  - A VS Code preview needs an extension and an open editor.
  - Bundling mermaid adds about 3 MB to the repo, and you chose the CDN.
- **Limits:** one file per call, any size the browser can handle. Very large replies (over 1 MB) are fine. Mermaid's own limits apply (`maxTextSize` 50 000 characters per diagram by default).

### Steps
**S1.** Create `pi/agent/extensions/markdown-view/view.ts` with `parseViewArgs`, `replyTexts`, `buildHtml` and `viewFileName`, following the Design contracts above. The inline browser script and CSS live in `buildHtml`'s template string. Keep the CDN URLs and versions in one exported `CDN` constant, so they're easy to bump.

**S2.** Create `pi/agent/extensions/markdown-view/index.ts` with the default export registering `view`.
- **Description:** `"Open an assistant reply (/view, /view N) or a markdown file (/view <path>) in the browser, with mermaid diagrams"`.
- **Handler:**
  1. Parse the arguments.
  2. Pick the source:
     - **Reply:** call `replyTexts(ctx.sessionManager.getBranch())` and take the item at `length - index`. The title is `Reply N of K`.
     - **File:** resolve the path against `ctx.cwd` and read it as UTF-8. The title is the file's base name.
  3. Build the HTML, write it, clean up old files, open it and notify (all as in the Design section).
- Wrap the whole handler in try/catch so it never throws into Pi. Any error becomes an error notify.

**S3.** Add `pi/agent/extensions/markdown-view/README.md`: what `/view` does, its argument forms, the temp-file location and 24 h cleanup, the CDN libraries and versions, offline behaviour, and the test command. Model it on `pi/agent/extensions/sandbox/README.md`.

**S4.** Update `README.md:66`: add `markdown-view` (`/view` opens a reply or `.md` file in the browser with mermaid diagrams) to the list of extensions.

**S5.** Deliver: merge, with the extension, its tests and the README changes.

### Tests
Put these in `pi/agent/extensions/markdown-view/view.test.ts` (node:test):

**`parseViewArgs`**
- `""` and `"  "` → `{kind:"reply", index:1}`.
- `"3"` → `{reply, 3}`.
- `"0"` → an error.
- `"docs/a.md"` → `{file, "docs/a.md"}`.
- `"\"my notes.md\""` → `{file, "my notes.md"}`.

**`replyTexts`**
- **Mixed entries:** a mix of user messages, an assistant message with `[thinking, text "A", toolCall]`, a tool-call-only assistant message, a custom entry, a malformed entry (`{}` and `{type:"message"}` with no message), and an assistant message with two text blocks. Expect `["A", "B\n\nC"]`.
- **Nothing to show:** an empty array → `[]`.

**`buildHtml`**
- **No breaking out of the script tag:** markdown containing `</script><script>alert(1)</script>` produces HTML with exactly one `</script>` after the `id="md"` opening tag. Reading the `#md` script content (between `id="md">` and `</script>`) and running `JSON.parse` returns the original markdown.
- **Title escaping:** the title `a<b & "c"` appears escaped in `<title>`.
- **Pinned CDN:** the output contains each `CDN` URL with the pinned version and `securityLevel: "strict"`.

**`viewFileName`**
- A fixed date gives the expected name, matching `/^view-\d{8}-\d{6}-\d{3}\.html$/`.

Command, run from the repo root (fast): `node --experimental-strip-types --test pi/agent/extensions/markdown-view/view.test.ts` should report all tests passing and 0 failing.

Also run the existing test suites that could see a new folder. This is a sanity check that nothing else breaks: `node --test bin/sync.test.js` should still pass.

**S6.** Verify: once the extension is synced to `~/.pi/agent/extensions`, restart pi. Then:
1. Ask the agent to repeat your stateDiagram and sequenceDiagram examples, and run `/view`.
2. Run `/view 2`.
3. Run `/view README.md`.

Look for:
- The browser opens.
- The state diagram renders, including its notes and the `level → level` self-loop.
- The sequence diagram renders as far as mermaid allows. If the stray `intro` line breaks it, a red error note shows with the source while the rest of the page renders.
- Dark or light follows your OS setting.

### Done when
- `/view`, `/view N` and `/view <file.md>` each open a browser page with the rendered markdown, and mermaid diagrams render as SVG.
- A diagram that fails shows its source and an error, and the rest of the page still renders.
- No session entry is added and no tool is registered.
- The unit tests pass.
- The extension README and repo README describe the command.

### Risks, rollback, what not to touch
- **Risk:** the CDN versions could be wrong or unreachable. The page then falls back to the raw text in a `<pre>`, or to diagrams left as code blocks.
  - The executor checks each pinned URL with one GET (e.g. `fetch_url`) during S1. If a version doesn't exist, it uses the nearest existing patch of the same major version and records it in the README.
- **Risk:** opening the browser could fail on an unusual setup. The notify always includes the file path.
- **Rollback:** delete the `markdown-view` folder, which is standalone.
- **Don't touch:** `shared/`, the workflow, agents, sandbox and worktree extensions, `settings.json`, or anything in the installed Pi package.

### Commits
1. `markdown-view: /view opens a reply or markdown file in the browser with mermaid diagrams`, touching `pi/agent/extensions/markdown-view/{index.ts,view.ts,view.test.ts,README.md}` and `README.md`.

<!-- pi-workflow:status -->
## Checklist
- [x] S1 Create `pi/agent/extensions/markdown-view/view.ts` with `parseViewArgs`, `replyTexts`, `buildHtml` and `viewFileName`, f
- [x] S2 Create `pi/agent/extensions/markdown-view/index.ts` with the default export registering `view`.
- [x] S3 Add `pi/agent/extensions/markdown-view/README.md`: what `/view` does, its argument forms, the temp-file location and 24 
- [x] S4 Update `README.md:66`: add `markdown-view` (`/view` opens a reply or `.md` file in the browser with mermaid diagrams) to
- [x] S5 Deliver: merge, with the extension, its tests and the README changes.
## For you after the flow
- S6 Verify: once the extension is synced to `~/.pi/agent/extensions`, restart pi. Then:
