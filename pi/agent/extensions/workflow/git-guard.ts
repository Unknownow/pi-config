/**
 * Subagent-only extension: the git_task subagent's guard. The workflow passes what it needs in
 * PI_WORKFLOW_GIT_GUARD (JSON, see GitGuardSpec); bash commands are checked with the same rules
 * and the same judge gate as the main session's guard. pi loads only index.ts from this folder,
 * so the main session never runs it.
 */
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defaultRunner, gateCheck } from "./merge-gate.ts";
import { registryPublishProblem, repoMatches, shellProblem } from "./push-guard.ts";
import { repoKey } from "./repos.ts";

export const GIT_GUARD_ENV = "PI_WORKFLOW_GIT_GUARD";

export interface GitGuardSpec {
	/** Every repo of a multi-repo flow, changed or not; empty for a single repo. */
	roots: string[];
	protectedBranches: string[];
	/** repoKey -> snapshot trees of every judge PASS this flow. */
	passedTrees: Record<string, string[]>;
	noMerge: boolean;
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

/** The spec in the env value, or null when it is missing or malformed. */
export function parseGuardSpec(raw: string | undefined): GitGuardSpec | null {
	if (!raw) return null;
	let p: unknown;
	try {
		p = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof p !== "object" || p === null || Array.isArray(p)) return null;
	const o = p as Record<string, unknown>;
	if (!isStrings(o.roots) || !isStrings(o.protectedBranches) || typeof o.noMerge !== "boolean") return null;
	const trees = o.passedTrees;
	if (typeof trees !== "object" || trees === null || Array.isArray(trees)) return null;
	if (!Object.values(trees).every(isStrings)) return null;
	return { roots: o.roots, protectedBranches: o.protectedBranches, passedTrees: trees as Record<string, string[]>, noMerge: o.noMerge };
}

function gitOut(dir: string, args: string[]): string {
	const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 30_000 });
	return r.status === 0 ? r.stdout.trim() : "";
}

export default function gitGuard(pi: ExtensionAPI): void {
	const spec = parseGuardSpec(process.env[GIT_GUARD_ENV]);
	pi.on("tool_call", async (event, ctx) => {
		if (!/(^|__)bash$/.test(event.toolName)) return;
		const command = String((event.input as { command?: unknown })?.command ?? "");
		const registry = registryPublishProblem(command);
		if (registry) return { block: true, reason: registry };
		if (!/\bgit\b|\bgh\b/i.test(command)) return;
		if (!spec) return { block: true, reason: "Refused: the git guard's settings are missing." };
		const branches = new Map<string, string>();
		const branchOf = async (dir: string) => {
			if (!branches.has(dir)) branches.set(dir, gitOut(dir, ["rev-parse", "--abbrev-ref", "HEAD"]));
			return branches.get(dir) as string;
		};
		const gate = async (kind: "merge" | "protected-push", root: string | undefined, target: string | undefined, repo?: string): Promise<string | null> => {
			const dir = root ?? ctx.cwd;
			const key = repoKey(gitOut(dir, ["rev-parse", "--show-toplevel"]) || dir);
			const res = await gateCheck(defaultRunner, kind, dir, target, { passedTrees: spec.passedTrees[key] ?? [], noMerge: spec.noMerge, repo });
			return res.problem;
		};
		const isTag = async (root: string | undefined, name: string) => gitOut(root ?? ctx.cwd, ["tag", "--list", name]) === name;
		const repoRoot = async (repo: string): Promise<string | null> => {
			const candidates = spec.roots.length ? spec.roots : [gitOut(ctx.cwd, ["rev-parse", "--show-toplevel"])];
			for (const root of candidates.filter(Boolean)) {
				const names = gitOut(root, ["remote"]).split("\n").map((s) => s.trim()).filter(Boolean);
				const name = names.includes("origin") ? "origin" : names[0];
				const url = name ? gitOut(root, ["remote", "get-url", name]) : "";
				if (url && repoMatches(url, repo)) return root;
			}
			return null;
		};
		const problem = await shellProblem(command, false, {
			roots: spec.roots.length ? spec.roots : undefined,
			cwd: ctx.cwd,
			protectedBranches: spec.protectedBranches,
			branchOf,
			gate,
			isTag,
			repoRoot,
		});
		if (problem) return { block: true, reason: `Refused: ${problem}. Never force-push, skip hooks, or merge or push to a protected branch before the judge has passed this tree.` };
	});
}
