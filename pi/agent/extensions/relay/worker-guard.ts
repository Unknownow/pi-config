/** The worker's guard (pure): what a headless worker may not run or edit. Every refusal points to `ask_lead`. */

import * as fs from "node:fs";
import * as path from "node:path";
import { gitSubcommand, parseCommands, unwrapCommand } from "../shared/readonly-bash.ts";
import { allowed, classifyCommand, pathCategory } from "./authority.ts";
import { type AuthorityItem, parseBrief } from "./brief.ts";
import type { Category } from "./config.ts";
import { normPath } from "./glob.ts";
import { type Approval, readJob } from "./job.ts";
import { findReply, inboxPath } from "./mailbox.ts";

/** What the guard needs about the job; written by dispatch (`guard.json`) and read on every call. */
export interface GuardFacts {
	/** The job's branches (one per repo). */
	branches: string[];
	/** The job's base shas. */
	bases: string[];
	/** The job's worktrees: a sensitive-path glob is matched against the path inside the worktree that holds it. */
	worktrees?: string[];
	sensitivePaths: string[];
	authority: Partial<Record<Category, AuthorityItem>>;
	approvals: Approval[];
}

const HINT = " Use ask_lead (with `approval` when you need a sensitive action approved); relay does outward actions itself.";
const baseName = (w: string) => w.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "pwsh", "powershell"]);
const GH_READ = new Set(["view", "list", "status", "checks", "diff"]);

const refOk = (ref: string, f: GuardFacts): boolean => {
	if (ref === "HEAD" || /^HEAD[~^]\d*$/.test(ref) || ref === "@") return true;
	if (f.branches.includes(ref) || f.branches.includes(ref.replace(/^refs\/heads\//, ""))) return true;
	return f.bases.some((b) => ref.length >= 7 && b.startsWith(ref));
};

/** Why this shell command may not run in a worker, or undefined. */
export function workerCommandProblem(command: string, f: GuardFacts): string | undefined {
	for (const cmd of parseCommands(command)) {
		const words = unwrapCommand(cmd.words);
		if (!words.length) continue;
		const name = baseName(words[0]);
		const args = words.slice(1);
		// bash -c "..." and friends: the inner text is checked as a command of its own
		if (SHELLS.has(name) && args.some((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a) || /^-command$/i.test(a))) {
			const at = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a) || /^-command$/i.test(a));
			const inner = args[at + 1];
			if (inner === undefined) return `${name} -c without a command text is not allowed.${HINT}`;
			const why = workerCommandProblem(inner, f);
			if (why) return why;
			continue;
		}
		if (name === "git") {
			const g = gitSubcommand(args);
			if (!g) continue;
			if (g.sub === "push") return `git push is not allowed for workers: relay pushes after the judge passes.${HINT}`;
			if (g.sub === "branch" && g.rest.some((a) => a === "--delete" || /^-[a-zA-Z]*[dD][a-zA-Z]*$/.test(a))) return `deleting a branch is not allowed for workers.${HINT}`;
			if (["checkout", "switch", "reset"].includes(g.sub)) {
				const dashdash = g.rest.indexOf("--");
				const head = dashdash >= 0 ? g.rest.slice(0, dashdash) : g.rest;
				// `checkout -- file`, `checkout <ref> -- file` and a bare `reset` only touch files
				if (dashdash >= 0 && g.sub === "checkout") continue;
				const refs = head.filter((a) => !a.startsWith("-"));
				if (g.sub === "reset" && refs.length === 0) continue;
				if (g.sub === "switch" && g.rest.some((a) => /^-[a-zA-Z]*[cC]/.test(a) || a === "--create" || a === "--force-create")) return `creating or moving a branch is not allowed.${HINT}`;
				if (g.sub === "checkout" && g.rest.some((a) => /^-[a-zA-Z]*[bB]/.test(a))) return `creating a branch is not allowed.${HINT}`;
				const bad = refs.find((r) => !refOk(r, f));
				if (bad) return `git ${g.sub} ${bad}: workers stay on the job's branch (${f.branches.join(", ") || "its branch"}) and its base.${HINT}`;
			}
		} else if (name === "gh") {
			const positional = args.filter((a, i) => !a.startsWith("-") && args[i - 1] !== "-R" && args[i - 1] !== "--repo");
			const [group, sub] = positional;
			if (group === "api") {
				const m = args.findIndex((a) => a === "-X" || a === "--method");
				const method = (m >= 0 ? args[m + 1] : "GET").toUpperCase();
				if (method !== "GET") return `gh writes are not allowed for workers.${HINT}`;
			} else if (group === "auth" || group === "repo" || group === "release" || group === "gist" || group === "secret" || group === "workflow") return `gh ${group} is not allowed for workers.${HINT}`;
			else if ((group === "pr" || group === "issue") && !GH_READ.has(sub)) return `gh ${group} ${sub ?? ""} is not allowed for workers (relay opens and updates pull requests).${HINT}`;
		}
	}
	for (const c of classifyCommand(command, { branch: "", protectedBranches: [] })) {
		if (c.category === "deps" || c.category === "formats") {
			if (!allowed(c.category, c.item, f)) return `${c.category} change needs the lead's approval: ask_lead with approval {category: "${c.category}", item: "${c.item}", why}.`;
			continue;
		}
		return `${c.category} actions are not allowed for workers.${HINT}`;
	}
	return undefined;
}

/** Why an edit or write of `file` (relative to the worker's cwd) is refused, or undefined. */
export function workerPathProblem(file: string, cwd: string, f: GuardFacts): string | undefined {
	const abs = path.resolve(cwd, file);
	// in a multi-repo set the glob is matched inside the repo that holds the file (".github/workflows/**" has no repo folder in front)
	const home = (f.worktrees ?? []).map((w) => path.resolve(w)).filter((w) => abs.toLowerCase().startsWith(`${w.toLowerCase()}${path.sep}`)).sort((a, b) => b.length - a.length)[0];
	const rel = normPath(path.relative(home ?? cwd, abs));
	if (rel.startsWith("../")) return undefined;
	const cat = pathCategory(rel, f.sensitivePaths);
	if (!cat) return undefined;
	if (allowed(cat, rel, f)) return undefined;
	return `${rel} is a sensitive path (${cat}): ask_lead with approval {category: "${cat}", item: "${rel}", why} first.`;
}

/** The guard's facts, read fresh each call so approvals take effect at once. */
export function loadFacts(dir: string): GuardFacts {
	const job = readJob(dir);
	let sensitive: string[] = [];
	try {
		sensitive = JSON.parse(fs.readFileSync(path.join(dir, "guard.json"), "utf8")).sensitivePaths ?? [];
	} catch {
		// no guard.json: no sensitive paths known
	}
	let authority: GuardFacts["authority"] = {};
	try {
		const b = parseBrief(fs.readFileSync(path.join(dir, "brief.md"), "utf8"));
		if (!("errors" in b)) authority = b.authority;
	} catch {
		// no brief: nothing is authorised
	}
	return { branches: job?.repos.map((r) => r.branch) ?? [], bases: job?.repos.map((r) => r.base) ?? [], worktrees: job?.repos.map((r) => r.worktree) ?? [], sensitivePaths: sensitive, authority, approvals: job?.approvals ?? [] };
}


/** Waits for the lead's reply to `id` in the inbox, polling every `pollMs`; undefined when aborted. */
export async function waitReply(dir: string, id: string, signal: AbortSignal | undefined, pollMs = 1000) {
	for (;;) {
		const r = findReply(inboxPath(dir), id);
		if (r) return r;
		if (signal?.aborted) return undefined;
		await new Promise<void>((resolve) => {
			const t = setTimeout(resolve, pollMs);
			signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
		});
	}
}

