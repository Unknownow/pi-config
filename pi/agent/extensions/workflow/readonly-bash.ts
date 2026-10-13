/**
 * Plan phase: decides whether a bash command only reads. The planner may look
 * around, but anything that changes files, git state or GitHub waits for the
 * user's approval and runs on the execute model.
 *
 * A guard against the planner drifting into execution, not a sandbox: it
 * parses the command (quotes, pipes, &&/;, $(...), backticks, heredocs,
 * redirections, simple VAR=value), and every command in it must be on the
 * read-only list below or match one of `planBashAllow`. Anything unknown is
 * refused, so a new read-only command needs adding here or in workflow.json.
 */

export interface ParsedCommand {
	words: string[];
	/** Targets of output redirections (`>`, `>>`, `&>`). */
	writes: string[];
}

class Lexer {
	private i = 0;
	private cur: ParsedCommand = { words: [], writes: [] };
	private word = "";
	private has = false;
	private target: "out" | "in" | null = null;
	/** Heredocs opened on the current line; expand when the delimiter was unquoted. */
	private heredocs: { delimiter: string; expand: boolean }[] = [];

	private readonly s: string;
	private readonly out: ParsedCommand[];
	private readonly vars: Map<string, string>;

	constructor(s: string, out: ParsedCommand[], vars: Map<string, string>) {
		this.s = s;
		this.out = out;
		this.vars = vars;
	}

	run(): void {
		while (this.i < this.s.length) this.step();
		this.endCommand();
	}

	private step(): void {
		const c = this.s[this.i];
		if (c === "\\" && this.s[this.i + 1] === "\n") {
			this.i += 2;
			return;
		}
		if (c === "\\") return this.take(this.s[this.i + 1] ?? "", 2);
		if (c === "'") return this.single();
		if (c === '"') return this.double();
		if (c === "$" || c === "`") return this.dollar();
		if (c === "\n") {
			this.endCommand();
			this.i++;
			return this.skipHeredocs();
		}
		if (c === " " || c === "\t" || c === "\r") {
			this.endWord();
			this.i++;
			return;
		}
		if (c === "#" && !this.has) return this.skipComment();
		if (c === ">" || c === "<" || (c === "&" && this.s[this.i + 1] === ">")) return this.redirect();
		if (";&|()".includes(c)) return this.operator();
		this.take(c, 1);
	}

	private take(text: string, advance: number): void {
		this.word += text;
		this.has = true;
		this.i += advance;
	}

	private single(): void {
		const end = this.s.indexOf("'", this.i + 1);
		const stop = end < 0 ? this.s.length : end;
		this.take(this.s.slice(this.i + 1, stop), stop + 1 - this.i);
	}

	private double(): void {
		this.i++;
		this.has = true;
		while (this.i < this.s.length && this.s[this.i] !== '"') {
			const c = this.s[this.i];
			if (c === "\\" && '"\\$`'.includes(this.s[this.i + 1] ?? "")) this.take(this.s[this.i + 1], 2);
			else if (c === "$" || c === "`") this.dollar();
			else this.take(c, 1);
		}
		this.i++;
	}

	/** `$(...)`, backticks, `$((...))`, `$NAME`, `${NAME}`. Substitutions are commands too. */
	private dollar(): void {
		const s = this.s;
		if (s[this.i] === "`") {
			const end = s.indexOf("`", this.i + 1);
			return this.nested(this.i + 1, end < 0 ? s.length : end);
		}
		if (s.startsWith("$((", this.i)) {
			const end = s.indexOf("))", this.i + 3);
			return this.take("0", (end < 0 ? s.length : end + 2) - this.i);
		}
		if (s[this.i + 1] === "(") return this.nested(this.i + 2, matchParen(s, this.i + 2));
		const m = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/.exec(s.slice(this.i));
		if (!m) return this.take("$", 1);
		const name = m[1] ?? m[2];
		this.take(this.vars.get(name) ?? m[0], m[0].length);
	}

	private nested(start: number, end: number): void {
		new Lexer(this.s.slice(start, end), this.out, this.vars).run();
		this.take("$(...)", end + 1 - this.i);
	}

	private redirect(): void {
		const s = this.s;
		// A word of digits right before the operator is a file descriptor, not an argument.
		if (this.has && /^\d+$/.test(this.word)) {
			this.word = "";
			this.has = false;
		}
		this.endWord();
		if (s.startsWith("<<<", this.i)) return this.setTarget("in", 3);
		if (s.startsWith("<<", this.i)) return this.heredoc();
		if (s[this.i + 1] === "(") return this.nested(this.i + 2, matchParen(s, this.i + 2));
		if (s[this.i] === "<") return this.setTarget("in", 1);
		const op = /^(&>>|&>|>>|>\||>&|>)/.exec(s.slice(this.i))![0];
		this.i += op.length;
		// `>&2`, `2>&1`: duplicates a descriptor, writes no file.
		if (op === ">&" && /^\s*(\d+|-)/.test(s.slice(this.i))) {
			this.i += /^\s*(\d+|-)/.exec(s.slice(this.i))![0].length;
			return;
		}
		this.target = "out";
	}

	private setTarget(kind: "in" | "out", advance: number): void {
		this.target = kind;
		this.i += advance;
	}

	private heredoc(): void {
		this.i += 2;
		if (this.s[this.i] === "-") this.i++;
		const m = /^\s*(?:'([^']*)'|"([^"]*)"|([^\s;&|<>()]+))/.exec(this.s.slice(this.i));
		if (!m) return;
		const bare = m[3]?.replace(/["'\\]/g, "");
		// Bash expands $(...) and backticks in the body unless any part of the delimiter is quoted.
		this.heredocs.push({ delimiter: m[1] ?? m[2] ?? bare!, expand: m[3] !== undefined && bare === m[3] });
		this.i += m[0].length;
	}

	/** After a newline: skip the bodies of the heredocs opened on the line before. */
	private skipHeredocs(): void {
		for (const { delimiter, expand } of this.heredocs) {
			while (this.i < this.s.length) {
				const nl = this.s.indexOf("\n", this.i);
				const line = this.s.slice(this.i, nl < 0 ? this.s.length : nl);
				this.i = nl < 0 ? this.s.length : nl + 1;
				if (line.replace(/^\t+/, "").trimEnd() === delimiter) break;
				if (expand) substitutions(line, this.out, this.vars);
			}
		}
		this.heredocs = [];
	}

	private skipComment(): void {
		const nl = this.s.indexOf("\n", this.i);
		this.i = nl < 0 ? this.s.length : nl;
	}

	private operator(): void {
		this.endCommand();
		const two = this.s.slice(this.i, this.i + 2);
		this.i += ["&&", "||", "|&", ";;"].includes(two) ? 2 : 1;
	}

	private endWord(): void {
		if (!this.has) return;
		if (this.target === "out") this.cur.writes.push(this.word);
		else if (this.target !== "in") this.cur.words.push(this.word);
		this.target = null;
		this.word = "";
		this.has = false;
	}

	private endCommand(): void {
		this.endWord();
		const cmd = this.cur;
		// Leading NAME=value words: remember them for later $NAME, they are not the command.
		while (cmd.words.length && /^[A-Za-z_]\w*=/.test(cmd.words[0])) {
			const w = cmd.words.shift()!;
			const eq = w.indexOf("=");
			this.vars.set(w.slice(0, eq), w.slice(eq + 1));
		}
		if (cmd.words.length || cmd.writes.length) this.out.push(cmd);
		this.cur = { words: [], writes: [] };
	}
}

/** The commands in $(...) and backticks of a heredoc body line. */
function substitutions(line: string, out: ParsedCommand[], vars: Map<string, string>): void {
	for (let i = 0; i < line.length; i++) {
		if (line.startsWith("$(", i) && line[i + 2] !== "(") {
			const end = matchParen(line, i + 2);
			new Lexer(line.slice(i + 2, end), out, vars).run();
			i = end;
		} else if (line[i] === "`") {
			const end = line.indexOf("`", i + 1);
			new Lexer(line.slice(i + 1, end < 0 ? line.length : end), out, vars).run();
			i = end < 0 ? line.length : end;
		}
	}
}

/** Index of the `)` closing a `(` just before `start`, skipping quoted text. */
function matchParen(s: string, start: number): number {
	let depth = 1;
	let quote = "";
	for (let i = start; i < s.length; i++) {
		const c = s[i];
		if (quote) {
			if (c === quote) quote = "";
			else if (c === "\\" && quote === '"') i++;
		} else if (c === "'" || c === '"') quote = c;
		else if (c === "\\") i++;
		else if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return i;
	}
	return s.length;
}

export function parseCommands(command: string): ParsedCommand[] {
	const out: ParsedCommand[] = [];
	new Lexer(command, out, new Map()).run();
	return out;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const READ_ONLY = new Set(
	(
		"ls dir cat head tail less more grep egrep fgrep rg ag wc sort uniq cut tr sed awk gawk diff cmp comm file stat du df " +
		"pwd which where whereis type echo printf true false test [ [[ ] ]] basename dirname realpath readlink date printenv " +
		"whoami hostname uname id groups jq yq column nl tac rev od xxd hexdump md5sum sha1sum sha256sum base64 strings fold " +
		"fmt paste join expand cygpath wslpath tasklist ps sleep seq expr cd pushd popd set export unset local read shift " +
		"exit return break continue wait : let find tree nproc uptime free"
	).split(" "),
);

/** Shell keywords in front of a command: `do echo x`, `if grep -q`, `! test`. */
const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}", "time", "esac"]);

/** Wrappers whose arguments are another command. Value: options of the wrapper that take a value. */
const WRAPPERS: Record<string, string[]> = {
	timeout: ["-s", "--signal", "-k", "--kill-after"],
	xargs: ["-I", "-i", "-n", "-L", "-l", "-P", "-d", "-s", "-E", "-e", "-a"],
	env: ["-u", "--unset", "-C", "--chdir"],
	command: [],
	exec: [],
	nice: ["-n"],
	nohup: [],
	stdbuf: ["-i", "-o", "-e"],
};

const DEV_NULL = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "nul", "NUL"]);

/** Why `command` would change something in plan mode, or null when it only reads. */
export function readOnlyProblem(command: string, allow: RegExp[] = []): string | null {
	for (const cmd of parseCommands(command)) {
		const problem = commandProblem(cmd, allow);
		if (problem) return problem;
	}
	return null;
}

function commandProblem(cmd: ParsedCommand, allow: RegExp[]): string | null {
	const text = cmd.words.join(" ");
	const write = cmd.writes.find((t) => !DEV_NULL.has(t));
	if (write !== undefined) return `\`${short(text || ">")}\` writes to ${write}`;
	let words = cmd.words;
	while (words.length && KEYWORDS.has(words[0])) words = words.slice(1);
	if (!words.length || ["for", "case", "select", "in"].includes(words[0])) return null;
	if (allow.some((re) => re.test(words.join(" ")))) return null;
	const why = wordsProblem(words, allow);
	return why ? `\`${short(words.join(" "))}\` ${why}` : null;
}

function wordsProblem(words: string[], allow: RegExp[]): string | null {
	const name = commandName(words[0]);
	const args = words.slice(1);
	if (name in WRAPPERS) return wrapperProblem(name, args, allow);
	if ((name === "bash" || name === "sh") && args[0] === "-c" && args[1] !== undefined) {
		const inner = readOnlyProblem(args[1], allow);
		return inner ? `runs ${inner}` : null;
	}
	const check = CHECKS[name];
	if (check) return check(args);
	return READ_ONLY.has(name) ? null : "is not on the read-only list";
}

/** A short option cluster (`-sSLo`) that contains one of `letters`. */
const shortHas = (a: string, letters: string) => /^-[a-zA-Z]+$/.test(a) && [...a.slice(1)].some((c) => letters.includes(c));

const script = (args: string[]) =>
	args.length === 1 && /^(-v|-V|--version)$/.test(args[0]) ? null : "runs a script, which can change files (use ctx_execute for read-only analysis)";

/** Commands that need their arguments checked. Each returns why it would change something, or null. */
const CHECKS: Record<string, (args: string[]) => string | null> = {
	git: (a) => gitProblem(a),
	gh: (a) => ghProblem(a),
	curl: (a) => curlProblem(a),
	npm: (a) => npmProblem(a),
	node: script,
	python: script,
	python3: script,
	py: script,
	sed: (a) => (a.some((x) => /^--in-place/.test(x) || shortHas(x, "i")) ? "edits files in place" : null),
	yq: (a) => (a.some((x) => /^--inplace/.test(x) || shortHas(x, "i")) ? "edits files in place" : null),
	awk: (a) => awkProblem(a),
	gawk: (a) => awkProblem(a),
	find: (a) => (a.some((x) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(x)) ? "deletes files or runs commands" : null),
	sort: (a) => (a.some((x) => /^--output/.test(x) || shortHas(x, "o")) ? "writes a file" : null),
	uniq: (a) => (positional(a).length > 1 ? "writes its second file argument" : null),
};

function awkProblem(args: string[]): string | null {
	return args.some((a) => /system\s*\(|\|\s*getline|>\s*"|\|\s*"|^-i/.test(a)) ? "can write files or run commands" : null;
}

function commandName(word: string): string {
	return word.split(/[\\/]/).pop()!.replace(/\.exe$/i, "");
}

function wrapperProblem(name: string, args: string[], allow: RegExp[]): string | null {
	const valued = WRAPPERS[name];
	let i = 0;
	while (i < args.length && (args[i].startsWith("-") || (name === "env" && /^[A-Za-z_]\w*=/.test(args[i])))) {
		i += valued.includes(args[i]) ? 2 : 1;
	}
	if (name === "timeout") i++; // the duration
	const rest = args.slice(i);
	if (!rest.length) return null;
	return commandProblem({ words: rest, writes: [] }, allow);
}

function short(text: string): string {
	return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

// ---------------------------------------------------------------------------
// git, gh, curl, npm
// ---------------------------------------------------------------------------

const GIT_READ = new Set(
	(
		"status log diff show blame grep ls-files ls-tree ls-remote rev-parse rev-list describe merge-base cat-file " +
		"for-each-ref shortlog whatchanged name-rev count-objects help version check-ignore check-attr show-ref " +
		"show-branch var cherry range-diff diff-tree diff-index diff-files"
	).split(" "),
);

function gitProblem(args: string[]): string | null {
	let i = 0;
	while (i < args.length && args[i].startsWith("-")) i += ["-C", "-c", "--git-dir", "--work-tree"].includes(args[i]) ? 2 : 1;
	const sub = args[i];
	const rest = args.slice(i + 1);
	if (sub === undefined || GIT_READ.has(sub)) return null;
	const ok = GIT_CONDITIONAL[sub]?.(rest) ?? false;
	return ok ? null : `changes the repository (git ${sub})`;
}

const positional = (rest: string[]) => rest.filter((a) => !a.startsWith("-"));
const has = (rest: string[], flags: string[]) => rest.some((a) => flags.includes(a.split("=")[0]));

const BRANCH_WRITE = ["-d", "-D", "-m", "-M", "-c", "-C", "-f", "-u", "--delete", "--move", "--copy", "--force", "--set-upstream-to", "--unset-upstream", "--edit-description"];
const BRANCH_LIST = ["-l", "--list", "--contains", "--merged", "--no-merged", "--points-at"];
const TAG_LIST = ["-l", "--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"];
const TAG_WRITE = ["-d", "-a", "-s", "-f", "-m", "-F", "-u", "--delete", "--annotate", "--sign", "--force"];

/** git subcommands that only read with some arguments. */
const GIT_CONDITIONAL: Record<string, (rest: string[]) => boolean> = {
	branch: (r) => !has(r, BRANCH_WRITE) && (positional(r).length === 0 || has(r, BRANCH_LIST)),
	tag: (r) => has(r, TAG_LIST) || (positional(r).length === 0 && !has(r, TAG_WRITE)),
	// A refspec with a colon (main:main) moves local branches.
	fetch: (r) => !positional(r).some((a) => a.includes(":")),
	remote: (r) => r.length === 0 || ["-v", "--verbose", "show", "get-url"].includes(r[0]),
	stash: (r) => ["list", "show"].includes(r[0]),
	config: (r) => has(r, ["--get", "--get-all", "--get-regexp", "--list", "-l"]),
	worktree: (r) => r[0] === "list",
	notes: (r) => ["list", "show"].includes(r[0]),
	reflog: (r) => r.length === 0 || r[0] === "show" || r[0].startsWith("-"),
	submodule: (r) => r.length === 0 || r[0] === "status",
};

const GH_READ_VERBS = new Set(["view", "list", "status", "checks", "diff", "watch"]);

function ghProblem(args: string[]): string | null {
	const [group, verb] = args;
	if (group === undefined || ["status", "search", "help", "version", "--version"].includes(group)) return null;
	if (group === "auth") return verb === "status" ? null : "changes GitHub login";
	if (group === "api") return ghApiProblem(args.slice(1));
	return verb !== undefined && GH_READ_VERBS.has(verb) ? null : `changes GitHub (gh ${group} ${verb ?? ""})`.trim();
}

/** gh api: GET unless -X says otherwise; fields turn it into a POST, except with an explicit GET or a GraphQL query. */
function ghApiProblem(args: string[]): string | null {
	let method: string | undefined;
	const fields: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "-X" || a === "--method") method = args[i + 1];
		else if (/^(-X|--method=)./.test(a)) method = a.replace(/^(-X|--method=)/, "");
		else if (a === "--input" || a.startsWith("--input=")) return "sends a request body to GitHub";
		else if (["-f", "-F", "--field", "--raw-field"].includes(a)) fields.push(args[i + 1] ?? "");
		else if (/^--(raw-)?field=/.test(a)) fields.push(a.slice(a.indexOf("=") + 1));
		else if (/^-[fF]./.test(a)) fields.push(a.slice(2));
	}
	if (method !== undefined) return /^(GET|HEAD)$/i.test(method) ? null : `sends ${method.toUpperCase()} to GitHub`;
	if (!fields.length) return null;
	const graphql = positional(args)[0] === "graphql";
	const query = fields.find((f) => f.startsWith("query="))?.slice(6) ?? "";
	if (graphql && !/^\s*mutation\b/.test(query)) return null;
	return graphql ? "runs a GraphQL mutation" : "sends data to GitHub (gh api with fields is a POST)";
}

/** curl long options that send data or write files. */
const CURL_WRITE = /^--(data|json|form|upload-file|output|remote-name|config|create-dirs|dump-header|cookie-jar|trace|stderr|output-dir)/;
/** Short options that send data or write files, and the ones that take a value (the rest of the cluster or the next word). */
const CURL_WRITE_SHORT = "dFTOoKDc";
const CURL_VALUE_SHORT = "HuAebmwxUErYyzCtQ";

function curlProblem(args: string[]): string | null {
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (CURL_WRITE.test(a)) return "sends data or writes a file";
		let method: string | undefined;
		if (a === "--request" || a.startsWith("--request=")) method = a === "--request" ? args[i + 1] : a.slice(10);
		else if (/^-[a-zA-Z]/.test(a) && !a.startsWith("--")) {
			for (let k = 1; k < a.length; k++) {
				const c = a[k];
				if (CURL_WRITE_SHORT.includes(c)) return "sends data or writes a file";
				if (c === "X") method = a.slice(k + 1) || args[i + 1];
				if (c === "X" || CURL_VALUE_SHORT.includes(c)) break;
			}
		}
		if (method !== undefined && !/^(GET|HEAD)$/i.test(method)) return `sends ${method}`;
	}
	return null;
}

const NPM_READ = new Set(["view", "info", "show", "v", "ls", "list", "la", "ll", "outdated", "root", "prefix", "help", "explain", "why", "search", "ping", "whoami", "--version", "-v"]);

function npmProblem(args: string[]): string | null {
	const [sub, next] = args;
	if (sub === undefined || NPM_READ.has(sub)) return null;
	if (sub === "config" && ["get", "list", "ls"].includes(next)) return null;
	if (sub === "audit" && !args.includes("fix")) return null;
	return `changes packages or runs scripts (npm ${sub})`;
}
