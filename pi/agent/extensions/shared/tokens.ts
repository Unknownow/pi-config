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

/** The cost weights workflow.json starts with; the agents extension always uses these. */
export const DEFAULT_TOKEN_WEIGHTS: TokenWeights = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };

export function countTokens(u: UsageCounts | undefined, w: TokenWeights): Tok {
	if (!u) return { raw: 0, cost: 0 };
	const input = u.input ?? 0;
	const output = u.output ?? 0;
	const cacheRead = u.cacheRead ?? 0;
	const cacheWrite = u.cacheWrite ?? 0;
	const cost = input * w.input + output * w.output + cacheRead * w.cacheRead + cacheWrite * w.cacheWrite;
	return { raw: input + output + cacheRead + cacheWrite, cost: Math.round(cost) };
}

export const zero = (): Tok => ({ raw: 0, cost: 0 });
export const isZero = (t: Tok): boolean => t.raw === 0 && t.cost === 0;
export const add = (a: Tok, b: Tok): Tok => ({ raw: a.raw + b.raw, cost: a.cost + b.cost });
export const max = (a: Tok, b: Tok): Tok => ({ raw: Math.max(a.raw, b.raw), cost: Math.max(a.cost, b.cost) });
export const same = (a: Tok, b: Tok): boolean => a.raw === b.raw && a.cost === b.cost;

/** Summaries saved before counts were tracked as raw and cost held a single number; show it as both. */
export function asTok(x: Tok | number | undefined): Tok {
	if (typeof x === "number") return { raw: x, cost: x };
	return x ?? zero();
}

/** The four kinds of tokens, as the provider reports them. */
export interface ModelCounts {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export const noCounts = (): ModelCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
export const countsOf = (u: UsageCounts | undefined): ModelCounts => ({ input: u?.input ?? 0, output: u?.output ?? 0, cacheRead: u?.cacheRead ?? 0, cacheWrite: u?.cacheWrite ?? 0 });
export const maxCounts = (a: ModelCounts, b: ModelCounts): ModelCounts => ({
	input: Math.max(a.input, b.input),
	output: Math.max(a.output, b.output),
	cacheRead: Math.max(a.cacheRead, b.cacheRead),
	cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
});
export const addCounts = (a: ModelCounts, b: ModelCounts): ModelCounts => ({
	input: a.input + b.input,
	output: a.output + b.output,
	cacheRead: a.cacheRead + b.cacheRead,
	cacheWrite: a.cacheWrite + b.cacheWrite,
});

/** Exact count with thousands separators, e.g. 1,204,331. */
export function exact(n: number): string {
	return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Raw count, with the cost-weighted count in brackets when they differ. */
export function fmtTok(t: Tok): string {
	return t.raw === t.cost ? exact(t.raw) : `${exact(t.raw)} (${exact(t.cost)})`;
}
