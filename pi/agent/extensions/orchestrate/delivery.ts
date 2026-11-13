/** Merge confirmation by delivered trees. Pure: no I/O, no workflow imports. */

export type EndHow = "finished" | "stopped" | "abandoned" | "unknown";
export type DeliveryKind = "merge" | "protected-push";

export interface Delivery {
	tree: string;
	kind: DeliveryKind;
	at?: string;
}

export interface MergeRecord {
	key: string;
	tree: string;
	kind: DeliveryKind;
	at: string;
}

interface Msg {
	type: string;
	ts?: string;
	data?: Record<string, unknown>;
}

const isDeliveryKind = (k: unknown): k is DeliveryKind => k === "merge" || k === "protected-push";

/** The K11 question a sub-session answers. A payload without `ask` is a "pre" check. */
export function mergeGateDecision(c: {
	ask?: unknown;
	kind?: unknown;
	tree: string;
	treeGiven: boolean;
	key: string;
	accepted: boolean;
	verdictOk: boolean;
	requested: boolean;
	runEnded: boolean;
}): { pass: boolean; refusal?: string; request?: Record<string, unknown>; mergePass?: Record<string, unknown> } {
	if (c.runEnded) return { pass: true };
	const ask = c.ask === "gate" ? "gate" : "pre";
	const kind = typeof c.kind === "string" && c.kind ? c.kind : "merge";
	const where = c.key ? ` of repo ${c.key}` : "";
	if (c.accepted && c.verdictOk) {
		if (ask === "gate" && isDeliveryKind(kind) && c.treeGiven) return { pass: true, mergePass: { tree: c.tree, repo: c.key, kind } };
		return { pass: true };
	}
	if (ask !== "gate") {
		return { pass: false, refusal: `Tree ${c.tree}${where} is not accepted by the orchestrator yet. \`git_task\` can't ask for acceptance: merge with \`gh pr merge\` in the main session, so the gate asks the orchestrator.` };
	}
	const refusal = `The orchestrator has not accepted tree ${c.tree}${where} yet. An acceptance request was sent; end your turn. You get a message when it answers; then retry the merge.`;
	if (c.requested) return { pass: false, refusal };
	return { pass: false, refusal, request: { tree: c.tree, repo: c.key, kind, ask } };
}

const howOf = (v: unknown): EndHow => (v === "finished" || v === "stopped" || v === "abandoned" ? v : "unknown");

/** Splits one read of a sub's outbox: merge-pass records, the last flow-ended, and everything else. */
export function applyOutbox(msgs: Msg[]): { merges: MergeRecord[]; end?: { at: string; how: EndHow }; rest: Msg[] } {
	const merges: MergeRecord[] = [];
	const rest: Msg[] = [];
	let end: { at: string; how: EndHow } | undefined;
	for (const m of msgs) {
		if (m.type === "merge-pass") {
			const tree = typeof m.data?.tree === "string" ? m.data.tree : "";
			if (!tree) continue;
			merges.push({ key: String(m.data?.repo ?? ""), tree, kind: isDeliveryKind(m.data?.kind) ? m.data.kind : "merge", at: m.ts ?? "" });
		} else if (m.type === "flow-ended") end = { at: m.ts ?? "", how: howOf(m.data?.how) };
		else rest.push(m);
	}
	return { merges, end, rest };
}

export interface Verdict {
	accept?: unknown;
	tree?: unknown;
	repo?: unknown;
	kind?: unknown;
	ask?: unknown;
	ts?: string;
}

/** The newest delivered tree of repo `key`, or null. */
export function lastDelivery(c: { merges: MergeRecord[]; verdicts: Verdict[]; accepted: string[]; key: string; workingKey: string }): Delivery | null {
	let best: Delivery | null = null;
	const take = (d: Delivery): void => {
		if (!best || (d.at ?? "") >= (best.at ?? "")) best = d;
	};
	for (const v of c.verdicts) {
		if (v.accept !== true || typeof v.tree !== "string") continue;
		if (String(v.repo ?? c.workingKey) !== c.key) continue;
		if (v.ask === undefined) take({ tree: v.tree, kind: "merge", at: v.ts ?? "" });
		else if (v.ask === "gate" && isDeliveryKind(v.kind)) take({ tree: v.tree, kind: v.kind, at: v.ts ?? "" });
	}
	for (const m of c.merges) if (m.key === c.key) take({ tree: m.tree, kind: m.kind, at: m.at });
	if (best) return best;
	for (let i = c.accepted.length - 1; i >= 0; i--) {
		const t = c.accepted[i];
		if (c.key ? t.startsWith(`${c.key}:`) : !t.includes(":")) return { tree: c.key ? t.slice(c.key.length + 1) : t, kind: "merge" };
	}
	return null;
}

export interface RepoResult {
	changed: boolean;
	ok: boolean | null;
	missing: string[];
	notes: string[];
}

/** Whether the work of one repo is merged. */
export function deliveryMerged(c: {
	key: string;
	delivery: Delivery | null;
	prTrees: { has(tree: string): boolean };
	prUnknown: boolean;
	targetTrees: { has(tree: string): boolean };
	targetUnknown?: boolean;
	commitsSinceBase: number | null;
	dirtyFiles: number;
	headTree: string | null;
	branchMerged?: boolean | null;
	base?: string;
}): RepoResult {
	const label = c.key || "the repo";
	const notes: string[] = [];
	const missing: string[] = [];
	if (c.dirtyFiles > 0) notes.push(`uncommitted files left in ${label} (${c.dirtyFiles} files)`);
	if (c.delivery && c.headTree && c.headTree !== c.delivery.tree) notes.push(`HEAD of ${label} differs from its last delivered tree; check for undelivered work`);
	const changed = c.delivery !== null || c.commitsSinceBase !== 0;
	if (!changed) return { changed: false, ok: true, missing, notes };
	const into = c.base ? ` into ${c.base}` : "";
	if (c.delivery) {
		const t = c.delivery.tree.slice(0, 12);
		if (c.delivery.kind === "protected-push") {
			const ok = c.targetTrees.has(c.delivery.tree) ? true : c.targetUnknown ? null : false;
			if (ok === false) missing.push(`tree ${t} of ${label} was not found in ${c.base ?? "the target"}`);
			if (ok === null) missing.push(`the target of ${label} could not be read`);
			return { changed, ok, missing, notes };
		}
		const ok = c.prTrees.has(c.delivery.tree) ? true : c.prUnknown ? null : false;
		if (ok === false) missing.push(`tree ${t} of ${label} is in no merged pull request${into}`);
		if (ok === null) missing.push(`the merged pull requests of ${label}${into} could not be listed`);
		return { changed, ok, missing, notes };
	}
	if (c.branchMerged === true) return { changed, ok: true, missing, notes };
	if (c.branchMerged === null) return { changed, ok: null, missing: [`the branch of ${label} could not be checked`], notes };
	return { changed, ok: false, missing: [`no accepted tree in ${label}`], notes };
}

export function combineRepos(results: RepoResult[]): { ok: boolean | null; missing: string[]; notes: string[] } {
	const notes = results.flatMap((r) => r.notes);
	const changed = results.filter((r) => r.changed);
	if (!changed.length) return { ok: false, missing: ["no repo has changes"], notes };
	const missing = changed.flatMap((r) => r.missing);
	if (changed.some((r) => r.ok === false)) return { ok: false, missing, notes };
	if (changed.some((r) => r.ok === null)) return { ok: null, missing, notes };
	return { ok: true, missing, notes };
}

export function endDecision(c: { endHow?: EndHow; ok: boolean | null; manual: boolean; force: boolean; checks: number }): "merge" | "wait" | "report" {
	if (c.force) return "merge";
	if (c.manual) return c.ok === true ? "merge" : "report";
	if (c.endHow !== "finished") return "report";
	if (c.ok === true) return "merge";
	return c.ok === false && c.checks === 0 ? "wait" : "report";
}

export function shouldPoll(s: { state: string; endedAt?: string; endHow?: EndHow; endChecks?: number }): boolean {
	if (s.state === "merged" || s.state === "stopped" || !s.endedAt) return false;
	return s.endHow === "finished" || (s.endChecks ?? 0) === 0;
}

export function parseMergedArgs(args: string): { id: string; force: boolean } | { error: string } {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const force = parts.includes("--force");
	const rest = parts.filter((p) => p !== "--force");
	if (rest.length !== 1) return { error: "usage: /orch merged <id> [--force]" };
	return { id: rest[0], force };
}

export function verdictPayload(request: { tree: string; repo: string; kind?: unknown; ask?: unknown }, accept: boolean): Record<string, unknown> {
	return { accept, tree: request.tree, repo: request.repo, ...(request.kind !== undefined ? { kind: request.kind } : {}), ...(request.ask !== undefined ? { ask: request.ask } : {}) };
}

export function stateAfterVerdict<S extends string>(state: S): S | "executing" {
	return state === "awaiting-acceptance" ? "executing" : state;
}

export function parseRemoteUrl(url: string): string | null {
	const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
	return m ? `${m[1]}/${m[2]}` : null;
}

/** The remote a ref like `origin/feat/x` lives on (longest matching remote name, else origin) and its owner/name. */
export function pickGhRepo(remotes: Array<{ name: string; url: string }>, ref?: string | null): { remote: string; slug: string } | null {
	let pick = ref ? [...remotes].filter((r) => ref.startsWith(`${r.name}/`)).sort((a, b) => b.name.length - a.name.length)[0] : undefined;
	if (!pick) pick = remotes.find((r) => r.name === "origin");
	if (!pick) return null;
	const slug = parseRemoteUrl(pick.url);
	return slug ? { remote: pick.name, slug } : null;
}

export function pickBase(ref: string | null | undefined, remote: string): string | null {
	if (!ref) return null;
	return ref.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : ref;
}

export const needsBiggerPage = (n: number, limit: number): boolean => n >= limit;

export function listingAction(cached: { round: number } | undefined, round: number): "use" | "refresh" {
	return cached && cached.round === round ? "use" : "refresh";
}

/** Merged PRs since the run began, by head tree. A head whose tree cannot be read counts in `unknown`. */
export function prTreeIndex(prs: Array<{ number: number; headRefOid: string; mergedAt?: string | null }>, createdAt: string, treeOf: (sha: string) => string | null): { trees: Map<string, number>; unknown: number } {
	const trees = new Map<string, number>();
	let unknown = 0;
	for (const p of prs) {
		if (!p.mergedAt || p.mergedAt < createdAt) continue;
		const t = treeOf(p.headRefOid);
		if (t) trees.set(t, p.number);
		else unknown++;
	}
	return { trees, unknown };
}
