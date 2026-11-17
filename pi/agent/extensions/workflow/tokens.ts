export interface TokenWeights {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Usage fields as pi reports them on assistant messages and subagent events. */
export interface UsageCounts {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

/** A count of tokens: the raw total, and the cost-weighted total (tokenWeights). */
export interface Tok {
	raw: number;
	cost: number;
}

export function countTokens(u: UsageCounts | undefined, w: TokenWeights): Tok {
	if (!u) return { raw: 0, cost: 0 };
	const input = u.input ?? 0;
	const output = u.output ?? 0;
	const cacheRead = u.cacheRead ?? 0;
	const cacheWrite = u.cacheWrite ?? 0;
	const cost = input * w.input + output * w.output + cacheRead * w.cacheRead + cacheWrite * w.cacheWrite;
	return { raw: input + output + cacheRead + cacheWrite, cost: Math.round(cost) };
}
