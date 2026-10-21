/**
 * Contract K6: `/folders add` asks other extensions whether to replace or refuse a folder.
 * Listeners of `workflow:folder-add` call `claim(promise)` synchronously; this helper waits for them.
 */

export type FolderAddAnswer = { folder: string } | { error: string } | null;

type Settled = { kind: "folder"; folder: string } | { kind: "error"; error: string } | { kind: "none" };

export async function askFolderAdd(
	emit: (data: unknown) => void,
	cwd: string,
	folder: string,
	timeoutMs = 300_000,
): Promise<{ folder: string } | { error: string }> {
	const claims: Promise<Settled>[] = [];
	let collecting = true;
	const claim = (answer: Promise<FolderAddAnswer>): void => {
		if (!collecting) {
			Promise.resolve(answer).catch(() => {});
			return;
		}
		claims.push(
			Promise.resolve(answer).then(
				(a): Settled => {
					if (a && typeof a === "object") {
						const o = a as { folder?: unknown; error?: unknown };
						if (typeof o.error === "string" && o.error) return { kind: "error", error: o.error };
						if (typeof o.folder === "string" && o.folder) return { kind: "folder", folder: o.folder };
					}
					return { kind: "none" };
				},
				(e: unknown): Settled => {
					const m = (e as { message?: unknown } | null | undefined)?.message;
					return { kind: "error", error: typeof m === "string" && m ? m : String(e) };
				},
			),
		);
	};
	try {
		emit({ v: 1, cwd, folder, claim });
	} catch {
		// a throwing listener is not an answer
	} finally {
		collecting = false;
	}
	if (claims.length === 0) return { folder };
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<Settled>((resolve) => {
		timer = setTimeout(() => resolve({ kind: "error", error: `no answer from a folder-add listener within ${Math.round(timeoutMs / 1000)} s` }), timeoutMs);
	});
	try {
		const results = await Promise.race([Promise.all(claims), timeout]);
		if (!Array.isArray(results)) return { error: results.kind === "error" ? results.error : "folder-add failed" };
		const err = results.find((r) => r.kind === "error");
		if (err && err.kind === "error") return { error: err.error };
		const rep = results.find((r) => r.kind === "folder");
		return rep && rep.kind === "folder" ? { folder: rep.folder } : { folder };
	} finally {
		if (timer) clearTimeout(timer);
	}
}
