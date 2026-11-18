/** The `/flow` subcommand table and its completions. Pure: tests load it without pi. (`/folders` belongs to the workspace extension.) */
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { isKnown, safe, subcommandCompletions, valueList, words, type Sub } from "../shared/completions.ts";
import { roleCompletions, type RoleSpec } from "../shared/roles.ts";

export const FLOW_SUBS: Sub[] = [
	{ value: "status", description: "phase, models, config path" },
	{ value: "board", description: "live view of every flow on this machine" },
	{ value: "discuss", description: "discuss phase (read-only, talk before planning)" },
	{ value: "plan", arg: "[force]", next: true, description: "plan phase (read-only, planner model)" },
	{ value: "approve", description: "approve the plan, switch to execute and start" },
	{ value: "execute", description: "execute phase without sending anything" },
	{ value: "off", description: "leave the workflow; restore the model from before the flow" },
	{ value: "escalate", description: "switch to the escalate model (Fable)" },
	{ value: "fable", description: "same as escalate" },
	{ value: "back", description: "return to the phase's own model" },
	{ value: "opusplan", description: "same as back" },
	{ value: "critic", arg: "[cancel]", next: true, description: "critic review now: the conclusion in discuss, the plan in plan (in execute use the judge tool)" },
	{ value: "tokens", description: "token breakdown of the current flow so far" },
	{ value: "model", arg: "[role] [provider/id[:thinking]]", next: true, description: "set a role's model (lists when left out)" },
	{ value: "autopilot", arg: "[on|off]", next: true, description: "resolve waits and routine menus without asking (no argument toggles)" },
	{ value: "reload", description: "re-read workflow.json" },
	{ value: "resume", arg: "[flowId]", description: "pick up an unfinished flow from its plan ref (e.g. on another device)" },
];

const FLOW_SECOND: Record<string, Sub[]> = {
	plan: [{ value: "force", description: "from discuss, move to plan without the discussion critic" }],
	autopilot: [
		{ value: "on", description: "resolve waits and routine menus without asking" },
		{ value: "off", description: "ask again" },
	],
	critic: [{ value: "cancel", description: "stop a running critic review" }],
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
