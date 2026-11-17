/** The `/orch` subcommand table and its completions. Pure: tests load it without pi. */
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { isKnown, safe, subcommandCompletions, usageLine, words, type Sub } from "../shared/completions.ts";

export const ORCH_SUBS: Sub[] = [
	{ value: "start", arg: "[title]", description: "start orchestrating: read-only discussion; \"go\" on a proposal runs the proposal judge first" },
	{ value: "mode", description: "show the orchestrator mode" },
	{ value: "off", description: "lift the read-only guard (a watcher keeps running)" },
	{ value: "go", arg: "[force]", next: true, description: "run the proposal without the judge" },
	{ value: "judge", arg: "[cancel]", next: true, description: "stop a running proposal judge" },
	{ value: "status", description: "the run's packages and their states" },
	{ value: "board", description: "live board of the run" },
	{ value: "watch", description: "resume watching an active run of this repo" },
	{ value: "merge", arg: "<id> [--force]", next: true, description: "merge an accepted PR now; --force skips the acceptance" },
	{ value: "end", description: "end the run (unfinished jobs are stopped)" },
];

export const isKnownOrch = (sub: string) => isKnown(ORCH_SUBS, sub);
export const orchUsage = () => `usage: /orch ${usageLine(ORCH_SUBS)}`;
export const orchDescription = () => `Orchestrator mode and run: ${usageLine(ORCH_SUBS)}`;

const SECOND: Record<string, Sub[]> = {
	go: [{ value: "force", description: "run the proposal without the judge (propose mode only)" }],
	judge: [{ value: "cancel", description: "stop the running proposal judge" }],
};

export interface OrchState {
	/** Package ids of the owned workflow run; null when there is no owned run or it is a relay run. */
	packages: () => { id: string; state: string; goal?: string }[] | null;
}

export function orchCompletions(prefix: string, st: OrchState): AutocompleteItem[] | null {
	return safe(() => {
		const parts = words(prefix);
		if (parts.length <= 1) return subcommandCompletions(ORCH_SUBS, parts[0] ?? "");
		const sub = parts[0];
		if (SECOND[sub] && parts.length === 2) return subcommandCompletions(SECOND[sub], parts[1], `${sub} `);
		if (sub !== "merge" || parts.length > 3) return null;
		if (parts.length === 3) {
			const items = subcommandCompletions([{ value: "--force", description: "merge without the acceptance" }], parts[2], `merge ${parts[1]} `);
			return items;
		}
		const pkgs = st.packages();
		if (!pkgs) return null;
		const items = pkgs
			.filter((p) => p.id.startsWith(parts[1]))
			.map((p) => ({ value: `merge ${p.id} `, label: p.id, description: `${p.state}${p.goal ? `: ${p.goal.split("\n")[0].slice(0, 60)}` : ""}` }));
		return items.length > 0 ? items : null;
	});
}
