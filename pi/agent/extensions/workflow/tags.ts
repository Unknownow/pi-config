/** The tag action of `deliver`: when and how a tag is pushed. Pure decisions, kept apart so node tests can reach them. */

export type TagDecision =
	| { action: "create" }
	| { action: "move"; lease: string }
	| { action: "refuse"; text: string; ok?: boolean }
	| { action: "wait"; reason: string };

export function tagDecision(o: { name?: string; planned: boolean; move: boolean; remoteSha?: string; target: string; onDefault: boolean; oldIsAncestor?: boolean }): TagDecision {
	const name = o.name ?? "the tag";
	if (!o.onDefault) return { action: "wait", reason: `commit ${o.target} is not on the remote default branch` };
	if (o.move && !o.planned) return { action: "refuse", text: "moving a tag needs a plan step that names it" };
	if (!o.remoteSha) return { action: "create" };
	if (o.remoteSha === o.target) return { action: "refuse", text: `tag ${name} already points at ${o.target}; nothing to do`, ok: true };
	if (!o.move) {
		const text = `tag ${name} taken (points at ${o.remoteSha})`;
		return o.planned ? { action: "wait", reason: text } : { action: "refuse", text: `${text}; pick the next free name` };
	}
	if (!o.oldIsAncestor) return { action: "wait", reason: `moving ${name} from ${o.remoteSha} to ${o.target} would drop commits` };
	return { action: "move", lease: o.remoteSha };
}

/** Git arguments for the push. Never `--no-verify`, never a bare `--force`. */
export function pushArgs(remote: string, name: string, target: string, lease?: string): string[] {
	const spec = `${target}:refs/tags/${name}`;
	return lease ? ["push", `--force-with-lease=refs/tags/${name}:${lease}`, remote, spec] : ["push", remote, spec];
}
