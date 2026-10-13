/**
 * Plan-phase check for the tools that run code: bash, context-mode's analysis
 * sandbox (ctx_execute, ctx_execute_file, ctx_batch_execute) and the context-mode
 * tools that change the knowledge base or the installed tool (ctx_purge, ctx_upgrade).
 * Shell text goes through readOnlyProblem; JavaScript and Python are checked for
 * the calls that write, delete, run programs or change remote data.
 *
 * This is a guard against drifting into execution, not a sandbox: code built at
 * runtime (eval of strings, aliased imports) can get past the word checks.
 */
import { readOnlyProblem } from "./readonly-bash.ts";

/**
 * Tools the planner may call, as regexes over the tool name; workflow.json's
 * planAllowedTools replaces this list. Everything else is refused while planning,
 * so a tool that changes things (an agent that edits, an MCP tool that writes)
 * stays off until it is added here. bash and the ctx_* code tools are allowed
 * by name and then checked below.
 */
export const PLAN_TOOLS = [
	"^(read|grep|find|ls|bash|codemode|explore|advisor|judge)$",
	"(^|__)ctx_(search|execute|execute_file|batch_execute|fetch_and_index|index|stats|doctor|insight)$",
	// MCP tools named for reading: mcp__knowledge__search, mcp__knowledge__get_entry, ...
	"^mcp__.+__(search|get|list|read|view|status|fetch|find|query|describe|show|lookup)(_\\w+)?$",
];

/** Words that mark an MCP tool as a writer even when its name starts with a read verb (get_or_create, find_and_replace). planAllowedTools cannot override it. */
const WRITE_WORDS = /(^|_)(create|update|delete|replace|write|set|add|remove|put|post|propose|insert|edit|modify|run|exec\w*|save|apply)(_|$)/;

/** Why plan phase refuses a tool by its name alone, or null when it is on the allow list. */
export function planToolRefused(name: string, allowed: RegExp[], blocked: string[]): string | null {
	if (blocked.includes(name)) return `${name} is off while planning`;
	if (!allowed.some((re) => re.test(name))) return `${name} is not a reading tool (planAllowedTools)`;
	if (/^mcp__/.test(name) && !/__ctx_/.test(name) && WRITE_WORDS.test(name.replace(/^mcp__.+?__/, ""))) return `${name} looks like it changes data (its name has a write word; planAllowedTools cannot override this)`;
	return null;
}

const TOOL = (name: string) => new RegExp(`(^|__)${name}$`);
const BASH_TOOL = TOOL("bash");
const CODE_TOOL = TOOL("ctx_execute(_file)?");
const BATCH_TOOL = TOOL("ctx_batch_execute");
const CHANGE_TOOL = TOOL("ctx_(purge|upgrade)");
const SHELL_LANGUAGES = new Set(["shell", "bash", "sh", "zsh"]);
const POWERSHELL_LANGUAGES = new Set(["powershell", "pwsh", "ps1"]);
const JS_LANGUAGES = new Set(["javascript", "js", "typescript", "ts"]);
const PY_LANGUAGES = new Set(["python", "py", "python3"]);

/**
 * The code checks below are regexes over the source. They stop a planner that drifts into
 * writing files, not one that tries to hide it: this is a guardrail, not a sandbox.
 */
const JS_CHECKS: [RegExp, string][] = [
	[/\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync|mkdir|mkdirSync|copyFile|copyFileSync|cp|cpSync|truncate|truncateSync|chmod|chmodSync|symlink|symlinkSync)\b/, "writes, moves or deletes files"],
	[/\b(writeSync|openSync|open|link|linkSync|utimes|utimesSync)\s*\(/, "writes or opens files"],
	[/\bfs\s*\.\s*(write|open|link)\b/, "writes or opens files"],
	[/\bBun\s*\.\s*(write|file|spawn|\$)|["']bun(:\w+)?["']/, "writes files or runs programs (Bun)"],
	[/\b(child_process|spawn|spawnSync|execSync|execFile|execFileSync|fork)\b/, "runs other programs"],
	[/\b(eval|Function)\s*\(/, "runs code it builds at runtime"],
	[/\bmethod\s*:\s*["'`](POST|PUT|PATCH|DELETE)["'`]/i, "sends a request that changes data"],
	// Names built at runtime get past the word checks above, so refuse the building itself.
	[/[\w$\])]\s*\[\s*(?:["'`][^"'`\]]*["'`]\s*\+|[^\]]*\+\s*["'`]|`[^`\]]*\$\{)/, "builds a property name at runtime"],
	[/[\w$\])]\s*\[[^\]]*\(/, "builds a property name at runtime"],
	[/["'`][^"'`\n]*["'`]\s*\+\s*["'`]/, "builds a name from string pieces"],
	[/\b(?:require|import)\s*\(\s*(?!["'][^"'`]+["']\s*\))/, "loads a module named at runtime"],
	[/\bprocess\s*\.\s*(binding|_linkedBinding|dlopen|kill|chdir|setuid|setgid|abort)\b/, "reaches native bindings or other processes"],
	[/\b(globalThis|global|window|self)\s*\[|\bReflect\s*\.\s*(get|apply|construct)\b|\bString\s*\.\s*fromCharCode\b|\batob\s*\(/, "looks up names or decodes code at runtime"],
	[/\b(vm|worker_threads|Worker)\b/, "runs code in another context"],
	[/\bmethod\s*:\s*(?!["'`](GET|HEAD|OPTIONS)["'`])/i, "sends a request whose method is not a literal GET"],
	[/(?<!\[\s*\d+\s*)\]\s*\(/, "calls a member picked by a computed name"],
	[/\b(fs|process|child_process|os|path|Deno|Bun|require\s*\([^)]*\))\s*\[(?!\s*\d+\s*\])/, "looks up a module member by a computed name"],
	[/\]\s*\.\s*(call|apply|bind)\b/, "calls a member picked by a computed name"],
];

const PY_CHECKS: [RegExp, string][] = [
	[/\.(write_text|write_bytes|unlink|rmdir|rename|touch|mkdir|chmod|symlink_to|hardlink_to|rmtree)\s*\(/, "writes, moves or deletes files"],
	[/\bos\s*\.\s*(remove|unlink|rename|replace|mkdir|makedirs|rmdir|removedirs|system|popen|exec\w*|spawn\w*|chmod|symlink|link|truncate|kill|write|open|fdopen)\b/, "writes files or runs programs (os)"],
	[/\b(shutil|subprocess)\b/, "writes files or runs programs"],
	[/\.(to_csv|to_parquet|to_excel|to_pickle|to_feather|to_hdf|savefig|savez|savetxt)\s*\(|\bnp\s*\.\s*save\s*\(|\b(pickle|json)\s*\.\s*dump\s*\(/, "writes files"],
	[/\brequests\s*\.\s*(post|put|patch|delete)\b|\bmethod\s*=\s*["'](POST|PUT|PATCH|DELETE)["']/i, "sends a request that changes data"],
	[/\b(eval|exec|compile|__import__)\s*\(/, "runs code it builds at runtime"],
	[/\bfrom\s+(os|shutil|subprocess)\s+import\b/, "imports file or process functions by name"],
	[/\b(importlib|getattr|setattr|delattr|globals|locals|vars|__builtins__|__dict__|__subclasses__|ctypes|socket|pty|multiprocessing|marshal)\b/, "looks up names at runtime or loads native code"],
	[/\bimport\s+(?:[\w.]+\s*,\s*)*(os|shutil|subprocess|io|codecs|builtins|gzip|bz2|lzma|tarfile)\s+as\s+\w+/, "uses os/shutil/subprocess under another name"],
	[/=\s*(os|shutil|subprocess)\s*(?:$|[;\n#])/m, "uses os/shutil/subprocess under another name"],
	[/\bopen\s*\((?:'[^']*'|"[^"]*"|[^()'",])*,\s*(?!["']|encoding|errors|newline|buffering|closefd|opener)[A-Za-z_]/, "opens a file with a mode chosen at runtime"],
	[/\bmode\s*=\s*(?!["'])[A-Za-z_]/, "opens a file with a mode chosen at runtime"],
];

/**
 * A write mode as the second argument of open( or as mode=, or as the first argument of .open(. Arguments may hold one level of nested parentheses.
 */
const PY_MODE = "[\"'](?=[rwxabt+]*[wxa+])[rwxabt+]{1,3}[\"']";
const PY_WRITE_OPEN = new RegExp(
	`\\bopen\\s*\\((?:'[^']*'|"[^"]*"|[^()'"]|\\((?:'[^']*'|"[^"]*"|[^()'"]|\\([^()]*\\))*\\))*?,\\s*${PY_MODE}|\\bmode\\s*=\\s*${PY_MODE}|\\.open\\s*\\(\\s*${PY_MODE}`,
);

function firstMatch(code: string, checks: [RegExp, string][]): string | null {
	const hit = checks.find(([re]) => re.test(code));
	return hit ? hit[1] : null;
}

/** Top-level arguments of the call whose "(" is at `start`, or null when it never closes. */
function callArgs(code: string, start: number): string[] | null {
	const args: string[] = [];
	let depth = 0;
	let quote = "";
	let cur = "";
	for (let i = start; i < code.length; i++) {
		const c = code[i];
		if (quote) {
			cur += c;
			if (c === "\\") cur += code[++i] ?? "";
			else if (c === quote) quote = "";
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			cur += c;
		} else if ("([{".includes(c)) {
			if (depth++ > 0) cur += c;
		} else if (")]}".includes(c)) {
			if (--depth === 0) {
				if (cur.trim()) args.push(cur.trim());
				return args;
			}
			cur += c;
		} else if (c === "," && depth === 1) {
			args.push(cur.trim());
			cur = "";
		} else cur += c;
	}
	return null;
}

/** open() may only take a plain read-mode literal (or none); anything built at runtime could be a write mode. */
function pythonOpenProblem(code: string): string | null {
	for (const m of code.matchAll(/(\.\s*)?\bopen\s*\(/g)) {
		const receiver = m[1] ? /(\w+)\s*$/.exec(code.slice(0, m.index!))?.[1] : undefined;
		const builtin = !m[1] || ["io", "codecs", "builtins", "gzip", "bz2", "lzma", "tarfile"].includes(receiver ?? "");
		const args = callArgs(code, m.index! + m[0].length - 1);
		if (!args) return "opens a file in a way that cannot be checked";
		if (args.some((a) => a.startsWith("*"))) return "opens a file with unpacked arguments";
		const keywords = new Map(args.filter((a) => /^\w+\s*=(?!=)/.test(a)).map((a) => [a.split("=")[0].trim(), a.slice(a.indexOf("=") + 1).trim()]));
		const positional = args.filter((a) => !/^\w+\s*=(?!=)/.test(a));
		// open(path, mode) takes the mode second. For other .open( calls (pathlib) it is first; a plain string there is left to PY_WRITE_OPEN.
		const first = positional[0] ?? "";
		const mode = keywords.get("mode") ?? (builtin ? positional[1] : first && receiver !== "Image" && !/^(["'])[^"']*\1$/.test(first) ? first : undefined);
		if (mode !== undefined && !/^['"]r[bt]?['"]$/.test(mode)) return "opens a file with a mode that is not a plain read literal";
		if (keywords.has("opener")) return "opens a file through a custom opener";
	}
	return null;
}

function pythonProblem(code: string): string | null {
	if (PY_WRITE_OPEN.test(code)) return "opens a file for writing";
	const open = pythonOpenProblem(code);
	if (open) return open;
	return firstMatch(code, PY_CHECKS);
}

/**
 * ctx_execute and ctx_batch_execute run PowerShell on Windows. Bash and PowerShell read escapes, quotes, $ and ` differently, so on Windows only plain text passes: letters, digits, spaces, and . / : = , | + * - ; & < > ' ". Use forward slashes in paths.
 */
const WINDOWS_SHELL_TEXT = /^[\w \t\n.\/:=,|+*\-;&<>'"]*$/;
/** PowerShell's own web aliases; bash would read these as the native curl or wget. */
const POWERSHELL_ALIASES = /(^|[\s;&|])(curl|wget|iwr|irm)(?![\w.-])/i;

function shellProblem(text: string, allow: RegExp[], platform: string): string | null {
	const code = platform === "win32" ? text.replace(/\r\n/g, "\n") : text;
	if (code.includes("\r")) return "contains a bare carriage return, which PowerShell and bash read differently";
	if (platform === "win32" && !WINDOWS_SHELL_TEXT.test(code)) {
		return "uses characters that PowerShell and bash read differently (escapes, $, backticks, brackets, Unicode quotes)";
	}
	if (platform === "win32" && POWERSHELL_ALIASES.test(code.replace(/['"]/g, ""))) {
		return "uses a PowerShell alias (curl, wget, iwr, irm) that is not the native command";
	}
	return readOnlyProblem(code, allow);
}

const SQL_CHANGE =
	/(^|[;()])\s*(copy\s+[\w."]+\s+(from|to)\b|insert\s+(or\s+\w+\s+)?into|update\s+[\w."`\[\]]+\s+set|delete\s+from|drop\s+(table|database|index|view|schema|trigger)|alter\s+(table|database|schema)|create\s+(or\s+replace\s+)?(table|database|index|view|schema|trigger|function)|truncate\s+table\s+\w+|merge\s+into|replace\s+into|grant\s+[\w, ]+\s+on\s|revoke\s+[\w, ]+\s+on\s|attach\s+database|vacuum\s*(;|$))/im;
const GRAPHQL_MUTATION = /^\s*mutation\b/m;

/** Every string in a tool input, nested objects and arrays included. */
function stringsOf(value: unknown, depth = 0): string[] {
	if (typeof value === "string") return [value];
	if (depth > 5 || value === null || typeof value !== "object") return [];
	return Object.values(value as Record<string, unknown>).flatMap((v) => stringsOf(v, depth + 1));
}

function codeProblem(input: Record<string, unknown>, allow: RegExp[], platform: string): string | null {
	const language = String(input.language ?? "").toLowerCase();
	const code = String(input.code ?? "");
	if (SHELL_LANGUAGES.has(language)) return shellProblem(code, allow, platform);
	if (POWERSHELL_LANGUAGES.has(language)) return "runs PowerShell, which is not checked while planning";
	if (JS_LANGUAGES.has(language)) return firstMatch(code, JS_CHECKS);
	if (PY_LANGUAGES.has(language)) return pythonProblem(code);
	return `runs ${language || "code"}, which is not checked while planning`;
}

/**
 * Why a tool call may not run in plan phase, or null when it may. `allow` holds
 * the planBashAllow patterns, applied to shell text only. `platform` is
 * process.platform; it is a parameter so tests can check the Windows rules anywhere.
 */
export function planToolProblem(
	name: string,
	input: Record<string, unknown>,
	allow: RegExp[],
	platform: string = process.platform,
): string | null {
	if (BASH_TOOL.test(name)) return readOnlyProblem(String(input.command ?? ""), allow);
	if (CHANGE_TOOL.test(name)) return `${name.replace(/^.*__/, "")} changes the knowledge base or the installed tool`;
	if (BATCH_TOOL.test(name)) {
		const commands = Array.isArray(input.commands) ? input.commands : [];
		for (const c of commands) {
			const problem = shellProblem(String((c as { command?: unknown })?.command ?? ""), allow, platform);
			if (problem) return problem;
		}
		return null;
	}
	if (CODE_TOOL.test(name)) return codeProblem(input, allow, platform);
	if (/^mcp__/.test(name) && !/__ctx_/.test(name) && !/__(read|grep|find|ls|bash|codemode|explore|advisor|judge|edit|write)$/.test(name) && stringsOf(input).some((t) => { const sql = t.replace(/'(?:[^']|'')*'|\/\*[\s\S]*?\*\/|--[^\n]*/g, (tok) => (tok[0] === "'" ? "''" : " ")); return SQL_CHANGE.test(sql) || GRAPHQL_MUTATION.test(sql); })) {
		return "sends a statement that changes data";
	}
	return null;
}
