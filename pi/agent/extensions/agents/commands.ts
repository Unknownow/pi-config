/** The `/agents` subcommand table and its completions. Pure: tests load it without pi. */
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { safe, subcommandCompletions, usageLine, valueList, words, type Sub } from "../shared/completions.ts";
import { roleCompletions, type RoleSpec } from "../shared/roles.ts";

export const AGENTS_SUBS: Sub[] = [
	{ value: "status", description: "each role's model and the config path" },
	{ value: "model", arg: "[role] [provider/id[:thinking]]", next: true, description: "set a role's model (pickers when left out)" },
];

export const agentsDescription = () => `Models of the explore, advisor and test_run helpers: ${usageLine(AGENTS_SUBS).replaceAll(" | ", ", ")}`;
export const agentsUnknown = (sub: string) => `agents: unknown ${sub}. Try: ${valueList(AGENTS_SUBS)}`;

export interface AgentsState {
	roles: readonly string[];
	/** Reads the config file. */
	specOf: (role: string) => RoleSpec;
	/** Models with auth; empty before the first session context. */
	models: () => { provider: string; id: string; name?: string }[];
}

export function agentsCompletions(prefix: string, st: AgentsState): AutocompleteItem[] | null {
	return safe(() => {
		const parts = words(prefix);
		if (parts.length <= 1) return subcommandCompletions(AGENTS_SUBS, parts[0] ?? "");
		if (parts[0] === "model") return roleCompletions("model", parts, st.roles, st.specOf, st.models);
		return null;
	});
}
