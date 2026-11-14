# Sandbox extension

Two small tools that keep big output out of the model's context. They replace the context-mode
package (no dependencies, short tool descriptions).

| Tool | What it does |
|---|---|
| `run_code {code, cwd?, timeout?}` | Runs JavaScript (CommonJS, wrapped in an async function, so `await` and `require` work) in a child `node` process. Only what the code prints comes back, capped at 8,000 characters (first 6,000, a cut note, last 2,000). Timeout 60 s by default, 600 s at most; on timeout or abort the whole process tree is killed (`taskkill /T` on Windows). stdin is closed. JavaScript only. |
| `fetch_url {url, force?}` | GET (http/https only, redirects followed, 30 s timeout, 5 MB limit). HTML is converted to markdown, JSON is pretty-printed, other text is kept. The file is saved to `<tmpdir>/pi-fetch/<sha1(url)>.<md\|json\|txt>` and reused for 1 hour unless `force`. Returns URL, status, type, size, title, up to 40 headings, the first 2,000 characters and the saved path; use `grep` or `read` on the file for more. |
| `read_pdf {path, pages?, images?, width?}` | Text mode (default): `pdftotext -layout` for the page range into `<tmpdir>/pi-read-pdf/<key>/text-A-B.txt`; returns the page count (`pdfinfo`), size, the first 2,000 characters and the path. Fewer than 20 non-space characters per page gives "No text layer (scanned?)": use `images: true`. Image mode: `pdftoppm -png` for at most 8 pages per call (a larger range is clipped, and the reply says so), returned as images plus their paths. `pages` is `"A"` or `"A-B"`. A missing binary (`pdfinfo`, `pdftotext`, `pdftoppm`; poppler) gives an error with an install hint. |

The workflow extension lets both tools through in the plan phase; `run_code`'s code goes through the
same JS write checks as the former context-mode code tool (`shared/readonly-tools.ts`).

Not replaced: context-mode's session memory and `/ctx-stats`.

## Tests

```
cd pi/agent/extensions/sandbox && node --experimental-strip-types --test *.test.ts
```
