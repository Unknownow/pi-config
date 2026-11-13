/**
 * Who this session is, decided late: a sub-session is found by its worktree in run.json, which may be written
 * a few seconds after the terminal opens. Until then (`unknown`) the workflow's claim events (K10-K13) are held,
 * so nothing shows locally by mistake. Pure.
 */

export type Identity = "unknown" | "sub" | "not-sub";

interface Held<T> {
	data: T;
	resolve: (v: unknown) => void;
}

/** Events held while the identity is unknown. Each holds a claim promise that settles on replay or release. */
export class HeldQueue<T> {
	private held: Held<T>[] = [];

	get size(): number {
		return this.held.length;
	}

	/** Holds one event; the returned promise is what the listener passes to `claim`. */
	hold(data: T): Promise<unknown> {
		return new Promise((resolve) => {
			this.held.push({ data, resolve });
		});
	}

	/** The session is a sub: each held event goes through `handler`, which claims through its second argument; an event it does not claim resolves to `null` (shown locally, as if nobody had claimed it). */
	replay(handler: (data: T, claim: (p: Promise<unknown>) => void) => void): void {
		const list = this.held;
		this.held = [];
		for (const h of list) {
			let claimed = false;
			try {
				handler(h.data, (p) => {
					claimed = true;
					h.resolve(p);
				});
			} catch {
				// a failing handler leaves the event unclaimed
			}
			if (!claimed) h.resolve(null);
		}
	}

	/** Not a sub, the run ended or the session closes: every held claim resolves to `value` (default `null`). */
	release(value: unknown = null): void {
		const list = this.held;
		this.held = [];
		for (const h of list) h.resolve(value);
	}
}

/** Answers every pending question with `text` (the run ended: nobody will answer). Returns how many. */
export function resolveAllPending(pending: Map<string, (m: { text: string }) => void>, text: string): number {
	const list = [...pending.values()];
	pending.clear();
	for (const done of list) done({ text });
	return list.length;
}

/** Text of that answer. */
export const RUN_ENDED_ANSWER = "The run ended; finish what you can without this answer.";
