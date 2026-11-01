/**
 * Subagent-only extension: the guard of test runners. The workflow passes its settings in
 * PI_WORKFLOW_RUNNER_GUARD (JSON, see RunnerGuardSpec). Runners may run builds, tests and device
 * commands, but not change git or GitHub, run the denied commands, or point a project path outside
 * the flow's folders. A guard against drift, not a sandbox: a `cd` inside the text does not move
 * the base of relative paths. pi loads only index.ts from this folder, so the main session never
 * runs it.
 */
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commandReadOnlyProblem, KEYWORDS, parseCommands, unwrapCommand } from "../workflow/readonly-bash.ts";
import { repoKey } from "../workflow/repos.ts";

export const RUNNER_GUARD_ENV = "PI_WORKFLOW_RUNNER_GUARD";

export interface RunnerGuardSpec {
	/** The flow's repos and added folders. */
	roots: string[];
	/** Regexes over a command's words (or the whole text). */
	deny: string[];
	/** Flags whose value is a project path. */
	pathFlags: string[];
	/** Environment variable names runners may not set. */
	pathEnv: string[];
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

/** The spec in the env value, or null when it is missing or malformed. */
export function parseRunnerSpec(raw: string | undefined): RunnerGuardSpec | null {
	if (!raw) return null;
	let p: unknown;
	try {
		p = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof p !== "object" || p === null || Array.isArray(p)) return null;
	const o = p as Record<string, unknown>;
	if (!isStrings(o.roots) || !isStrings(o.deny) || !isStrings(o.pathFlags) || !isStrings(o.pathEnv)) return null;
	return { roots: o.roots, deny: o.deny, pathFlags: o.pathFlags, pathEnv: o.pathEnv };
}

const nameOf = (w: string) => w.split(/[\\/]/).pop()!.replace(/\.exe$/i, "");

/** The words from the first real command word on, past shell keywords. */
function stripKeywords(words: string[]): string[] {
	let w = words;
	while (w.length && KEYWORDS.has(w[0])) w = w.slice(1);
	return w;
}

/** Does the command run git or gh, directly or behind a wrapper such as timeout or env? */
function runsGit(words: string[]): boolean {
	const w = unwrapCommand(words);
	return w.length > 0 && ["git", "gh"].includes(nameOf(w[0]));
}

function insideRoots(value: string, roots: string[], cwd: string, platform: NodeJS.Platform): boolean {
	const p = platform === "win32" ? path.win32 : path.posix;
	const abs = repoKey(p.resolve(cwd, value), platform);
	return roots.some((r) => {
		const k = repoKey(r, platform);
		return abs === k || abs.startsWith(`${k.endsWith("/") ? k : `${k}/`}`);
	});
}

/** Why a runner's bash command is refused, or null. */
export function runnerProblem(text: string, spec: RunnerGuardSpec, cwd: string, platform: NodeJS.Platform = process.platform): string | null {
	const cmds = parseCommands(text);
	// 1. git and gh: only what the plan phase's read-only check lets through.
	for (const cmd of cmds) {
		const words = stripKeywords(cmd.words);
		if (runsGit(cmd.words) && commandReadOnlyProblem({ ...cmd, writes: [] })) return "runners may not change git or GitHub";
		const name = words.length ? nameOf(words[0]) : "";
		if ((name === "bash" || name === "sh") && words[1] === "-c" && words[2] !== undefined) {
			const inner = runnerProblem(words[2], spec, cwd, platform);
			if (inner) return inner;
		}
	}
	// 2. The deny list.
	for (const raw of spec.deny) {
		let re: RegExp;
		try {
			re = new RegExp(raw);
		} catch {
			continue;
		}
		const hit = cmds.length ? cmds.some((c) => re.test(stripKeywords(c.words).join(" ")) || re.test(unwrapCommand(c.words).join(" "))) : re.test(text.trim());
		if (hit) return `refused by test.runnerDeny: ${raw}`;
	}
	// 3. Project paths.
	for (const cmd of cmds) {
		const words = cmd.words;
		for (let i = 0; i < words.length; i++) {
			for (const flag of spec.pathFlags) {
				let value: string | undefined;
				if (words[i] === flag) value = words[i + 1] ?? "";
				else if (words[i].startsWith(`${flag}=`)) value = words[i].slice(flag.length + 1);
				if (value === undefined) continue;
				if (/[$`%]/.test(value)) return `project path ${value} can't be checked; write it out`;
				if (!value || !insideRoots(value, spec.roots, cwd, platform)) return `project path ${value || "(empty)"} is outside this flow's folders`;
			}
		}
		// 4. Names that would move the project.
		const env = cmd.env.find((n) => spec.pathEnv.includes(n));
		if (env) return `set the project with --project-path instead of ${env}`;
		const w = stripKeywords(cmd.words);
		if (w.length && ["export", "env", "declare", "set", "setx"].includes(nameOf(w[0]))) {
			const named = w.slice(1).map((x) => x.split("=")[0]).find((n, i) => w[i + 1].includes("=") && spec.pathEnv.includes(n));
			if (named) return `set the project with --project-path instead of ${named}`;
		}
	}
	return null;
}

export default function runnerGuard(pi: ExtensionAPI): void {
	const spec = parseRunnerSpec(process.env[RUNNER_GUARD_ENV]);
	pi.on("tool_call", async (event, ctx) => {
		if (!/(^|__)bash$/.test(event.toolName)) return;
		if (!spec) return { block: true, reason: "Refused (runner guard): runner guard spec missing." };
		const command = String((event.input as { command?: unknown })?.command ?? "");
		const problem = runnerProblem(command, spec, ctx.cwd ?? process.cwd());
		if (problem) return { block: true, reason: `Refused (runner guard): ${problem}. Report the refused command; don't work around it.` };
	});
}
