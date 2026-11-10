/** A plan verdict counts only for the plan it names (`data.n`); an older verdict must not approve a newer plan. */
export function verdictMatches(pendingN: number | undefined, msg: { data?: Record<string, unknown> }): boolean {
	return pendingN !== undefined && typeof msg.data?.n === "number" && msg.data.n === pendingN;
}
