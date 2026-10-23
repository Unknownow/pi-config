import * as path from "node:path";
import { KEYWORDS, parseCommands, WRAPPERS } from "../workflow/readonly-bash.ts";

export interface GuardOptions {
	cwd: string;
	setRoot: string;
	platform: NodeJS.Platform;
}

const GUARDED = new Set(["command", "cmd", "recompile", "list", "job", "mcp", "run", "test", "build", "pipeline"]);
const VALUED = new Set(["--project-path", "--format", "--timeout", "--runtime", "--runtime-path"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const ASSIGN = /^[A-Za-z_]\w*=/;

const commandName = (w: string) => w.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");

function refuse(why: string): string {
	return `Refused (worktree): ${why}. The Unity Editor belongs to another session; pass --project-path <absolute path inside the worktree set> or ask the user to run it in the Editor session.`;
}

/** Forward slashes, no trailing slash, `/d/x` as `d:/x` on Windows, lower case on Windows. */
function norm(p: string, o: GuardOptions): string {
	let s = p.split(String.fromCharCode(92)).join("/");
	if (o.platform === "win32") s = s.replace(/^\/([A-Za-z])\//, "$1:/");
	s = path.posix.normalize(s).replace(/\/+$/, "");
	return o.platform === "win32" ? s.toLowerCase() : s;
}

function insideSet(p: string, o: GuardOptions): boolean {
	const base = norm(o.cwd, o);
	const raw = p.split(String.fromCharCode(92)).join("/");
	if (/[$%`"']/.test(raw) || raw.startsWith("~") || /^[A-Za-z]:(?!\/)/.test(raw)) return false;
	const abs = /^([A-Za-z]:)?\//.test(raw) ? norm(raw, o) : norm(`${base}/${raw}`, o);
	const root = norm(o.setRoot, o);
	return abs === root || abs.startsWith(`${root}/`);
}

function projectPaths(args: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--project-path") out.push(args[++i] ?? "");
		else if (args[i].startsWith("--project-path=")) out.push(args[i].slice("--project-path=".length));
	}
	return out;
}

function subcommand(args: string[]): string | null {
	for (let i = 0; i < args.length; i++) {
		if (VALUED.has(args[i])) i++;
		else if (!args[i].startsWith("-")) return args[i];
	}
	return null;
}

function unityProblemOf(args: string[], o: GuardOptions): string | null {
	const sub = [subcommand(args), ...args].find((a) => a !== null && GUARDED.has(a));
	if (!sub) return null;
	const paths = projectPaths(args);
	if (!paths.length) return refuse(`"unity ${sub}" without --project-path`);
	const bad = paths.find((p) => !p || !insideSet(p, o));
	return bad === undefined ? null : refuse(`"unity ${sub}" targets "${bad}", outside the worktree set`);
}

function stripPrefix(input: string[]): string[] {
	let words = input;
	while (words.length) {
		if (KEYWORDS.has(words[0]) || ASSIGN.test(words[0])) {
			words = words.slice(1);
			continue;
		}
		const name = commandName(words[0]);
		if (!(name in WRAPPERS)) break;
		let i = 1;
		while (i < words.length && (words[i].startsWith("-") || (name === "env" && ASSIGN.test(words[i])))) {
			i += WRAPPERS[name].includes(words[i]) ? 2 : 1;
		}
		if (name === "timeout") i++;
		words = words.slice(i);
	}
	return words;
}

const launcherName = (w: string, o: GuardOptions) => {
	const n = commandName(w).replace(/\.(cmd|bat|ps1)$/i, "");
	return o.platform === "win32" ? n.toLowerCase() : n;
};

/** The script after the first `-c`-style option of a POSIX shell, or null. */
function shellScript(args: string[]): string | null {
	for (let i = 0; i < args.length && args[i].startsWith("-"); i++) {
		if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(args[i])) return args[i + 1] ?? null;
	}
	return null;
}

/** The command text a Windows shell runs (`cmd /c ...`, `pwsh -Command ...`), or null. */
function shellInner(name: string, args: string[]): string | null {
	const flag = (args[0] ?? "").toLowerCase();
	if (name.toLowerCase() === "cmd" && (flag === "/c" || flag === "/k")) return args.slice(1).join(" ");
	if (/^(powershell|pwsh)$/i.test(name)) {
		const k = args.findIndex((a) => /^-(c|command)$/i.test(a));
		if (k >= 0) return args.slice(k + 1).join(" ");
	}
	return null;
}

function wordsProblem(input: string[], o: GuardOptions): string | null {
	const words = stripPrefix(input);
	if (!words.length) return null;
	const name = launcherName(words[0], o);
	const args = words.slice(1);
	const script = SHELLS.has(name) ? shellScript(args) : null;
	if (script !== null) return unityProblem(script, o);
	const inner = shellInner(name, args);
	if (inner !== null) return unityProblem(inner, o);
	return name === "unity" ? unityProblemOf(args, o) : null;
}

/** Why `text` would drive the Unity Editor of another session, or null. */
export function unityProblem(text: string, o: GuardOptions): string | null {
	if (/\bUNITY_PROJECT_PATH\s*=/.test(text)) return refuse("UNITY_PROJECT_PATH is set");
	const source = o.platform === "win32" ? text.replace(/\\(?!["'\r\n])/g, "/") : text;
	for (const cmd of parseCommands(source)) {
		const why = wordsProblem(cmd.words, o);
		if (why) return why;
	}
	return null;
}

/** Why non-shell code would drive the Unity CLI, or null. */
export function codeProblem(code: string): string | null {
	if (/\bunity(\.exe)?\b/.test(code) && /\b(command|cmd|recompile|list|job|mcp|run|test|build|pipeline)\b/.test(code)) {
		return refuse("code that runs the unity CLI");
	}
	return null;
}

/** The first Unity-guard problem in a tool call's input, or null. */
export function guardProblem(toolName: string, input: Record<string, unknown>, o: Omit<GuardOptions, "platform"> & { platform?: NodeJS.Platform }): string | null {
	const opts = { ...o, platform: o.platform ?? process.platform };
	const texts: string[] = [];
	if (/(^|__)bash$/.test(toolName)) texts.push(String(input.command ?? ""));
	else if (/(^|__)run_code$/.test(toolName)) return codeProblem(String(input.code ?? ""));
	for (const t of texts) {
		const why = unityProblem(t, opts);
		if (why) return why;
	}
	return null;
}
