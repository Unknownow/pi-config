/**
 * Plan-phase check for the tools that run code: bash and run_code (the sandbox
 * extension's JavaScript tool). Shell text goes through readOnlyProblem; run_code's
 * JavaScript is checked for the calls that write, delete, run programs or change
 * remote data.
 *
 * This is a guard against drifting into execution, not a sandbox: code built at
 * runtime (eval of strings, aliased imports) can get past the word checks.
 */
import { readOnlyProblem } from "../shared/readonly-bash.ts";

/**
 * Tools the planner may call, as regexes over the tool name; workflow.json's
 * planAllowedTools replaces this list. Everything else is refused while planning,
 * so a tool that changes things (an agent that edits, an MCP tool that writes)
 * stays off until it is added here. bash and run_code are allowed
 * by name and then checked below.
 */
export const PLAN_TOOLS = [
	"^(read|grep|find|ls|bash|codemode|explore|advisor|judge)$",
	"(^|__)run_code$",
	"(^|__)fetch_url$",
	"(^|__)video_frames$",
	// MCP tools named for reading: mcp__knowledge__search, mcp__knowledge__get_entry, ...
	"^mcp__.+__(search|get|list|read|view|status|fetch|find|query|describe|show|lookup)(_\\w+)?$",
];

/** Words that mark an MCP tool as a writer even when its name starts with a read verb (get_or_create, find_and_replace). planAllowedTools cannot override it. */
const WRITE_WORDS = /(^|_)(create|update|delete|replace|write|set|add|remove|put|post|propose|insert|edit|modify|run|exec\w*|save|apply)(_|$)/;

/** Why plan phase refuses a tool by its name alone, or null when it is on the allow list. */
export function planToolRefused(name: string, allowed: RegExp[], blocked: string[]): string | null {
	if (blocked.includes(name)) return `${name} is off while planning`;
	if (!allowed.some((re) => re.test(name))) return `${name} is not a reading tool (planAllowedTools)`;
	if (/^mcp__/.test(name) && WRITE_WORDS.test(name.replace(/^mcp__.+?__/, ""))) return `${name} looks like it changes data (its name has a write word; planAllowedTools cannot override this)`;
	return null;
}

/** The tool_call hook's decision: only discuss and plan refuse tools by name. */
export function phaseToolRefusal(phase: string, name: string, allowed: RegExp[], blocked: string[]): string | null {
	if (phase !== "discuss" && phase !== "plan") return null;
	return planToolRefused(name, allowed, blocked);
}

const TOOL = (name: string) => new RegExp(`(^|__)${name}$`);
const BASH_TOOL = TOOL("bash");
const RUN_CODE_TOOL = TOOL("run_code");
const FETCH_TOOL = TOOL("fetch_url");
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

function firstMatch(code: string, checks: [RegExp, string][]): string | null {
	const hit = checks.find(([re]) => re.test(code));
	return hit ? hit[1] : null;
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

/**
 * Why a tool call may not run in plan phase, or null when it may. `allow` holds
 * the planBashAllow patterns, applied to shell text only.
 */
export function planToolProblem(
	name: string,
	input: Record<string, unknown>,
	allow: RegExp[],
): string | null {
	if (BASH_TOOL.test(name)) return readOnlyProblem(String(input.command ?? ""), allow);
	if (RUN_CODE_TOOL.test(name)) return firstMatch(String(input.code ?? ""), JS_CHECKS);
	if (FETCH_TOOL.test(name)) return null;
	if (/^mcp__/.test(name) && !/__(read|grep|find|ls|bash|codemode|explore|advisor|judge|edit|write)$/.test(name) && stringsOf(input).some((t) => { const sql = t.replace(/'(?:[^']|'')*'|\/\*[\s\S]*?\*\/|--[^\n]*/g, (tok) => (tok[0] === "'" ? "''" : " ")); return SQL_CHANGE.test(sql) || GRAPHQL_MUTATION.test(sql); })) {
		return "sends a statement that changes data";
	}
	return null;
}
