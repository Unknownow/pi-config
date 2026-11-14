/** Sensitive categories (merge, publish, comments, delete, formats, deps): which commands and paths belong to which, and what a job's Authority covers. */

import * as path from "node:path";
import { gitSubcommand, parseCommands, unwrapCommand } from "../shared/readonly-bash.ts";
import type { AuthorityItem } from "./brief.ts";
import type { Category } from "./config.ts";
import { matchesAny, normPath } from "./glob.ts";
import type { Approval } from "./job.ts";
import { type GateRequest, pushProblem, registryPublishProblem } from "./push-guard.ts";

export interface Classified {
	category: Category;
	item: string;
}

export interface CommandCtx {
	/** The current branch of the repo the command runs in. */
	branch: string;
	protectedBranches: string[];
	/** `rm -rf` inside this folder is not a deletion that needs approval. */
	setRoot?: string;
}

const short = (s: string) => s.trim().replace(/\s+/g, " ").slice(0, 100);
const baseName = (w: string) => w.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").replace(/\.cmd$/i, "");

const COMMENT_SUBS = new Set(["comment", "close", "review", "reopen"]);

/** The sensitive categories a shell command touches. Several per command are possible. */
export function classifyCommand(command: string, ctx: CommandCtx): Classified[] {
	const out: Classified[] = [];
	const add = (category: Category, item: string) => {
		if (!out.some((o) => o.category === category && o.item === item)) out.push({ category, item });
	};
	const item = short(command);
	if (registryPublishProblem(command)) add("publish", item);

	const gates: GateRequest[] = [];
	pushProblem(command, { branch: ctx.branch, protectedBranches: ctx.protectedBranches, gates });
	for (const g of gates) {
		if (g.kind === "merge") add("merge", item);
		else if (g.kind === "protected-push") add("merge", item);
	}

	for (const cmd of parseCommands(command)) {
		const words = unwrapCommand(cmd.words);
		if (!words.length) continue;
		const name = baseName(words[0]);
		const args = words.slice(1);
		if (name === "git") {
			const g = gitSubcommand(args);
			if (!g) continue;
			if (g.sub === "push" && (g.rest.some((a) => a === "--delete" || /^-[a-zA-Z]*d[a-zA-Z]*$/.test(a)) || g.rest.some((a) => a.startsWith(":") && a.length > 1))) add("delete", item);
			if (g.sub === "branch" && g.rest.some((a) => a === "--delete" || /^-[a-zA-Z]*[dD][a-zA-Z]*$/.test(a))) add("delete", item);
			if (g.sub === "tag" && g.rest.some((a) => a === "-d" || a === "--delete")) add("delete", item);
		} else if (name === "gh") {
			const positional = args.filter((a, i) => !a.startsWith("-") && args[i - 1] !== "-R" && args[i - 1] !== "--repo");
			const [group, sub] = positional;
			if (group === "release") add("publish", item);
			else if ((group === "issue" || group === "pr") && COMMENT_SUBS.has(sub)) add("comments", item);
			else if (group === "pr" && sub === "merge") add("merge", item);
			else if (group === "api") {
				const m = args.findIndex((a) => a === "-X" || a === "--method");
				const method = (m >= 0 ? args[m + 1] : args.find((a) => /^--method=/.test(a))?.slice(9) ?? "GET").toUpperCase();
				const endpoint = positional.slice(1).find((p) => p.includes("/")) ?? "";
				if (method === "DELETE") add("delete", item);
				else if (method !== "GET" && /issues|pulls|comments|reviews/.test(endpoint)) add("comments", item);
			}
		} else if (name === "rm") {
			const recursive = args.some((a) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a) || a === "--recursive");
			if (!recursive) continue;
			const targets = args.filter((a) => !a.startsWith("-"));
			const inside = (t: string) => !!ctx.setRoot && /^([/\\]|[A-Za-z]:)/.test(t) && normPath(path.resolve(t)).toLowerCase().startsWith(`${normPath(path.resolve(ctx.setRoot)).toLowerCase()}/`);
			const relative = (t: string) => !/^([/\\]|[A-Za-z]:|~|\$)/.test(t) && !t.split(/[\\/]/).includes("..");
			if (targets.some((t) => !inside(t) && !relative(t))) add("delete", item);
		} else if (["npm", "pnpm", "yarn"].includes(name)) {
			const [sub, ...rest] = args.filter((a) => !a.startsWith("-"));
			if (sub === "add" || ((sub === "install" || sub === "i") && rest.length > 0)) add("deps", item);
		} else if (name === "dotnet") {
			if (args[0] === "add" && args.includes("package")) add("deps", item);
		}
	}
	return out;
}

const MANIFEST = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|manifest\.json|[^/]+\.csproj)$/i;

/** The category of a file path: dependency manifests are `deps`, other sensitive paths `formats`. */
export function pathCategory(p: string, sensitivePaths: string[]): Category | undefined {
	const n = normPath(p);
	if (!matchesAny(sensitivePaths, n)) return undefined;
	return MANIFEST.test(n) ? "deps" : "formats";
}

export interface Authorized {
	authority: Partial<Record<Category, AuthorityItem>>;
	approvals: Approval[];
}

/** Whether the brief's Authority or an approval covers `item` of `category`. */
export function allowed(category: Category, item: string, a: Authorized): boolean {
	if (a.authority[category]?.value === "yes") return true;
	return a.approvals.some((x) => x.category === category && (x.item === item || x.item === "*"));
}

/** The first thing in `command` that Authority does not cover, or undefined. */
export function unauthorized(command: string, ctx: CommandCtx, a: Authorized): Classified | undefined {
	return classifyCommand(command, ctx).find((c) => !allowed(c.category, c.item, a));
}
