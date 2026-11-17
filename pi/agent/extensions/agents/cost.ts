/**
 * Cost of a subagent run in one unit across models: cost-weighted input-token equivalents
 * (`countTokens` with DEFAULT_TOKEN_WEIGHTS) times the model's multiplier from agents.json `modelCost`.
 * Not dollars: pi's `usage.cost` is the provider's dollar price and is kept apart.
 */

import { countTokens, DEFAULT_TOKEN_WEIGHTS, type UsageCounts } from "../shared/tokens.ts";
import { loadConfig } from "./config.ts";

/** The multiplier of `model`: the longest key that is a case-insensitive substring of the model id; 1.0 without a match. */
export function modelMultiplier(model: string | undefined, table: Record<string, number>): number {
	const id = (model ?? "").toLowerCase();
	if (!id) return 1;
	const key = Object.keys(table)
		.filter((k) => k && id.includes(k.toLowerCase()))
		.sort((a, b) => b.length - a.length)[0];
	return key === undefined ? 1 : table[key];
}

/** Weighted cost of `usage` on `model`, rounded. `table` defaults to agents.json `modelCost`. */
export function costOf(usage: UsageCounts | undefined, model: string | undefined, table: Record<string, number> = loadConfig().config.modelCost): number {
	return Math.round(countTokens(usage, DEFAULT_TOKEN_WEIGHTS).cost * modelMultiplier(model, table));
}
