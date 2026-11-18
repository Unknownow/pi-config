/** The `/wt` and `/folders` subcommand tables and their completions. Pure: tests load it without pi. */
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { isKnown, safe, subcommandCompletions, usageLine, type Sub } from "../shared/completions.ts";
import { pathCompletions } from "./pickers.ts";

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

export interface WtState {
	/** The set names under the configured root. */
	sets: () => string[];
	/** Linked paths (relative to the repo) of the set this session runs in; [] outside a set. */
	linked?: () => string[];
}

/** Subcommands whose first argument is a set name. */
const SET_ARG = new Set(["open", "use", "update", "remove", "rename"]);

export function wtCompletions(prefix: string, st: WtState): AutocompleteItem[] | null {
	return safe(() => {
		const m = /^(\S+)\s+(\S*)$/.exec(prefix.trimStart());
		if (m) {
			const sub = m[1].toLowerCase();
			const typed = m[2];
			let items: AutocompleteItem[] = [];
			if (SET_ARG.has(sub)) {
				items = st.sets().filter((n) => n.startsWith(typed)).map((n) => ({ value: `${sub} ${n}${sub === "rename" ? " " : ""}`, label: n, description: `worktree set (${sub})` }));
				if (sub === "use" && "original".startsWith(typed)) items.push({ value: "use original", label: "original", description: "back to the original folders" });
			} else if (sub === "unlink") {
				items = (st.linked?.() ?? []).filter((p) => p.toLowerCase().startsWith(typed.toLowerCase())).map((p) => ({ value: `unlink ${p}`, label: p, description: "linked path of this set" }));
			}
			return items.length ? items : null;
		}
		if (/\s/.test(prefix.trimStart())) return null;
		return subcommandCompletions(WT_SUBS, prefix);
	});
}

export const FOLDERS_SUBS: Sub[] = [
	{ value: "add", arg: "PATH", description: "add a folder to this session" },
	{ value: "remove", arg: "PATH or N", description: "remove a folder by path or list number" },
	{ value: "list", description: "the working folder and the added ones" },
];

export const isKnownFolders = (sub: string) => isKnown(FOLDERS_SUBS, sub);
export const foldersUsage = () => `Usage: /folders ${usageLine(FOLDERS_SUBS)}`;
export const foldersDescription = () => `Folders that are part of this session: ${FOLDERS_SUBS.map((s) => (s.arg ? `${s.value} ${s.arg}` : s.value)).join(", ")}`;

export interface FoldersState {
	cwd: string;
	home: string;
	/** Subfolders of a directory; null when it cannot be read. */
	readDirs: (dir: string) => string[] | null;
	folders: string[];
}

export function foldersCompletions(prefix: string, st: FoldersState): AutocompleteItem[] | null {
	return safe(() => {
		const addM = prefix.match(/^add\s+(.*)$/i);
		if (addM) {
			const items = pathCompletions(addM[1], st.cwd, st.home, st.readDirs).map((p) => ({ value: `add ${p.includes(" ") ? `"${p}"` : p}`, label: p, description: "folder" }));
			return items.length > 0 ? items : null;
		}
		const remM = prefix.match(/^remove\s+(.*)$/i);
		if (remM) {
			const typed = remM[1].trim().replace(/^"/, "").toLowerCase();
			const items = st.folders
				.map((f, i) => ({ value: `remove ${i + 1}`, label: `${i + 1}`, description: f, f, n: String(i + 1) }))
				.filter((x) => x.n.startsWith(typed) || x.f.toLowerCase().startsWith(typed.replace(/\\/g, "/")))
				.map(({ value, label, description }) => ({ value, label, description }));
			return items.length > 0 ? items : null;
		}
		if (/\s/.test(prefix.trimStart())) return null;
		return subcommandCompletions(FOLDERS_SUBS, prefix);
	});
}
