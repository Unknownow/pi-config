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

const TOOL = (name: string) => new RegExp(`(^|__)${name}$`);
const BASH_TOOL = TOOL("bash");
const CODE_TOOL = TOOL("ctx_execute(_file)?");
const BATCH_TOOL = TOOL("ctx_batch_execute");
const CHANGE_TOOL = TOOL("ctx_(purge|upgrade)");
const SHELL_LANGUAGES = new Set(["shell", "bash", "sh", "zsh"]);
const POWERSHELL_LANGUAGES = new Set(["powershell", "pwsh", "ps1"]);
const JS_LANGUAGES = new Set(["javascript", "js", "typescript", "ts"]);
const PY_LANGUAGES = new Set(["python", "py", "python3"]);

const JS_CHECKS: [RegExp, string][] = [
	[/\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync|mkdir|mkdirSync|copyFile|copyFileSync|cp|cpSync|truncate|truncateSync|chmod|chmodSync|symlink|symlinkSync)\b/, "writes, moves or deletes files"],
	[/\b(writeSync|openSync|open|link|linkSync|utimes|utimesSync)\s*\(/, "writes or opens files"],
	[/\bfs\s*\.\s*(write|open|link)\b/, "writes or opens files"],
	[/\bBun\s*\.\s*(write|file|spawn|\$)|["']bun(:\w+)?["']/, "writes files or runs programs (Bun)"],
	[/\b(child_process|spawn|spawnSync|execSync|execFile|execFileSync|fork)\b/, "runs other programs"],
	[/\b(eval|Function)\s*\(/, "runs code it builds at runtime"],
	[/\bmethod\s*:\s*["'`](POST|PUT|PATCH|DELETE)["'`]/i, "sends a request that changes data"],
];

const PY_CHECKS: [RegExp, string][] = [
	[/\.(write_text|write_bytes|unlink|rmdir|rename|touch|mkdir|chmod|symlink_to|hardlink_to|rmtree)\s*\(/, "writes, moves or deletes files"],
	[/\bos\s*\.\s*(remove|unlink|rename|replace|mkdir|makedirs|rmdir|removedirs|system|popen|exec\w*|spawn\w*|chmod|symlink|link|truncate|kill|write|open|fdopen)\b/, "writes files or runs programs (os)"],
	[/\b(shutil|subprocess)\b/, "writes files or runs programs"],
	[/\.(to_csv|to_parquet|to_excel|to_pickle|to_feather|to_hdf|savefig|savez|savetxt)\s*\(|\bnp\s*\.\s*save\s*\(|\b(pickle|json)\s*\.\s*dump\s*\(/, "writes files"],
	[/\brequests\s*\.\s*(post|put|patch|delete)\b|\bmethod\s*=\s*["'](POST|PUT|PATCH|DELETE)["']/i, "sends a request that changes data"],
	[/\b(eval|exec|compile|__import__)\s*\(/, "runs code it builds at runtime"],
	[/\bfrom\s+(os|shutil|subprocess)\s+import\b/, "imports file or process functions by name"],
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

function pythonProblem(code: string): string | null {
	if (PY_WRITE_OPEN.test(code)) return "opens a file for writing";
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
	return null;
}
