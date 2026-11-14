/** The `/quiet` subcommand table and its completions. Pure: tests load it without pi. */
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { subcommandCompletions, valueList, type Sub } from "../shared/completions.ts";

export const QUIET_SUBS: Sub[] = [
	{ value: "on", description: "hide finished tool rows" },
	{ value: "off", description: "show finished tool rows" },
];

export const quietUsage = () => `quiet: usage /quiet [${valueList(QUIET_SUBS, "|")}]`;
export const quietDescription = () => `Hide or show finished tool rows (/quiet toggles, /quiet ${valueList(QUIET_SUBS, ", /quiet ")})`;

export function quietCompletions(prefix: string): AutocompleteItem[] | null {
	return /\s/.test(prefix.trimStart()) ? null : subcommandCompletions(QUIET_SUBS, prefix);
}
