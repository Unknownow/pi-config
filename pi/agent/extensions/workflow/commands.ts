/** The `/flow` and `/folders` subcommand tables and their completions. Pure: tests load it without pi. */
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { isKnown, safe, subcommandCompletions, usageLine, valueList, words, type Sub } from "../shared/completions.ts";
import { roleCompletions, type RoleSpec } from "../shared/roles.ts";
import { pathCompletions } from "./pickers.ts";

export const FLOW_SUBS: Sub[] = [
	{ value: "status", description: "phase, models, config path" },
	{ value: "board", description: "live view of every flow on this machine" },
	{ value: "discuss", description: "discuss phase (read-only, talk before planning)" },
	{ value: "plan", arg: "[force]", next: true, description: "plan phase (read-only, planner model); from a quick scope card, a full flow" },
	{ value: "quick", arg: "[request]", description: "quick flow: short scope card, execute, one review, full delivery" },
	{ value: "approve", description: "approve the plan, switch to execute and start" },
	{ value: "execute", description: "execute phase without sending anything" },
	{ value: "off", description: "leave the workflow; restore the model from before the flow" },
	{ value: "escalate", description: "switch to the escalate model (Fable)" },
	{ value: "fable", description: "same as escalate" },
	{ value: "back", description: "return to the phase's own model" },
	{ value: "opusplan", description: "same as back" },
	{ value: "judge", arg: "[cancel]", next: true, description: "review the current diff now (in discuss: the conclusion; in plan: the plan)" },
	{ value: "tokens", description: "token breakdown of the current flow so far" },
	{ value: "model", arg: "[role] [provider/id[:thinking]]", next: true, description: "set a role's model (lists when left out)" },
	{ value: "autopilot", arg: "[on|off]", next: true, description: "resolve waits and routine menus without asking (no argument toggles)" },
	{ value: "reload", description: "re-read workflow.json" },
	{ value: "resume", arg: "[flowId]", description: "pick up an unfinished flow from its plan ref (e.g. on another device)" },
];

const FLOW_SECOND: Record<string, Sub[]> = {
	plan: [{ value: "force", description: "from discuss, move to plan without the discussion judge" }],
	autopilot: [
		{ value: "on", description: "resolve waits and routine menus without asking" },
		{ value: "off", description: "ask again" },
	],
	judge: [{ value: "cancel", description: "stop a running judge" }],
};

export const FLOW_UNKNOWN = (sub: string) => `Unknown: ${sub}. Try: ${valueList(FLOW_SUBS)}`;
export const isKnownFlow = (sub: string) => isKnown(FLOW_SUBS, sub.toLowerCase());

export interface FlowState {
	roles: readonly string[];
	specOf: (role: string) => RoleSpec;
	/** Models with auth; empty before the first session context. */
	models: () => { provider: string; id: string; name?: string }[];
}

export function flowCompletions(prefix: string, st: FlowState): AutocompleteItem[] | null {
	return safe(() => {
		const parts = words(prefix);
		if (parts.length <= 1) return subcommandCompletions(FLOW_SUBS, parts[0] ?? "");
		const sub = parts[0].toLowerCase();
		if (sub === "model") return roleCompletions("model", parts, st.roles, st.specOf, st.models);
		if (FLOW_SECOND[sub] && parts.length === 2) return subcommandCompletions(FLOW_SECOND[sub], parts[1], `${sub} `);
		return null;
	});
}

export const FOLDERS_SUBS: Sub[] = [
	{ value: "add", arg: "PATH", description: "add a folder to this session" },
	{ value: "remove", arg: "PATH or N", description: "remove a folder by path or list number" },
	{ value: "list", description: "the working folder and the added ones" },
];

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
			const typed = remM[1].trim().toLowerCase();
			const items = st.folders
				.map((f, i) => ({ value: `remove ${i + 1}`, label: `${i + 1}`, description: f, f, n: String(i + 1) }))
				.filter((x) => x.n.startsWith(typed) || x.f.toLowerCase().startsWith(typed))
				.map(({ value, label, description }) => ({ value, label, description }));
			return items.length > 0 ? items : null;
		}
		if (/\s/.test(prefix.trimStart())) return null;
		return subcommandCompletions(FOLDERS_SUBS, prefix);
	});
}
