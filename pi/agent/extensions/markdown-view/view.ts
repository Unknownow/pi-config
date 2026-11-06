/** Pure logic of the /view command: argument parsing, reply extraction, HTML page. */

const BASE = "https://cdn.jsdelivr.net/npm/";

/** Pinned CDN files. Bump versions here. */
export const CDN = {
	marked: `${BASE}marked@15.0.12/marked.min.js`,
	dompurify: `${BASE}dompurify@3.2.6/dist/purify.min.js`,
	highlight: `${BASE}@highlightjs/cdn-assets@11.11.1/highlight.min.js`,
	highlightLight: `${BASE}@highlightjs/cdn-assets@11.11.1/styles/github.min.css`,
	highlightDark: `${BASE}@highlightjs/cdn-assets@11.11.1/styles/github-dark.min.css`,
	mermaid: `${BASE}mermaid@11.6.0/dist/mermaid.min.js`,
} as const;

export type ViewArgs = { kind: "reply"; index: number } | { kind: "file"; path: string } | { error: string };

export function parseViewArgs(args: string): ViewArgs {
	let a = (args ?? "").trim();
	if (!a) return { kind: "reply", index: 1 };
	if (/^\d+$/.test(a)) {
		const n = Number(a);
		return n >= 1 ? { kind: "reply", index: n } : { error: "N must be 1 or more" };
	}
	if (a.length >= 2 && ((a.startsWith('"') && a.endsWith('"')) || (a.startsWith("'") && a.endsWith("'")))) a = a.slice(1, -1).trim();
	return a ? { kind: "file", path: a } : { error: "empty path" };
}

/** Text of each assistant message, oldest first. Skips empty and malformed entries. */
export function replyTexts(entries: unknown[]): string[] {
	const out: string[] = [];
	for (const e of Array.isArray(entries) ? entries : []) {
		try {
			const entry = e as { type?: unknown; message?: { role?: unknown; content?: unknown } } | null;
			if (!entry || entry.type !== "message" || !entry.message || entry.message.role !== "assistant") continue;
			const content = entry.message.content;
			let text = "";
			if (typeof content === "string") text = content;
			else if (Array.isArray(content)) {
				text = content
					.filter((b) => b && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
					.map((b) => (b as { text: string }).text)
					.join("\n\n");
			}
			if (text.trim()) out.push(text);
		} catch {
			// skip malformed entry
		}
	}
	return out;
}

export function viewFileName(now: Date): string {
	const p = (n: number, w = 2) => String(n).padStart(w, "0");
	return `view-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${p(now.getMilliseconds(), 3)}.html`;
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1f2328;--border:#d0d7de;--code:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--border:#30363d;--code:#161b22}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 20px 64px}
pre{background:var(--code);padding:12px 14px;border-radius:6px;overflow-x:auto}
code{font-family:ui-monospace,Consolas,monospace;font-size:.9em}
:not(pre)>code{background:var(--code);padding:.15em .35em;border-radius:4px}
table{border-collapse:collapse;display:block;overflow-x:auto}
th,td{border:1px solid var(--border);padding:6px 12px}
blockquote{margin:0;padding:0 1em;border-left:4px solid var(--border);opacity:.85}
img{max-width:100%}
.diagram{overflow-x:auto;margin:1em 0;text-align:center}
.diagram svg{max-width:none;height:auto}
.err{color:#d1242f;font-size:.9em;margin:.3em 0;white-space:pre-wrap;text-align:left}
.note{color:#9a6700}
`;

const SCRIPT = `
(async () => {
  const md = JSON.parse(document.getElementById("md").textContent);
  const main = document.querySelector("main");
  if (!window.marked || !window.DOMPurify) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = "Rendering libraries could not load (offline?). Showing the raw markdown.";
    const pre = document.createElement("pre");
    pre.textContent = md;
    main.append(note, pre);
    return;
  }
  main.innerHTML = DOMPurify.sanitize(marked.parse(md, { gfm: true }));
  const dedent = (s) => {
    const lines = s.replace(/\\s+$/, "").split("\\n");
    const ind = lines.filter((l) => l.trim()).map((l) => l.match(/^[ \\t]*/)[0].length);
    const n = ind.length ? Math.min(...ind) : 0;
    return lines.map((l) => l.slice(n)).join("\\n");
  };
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const blocks = [...main.querySelectorAll("code.language-mermaid")];
  if (window.mermaid) {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
    let i = 0;
    for (const code of blocks) {
      const src = dedent(code.textContent);
      const pre = code.closest("pre") || code;
      const div = document.createElement("div");
      div.className = "diagram";
      try {
        const r = await mermaid.render("d" + i++, src);
        div.innerHTML = r.svg;
      } catch (e) {
        const p = document.createElement("pre");
        p.textContent = src;
        const err = document.createElement("div");
        err.className = "err";
        err.textContent = "Mermaid error: " + (e && e.message ? e.message : e);
        div.append(p, err);
        document.querySelectorAll('[id^="dd"]').forEach((n) => n.remove());
      }
      pre.replaceWith(div);
    }
  }
  if (window.hljs) {
    main.querySelectorAll("pre code").forEach((c) => {
      if (!c.classList.contains("language-mermaid")) hljs.highlightElement(c);
    });
  }
})();
`;

export function buildHtml(markdown: string, title: string): string {
	const json = JSON.stringify(markdown).replace(/</g, "\\u003c");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${CDN.highlightLight}" media="(prefers-color-scheme: light)">
<link rel="stylesheet" href="${CDN.highlightDark}" media="(prefers-color-scheme: dark)">
<style>${CSS}</style>
</head>
<body>
<main></main>
<script type="application/json" id="md">${json}</script>
<script src="${CDN.marked}"></script>
<script src="${CDN.dompurify}"></script>
<script src="${CDN.highlight}"></script>
<script src="${CDN.mermaid}"></script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
