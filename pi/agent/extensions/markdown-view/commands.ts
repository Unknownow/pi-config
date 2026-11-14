/** The `/view` arguments and their completions. Pure: tests load it without pi. */
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { safe, type Sub } from "../shared/completions.ts";

/** Hint-only entries: `N` completes to the newest replies, `<path>` is free text. */
export const VIEW_ARGS: Sub[] = [
	{ value: "N", description: "open the Nth newest assistant reply (none: the newest)" },
	{ value: "<path>", description: "open a markdown file" },
];

export const viewDescription = () => `Open an assistant reply or a markdown file in the browser, with mermaid diagrams: /view [${VIEW_ARGS.map((a) => a.value).join(" | ")}]`;

/** Reply numbers with the first line of each reply; `replies` is newest first and null before the first session context. */
export function viewCompletions(prefix: string, replies: () => string[] | null): AutocompleteItem[] | null {
	return safe(() => {
		const typed = prefix.trim();
		if (/\s/.test(typed) || !/^\d*$/.test(typed)) return null;
		const list = replies();
		if (!list) return null;
		const items = list
			.map((text, i) => ({ n: String(i + 1), line: text.split("\n").find((l) => l.trim())?.trim() ?? "" }))
			.filter((r) => r.n.startsWith(typed))
			.map((r) => ({ value: r.n, label: r.n, description: r.line.length > 80 ? `${r.line.slice(0, 79)}…` : r.line }));
		return items.length > 0 ? items : null;
	});
}
