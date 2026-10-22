/** Small HTML to markdown converter for fetch_url. No dependencies; good enough for docs pages. */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", hellip: "…", mdash: "—", ndash: "–" };

export function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
		if (e[0] === "#") {
			const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			try {
				return code === 0 ? "\uFFFD" : String.fromCodePoint(code);
			} catch {
				return m;
			}
		}
		return ENTITIES[e.toLowerCase()] ?? m;
	});
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, "");

function inline(html: string): string {
	let s = html;
	s = s.replace(/<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi, (_m, a: string, b: string, text: string) => {
		const label = stripTags(text).replace(/\s+/g, " ").trim();
		return label ? `[${label}](${a ?? b})` : "";
	});
	s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, t: string) => `\`${stripTags(t)}\``);
	return s;
}

export function htmlToMarkdown(html: string): { markdown: string; title?: string } {
	let s = html.replace(/<!--[\s\S]*?-->/g, "");
	const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(s);
	for (const tag of ["script", "style", "nav", "header", "footer", "svg", "noscript", "title"]) s = s.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi"), "");

	const blocks: string[] = [];
	s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, body: string) => {
		blocks.push("\n\n```\n" + decodeEntities(stripTags(body)).replace(/^\n|\n$/g, "") + "\n```\n\n");
		return `\u0000${blocks.length - 1}\u0000`;
	});
	s = s.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_m, body: string) => {
		const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
			[...r[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => stripTags(inline(c[1])).replace(/\s+/g, " ").trim().replace(/\|/g, "\\|")),
		);
		const kept = rows.filter((r) => r.length);
		const lines = kept.map((r) => `| ${r.join(" | ")} |`);
		if (lines.length) lines.splice(1, 0, `| ${kept[0].map(() => "---").join(" | ")} |`);
		blocks.push(`\n\n${lines.join("\n")}\n\n`);
		return `\u0000${blocks.length - 1}\u0000`;
	});

	s = inline(s);
	s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, t: string) => `\n\n${"#".repeat(Number(n))} ${stripTags(t).replace(/\s+/g, " ").trim()}\n\n`);
	s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_m, body: string) => {
		let i = 0;
		return "\n\n" + body.replace(/<li\b[^>]*>/gi, () => `\n${++i}. `) + "\n\n";
	});
	s = s.replace(/<li\b[^>]*>/gi, "\n- ");
	s = s.replace(/<br\s*\/?>/gi, "\n");
	s = s.replace(/<\/?(p|div|section|article|main|ul|ol|blockquote|tr)\b[^>]*>/gi, "\n\n");
	s = stripTags(s);
	s = decodeEntities(s);
	s = s.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n");
	s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)]);
	s = s.replace(/\n{3,}/g, "\n\n").trim();

	const h1 = /^# (.+)$/m.exec(s);
	const title = titleTag ? decodeEntities(stripTags(titleTag[1])).replace(/\s+/g, " ").trim() : h1?.[1];
	return { markdown: s, title: title || undefined };
}
