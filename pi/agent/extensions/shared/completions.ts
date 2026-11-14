/**
 * Slash-command argument completions: one table per command (value, description, argument hint),
 * turned into pi `getArgumentCompletions` items. Pure: nothing here reads a file or runs a process.
 */
import type { AutocompleteItem } from "@earendil-works/pi-tui";

export interface Sub {
	value: string;
	/** One line, shown next to the value. */
	description: string;
	/** Argument hint, e.g. `[title]` or `<job>`; added to the description. */
	arg?: string;
	/** A completion level follows the value (e.g. `merge <id>`) even without a hint. */
	next?: boolean;
}

/** Runs a completion function; `null` (no items) when it throws. Completions must never break typing. */
export function safe<T>(fn: () => T | null): T | null {
	try {
		return fn();
	} catch {
		return null;
	}
}

export function isKnown(table: readonly Sub[], sub: string): boolean {
	return table.some((s) => s.value === sub);
}

/** `a | b | c` for usage lines. */
export function valueList(table: readonly Sub[], sep = ", "): string {
	return table.map((s) => s.value).join(sep);
}

/** `value [arg]` for each entry, joined by ` | `. */
export function usageLine(table: readonly Sub[]): string {
	return table.map((s) => (s.arg ? `${s.value} ${s.arg}` : s.value)).join(" | ");
}

/** Words of the typed argument text; the last one is the one being completed (empty after a space). */
export function words(prefix: string): string[] {
	return prefix.trimStart().split(/\s+/);
}

/**
 * Entries whose value starts with `prefix`, as completion items. The value ends with a space when
 * something follows it, so the next level of completions opens by itself. `base` is the text
 * already typed before this level (`"plan "`).
 */
export function subcommandCompletions(table: readonly Sub[], prefix: string, base = ""): AutocompleteItem[] | null {
	return safe(() => {
		const p = prefix.trim().toLowerCase();
		const items = table
			.filter((s) => s.value.toLowerCase().startsWith(p))
			.map((s) => ({
				value: `${base}${s.value}${s.arg || s.next ? " " : ""}`,
				label: s.value,
				description: s.arg ? `${s.arg} ${s.description}` : s.description,
			}));
		return items.length > 0 ? items : null;
	});
}
