/**
 * Generic claim pattern over the extension event bus (the shape K6 uses): the emitter adds a `claim`
 * function to the payload; a listener calls `claim(promise)` synchronously while it handles the event.
 * Claims made after the emit returned are ignored.
 */

export interface Claims {
	/** True when at least one listener claimed during the synchronous emit. */
	claimed: boolean;
	/** The first non-null answer, null when none or all are null, or `{ error }` on a rejection or timeout. */
	answer: Promise<unknown>;
}

const errText = (e: unknown): string => {
	const m = (e as { message?: unknown } | null | undefined)?.message;
	return typeof m === "string" && m ? m : String(e);
};

/** Emits `data` with a `claim` function added and reports at once whether anyone claimed. `timeoutMs` 0 means no timeout. */
export function emitClaims(emit: (data: unknown) => void, data: object, timeoutMs: number): Claims {
	type Settled = { ok: true; value: unknown } | { ok: false; error: string };
	const claims: Promise<Settled>[] = [];
	let collecting = true;
	const claim = (answer: unknown): void => {
		const p = Promise.resolve(answer);
		if (!collecting) {
			p.catch(() => {});
			return;
		}
		claims.push(p.then((value): Settled => ({ ok: true, value }), (e: unknown): Settled => ({ ok: false, error: errText(e) })));
	};
	try {
		emit({ ...data, claim });
	} catch {
		// a throwing listener is not an answer
	} finally {
		collecting = false;
	}
	if (claims.length === 0) return { claimed: false, answer: Promise.resolve(null) };
	const answer = (async (): Promise<unknown> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<"timeout">((resolve) => {
			if (timeoutMs > 0) timer = setTimeout(() => resolve("timeout"), timeoutMs);
		});
		try {
			const results = await Promise.race([Promise.all(claims), timeout]);
			if (results === "timeout") return { error: `no answer within ${Math.round(timeoutMs / 1000)} s` };
			const err = results.find((r) => !r.ok);
			if (err && !err.ok) return { error: err.error };
			for (const r of results) if (r.ok && r.value !== null && r.value !== undefined) return r.value;
			return null;
		} finally {
			if (timer) clearTimeout(timer);
		}
	})();
	return { claimed: true, answer };
}

/** Like `emitClaims`, for callers that only want the answer. */
export function gatherClaims(emit: (data: unknown) => void, data: object, timeoutMs: number): Promise<unknown> {
	return emitClaims(emit, data, timeoutMs).answer;
}
