/**
 * Subagent-only extension: the commit step's push guard. The workflow passes the delivery it
 * allows in PI_WORKFLOW_COMMIT_GUARD (JSON, see CommitGuardSpec); bash commands that publish
 * more than that are refused, with the same rules as the main session's guard. pi loads only
 * index.ts from this folder, so the main session never runs it.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { shellProblem } from "./push-guard.ts";
import { repoKey } from "../shared/repos.ts";

export const COMMIT_GUARD_ENV = "PI_WORKFLOW_COMMIT_GUARD";

export interface CommitGuardSpec {
	protectedBranches: string[];
	/** Every repo of a multi-repo flow, changed or not; empty for a single repo. */
	roots: string[];
	/** The delivery mode of the working folder (commit, push, pr, merge). */
	mode?: string;
	/** Several repos: each one's own mode. */
	repos: { root: string; mode: string }[];
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

/** The spec in the env value, or null when it is missing or malformed. */
export function parseGuardSpec(raw: string | undefined): CommitGuardSpec | null {
	if (!raw) return null;
	let p: unknown;
	try {
		p = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof p !== "object" || p === null || Array.isArray(p)) return null;
	const o = p as Record<string, unknown>;
	if (!isStrings(o.protectedBranches)) return null;
	if (o.mode !== undefined && typeof o.mode !== "string") return null;
	const roots = o.roots === undefined ? [] : o.roots;
	if (!isStrings(roots)) return null;
	const repos = o.repos === undefined ? [] : o.repos;
	if (!Array.isArray(repos)) return null;
	for (const r of repos) {
		if (typeof r !== "object" || r === null || typeof (r as { root?: unknown }).root !== "string" || typeof (r as { mode?: unknown }).mode !== "string") return null;
	}
	return { protectedBranches: o.protectedBranches, roots, mode: o.mode as string | undefined, repos: repos as CommitGuardSpec["repos"] };
}

export default function commitGuard(pi: ExtensionAPI): void {
	const spec = parseGuardSpec(process.env[COMMIT_GUARD_ENV]);
	pi.on("tool_call", async (event, ctx) => {
		if (!/(^|__)bash$/.test(event.toolName)) return;
		const command = String((event.input as { command?: unknown })?.command ?? "");
		if (!/\bgit\b|\bgh\b/i.test(command)) return;
		if (!spec) return { block: true, reason: "Refused: the commit step's guard settings are missing." };
		const branches = new Map<string, string>();
		const branchOf = async (dir: string) => {
			if (!branches.has(dir)) {
				const r = await pi.exec("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 30_000 });
				branches.set(dir, r.stdout.trim());
			}
			return branches.get(dir) as string;
		};
		const modeOf = (root: string | undefined) => (root ? spec.repos.find((r) => repoKey(r.root) === repoKey(root))?.mode : undefined) ?? spec.mode;
		const problem = await shellProblem(command, false, {
			roots: spec.roots.length ? spec.roots : undefined,
			cwd: ctx.cwd,
			protectedBranches: spec.protectedBranches,
			branchOf,
			modeOf,
		});
		if (problem) return { block: true, reason: `Refused: ${problem}. Never force-push, skip hooks, or push, open or merge beyond this commit step's delivery.` };
	});
}
