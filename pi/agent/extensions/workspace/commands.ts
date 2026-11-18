/** The `/wt` subcommand table and its completions. Pure: tests load it without pi. */
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { isKnown, safe, subcommandCompletions, usageLine, type Sub } from "../shared/completions.ts";

export const WT_SUBS: Sub[] = [
	{ value: "new", arg: "[NAME]", description: "create a worktree set and open a session in it" },
	{ value: "open", arg: "NAME", description: "open a session in an existing set" },
	{ value: "use", arg: "[NAME]", description: "make this session work in a set" },
	{ value: "list", description: "the sets and their sessions" },
	{ value: "update", arg: "[NAME]", description: "bring a set up to date with its base branch" },
	{ value: "remove", arg: "NAME", description: "remove a set and its worktrees" },
	{ value: "rename", arg: "[OLD] [NEW]", description: "rename a set" },
	{ value: "clean", description: "remove merged sets and stale branches" },
	{ value: "done", description: "finish this set: merge state check and removal" },
	{ value: "unlink", arg: "PATH", description: "replace a linked path of this set with a real copy" },
];

export const isKnownWt = (sub: string) => isKnown(WT_SUBS, sub);
export const wtUsage = () => `Usage: /wt ${usageLine(WT_SUBS)}`;
export const wtDescription = () => `Parallel pi sessions on git worktrees: ${WT_SUBS.map((s) => (s.arg ? `${s.value} ${s.arg}` : s.value)).join(", ")}`;

export function wtCompletions(prefix: string, sets: () => string[]): AutocompleteItem[] | null {
	return safe(() => {
		const m = /^(remove|open|update|use|rename)\s+(\S*)$/i.exec(prefix.trimStart());
		if (m) {
			const sub = m[1].toLowerCase();
			const found = sets().filter((n) => n.startsWith(m[2])).map((n) => ({ value: `${sub} ${n}`, label: n, description: `worktree set (${sub})` }));
			return found.length ? found : null;
		}
		if (/\s/.test(prefix.trimStart())) return null;
		return subcommandCompletions(WT_SUBS, prefix);
	});
}

