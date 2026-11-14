# Markdown view extension

`/view` shows an assistant reply, or a markdown file, in the browser with real mermaid diagrams. Pi's
terminal renderer keeps a diagram as code when it is wider than the terminal, has parse warnings, or
is not at the top level; the browser has no such limit. Display only: no tool is registered, nothing
is added to the session or the model's context.

| Command | Shows |
|---|---|
| `/view` | the last assistant reply |
| `/view N` | the N-th reply counting back from the last (1 = last) |
| `/view <path>` | a markdown file (relative to the session folder; quotes allowed for spaces) |

Only the `text` parts of a reply are shown (no thinking, no tool calls). Replies with no text are
skipped when counting.

## How it works

The markdown is embedded in a self-contained HTML file at `<tmpdir>/pi-view/view-<timestamp>.html` and
opened with the system default (`rundll32 url.dll,FileProtocolHandler` on Windows, `open` on macOS,
`xdg-open` elsewhere). Files older than 24 h are deleted on each call. The command notifies the file
path, so you can open it yourself if the browser does not start.

In the page, marked renders the markdown, DOMPurify sanitizes it, highlight.js colours code, and
mermaid renders each `mermaid` block on its own (`securityLevel: "strict"`). A diagram that fails
shows its source and the error; the rest of the page still renders. Light or dark follows the OS.

## Libraries (CDN, pinned)

Loaded from `cdn.jsdelivr.net`; your text stays local and is never uploaded. Versions are in the `CDN`
constant in `view.ts`: marked 15.0.12, DOMPurify 3.2.6, highlight.js 11.11.1, mermaid 11.6.0.
Offline, the page shows the raw markdown in a `<pre>` (marked or DOMPurify missing) or leaves
diagrams as code blocks (mermaid missing).

Tests: `node --experimental-strip-types --test view.test.ts`

## Completions

`/view ` lists the numbers of the last 10 assistant replies with the first line of each (taken from the last session context). A path gets no completion.
