/** The `/relay` subcommand table and its completions. Pure: tests load it without pi. */
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { roleCompletions, type RoleSpec } from "../shared/roles.ts";
import { safe, subcommandCompletions, usageLine, words, type Sub } from "../shared/completions.ts";

export const RELAY_SUBS: Sub[] = [
	{ value: "status", description: "lead mode and this session's jobs" },
	{ value: "on", description: "turn lead mode on" },
	{ value: "off", description: "turn lead mode off (refused while this lead owns running jobs)" },
	{ value: "go", description: "turn lead mode on and send the kickoff" },
	{ value: "stop", arg: "<job>", description: "stop a job" },
	{ value: "pause", arg: "<job>", description: "pause a job so you can work in its set" },
	{ value: "resume", arg: "<job>", description: "resume a paused job" },
	{ value: "followup", arg: "<job> <text>", description: "send a follow-up task to a finished job" },
	{ value: "log", arg: "<job> [n]", description: "the last n log lines of a job (default 20)" },
	{ value: "model", arg: "<role> <provider/id[:thinking]>", description: "set the model of a relay role" },
];

export const RELAY_ROLES = ["critic", "judge", "escalate", "worker.small", "worker.normal", "worker.large"] as const;

/** Subcommands that take a job id as their first argument. */
const JOB_SUBS = ["stop", "pause", "resume", "followup", "log"];

export const relayDescription = () => `relay: ${usageLine(RELAY_SUBS)}`;

export interface RelayState {
	/** This session's jobs, from memory. */
	jobs: () => { id: string; state: string }[];
	specOf: (role: string) => RoleSpec;
	/** Models with auth; empty before the first session context. */
	models: () => { provider: string; id: string; name?: string }[];
}

export function relayCompletions(prefix: string, st: RelayState): AutocompleteItem[] | null {
	return safe(() => {
		const parts = words(prefix);
		if (parts.length <= 1) return subcommandCompletions(RELAY_SUBS, parts[0] ?? "");
		const sub = parts[0];
		if (sub === "model") return roleCompletions("model", parts, RELAY_ROLES, st.specOf, st.models);
		if (parts.length === 2 && JOB_SUBS.includes(sub)) {
			const items = st.jobs()
				.filter((j) => j.id.startsWith(parts[1]))
				.map((j) => ({ value: `${sub} ${j.id}${sub === "followup" || sub === "log" ? " " : ""}`, label: j.id, description: j.state }));
			return items.length > 0 ? items : null;
		}
		return null;
	});
}
