/** Plan title, branch names and pull request facts used by the executor's own delivery. Pure text and decisions, kept apart so node tests can reach them. */

export type MergeMethod = "merge" | "rebase" | "squash";

/** The plan's title: the text after the first "## Plan:" heading, or "". */
export function planTitle(plan: string | undefined): string {
	const m = /^#+\s*Plan:?\s*(.*)$/m.exec(plan ?? "");
	return (m?.[1] ?? "").trim();
}

/** A branch for a pull request started on a protected branch: prefix + slug of the plan title (at most 40 characters), or a timestamp. */
export function branchName(prefix: string, title: string, now: Date): string {
	const p = prefix.replace(/[^A-Za-z0-9._/-]/g, "");
	const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
	if (slug) return `${p}${slug}`;
	const two = (n: number) => String(n).padStart(2, "0");
	return `${p}flow-${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`;
}

export interface PrState {
	number: number;
	state: string;
}
