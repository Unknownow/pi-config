/** Refuses tool calls that would change the original repo through a linked folder (node_modules, .pi/git, ...) of a worktree set. */

import * as path from "node:path";

export interface SharedOptions {
	cwd: string;
	setRoot: string;
	/** Absolute paths of the links inside the set. */
	linked: string[];
}

const BS = String.fromCharCode(92);
const slash = (p: string) => p.split(BS).join("/").replace(/\/+$/, "");
const fold = (p: string) => (process.platform === "win32" ? slash(p).toLowerCase() : slash(p));
const insidePath = (p: string, dir: string) => fold(p) === fold(dir) || fold(p).startsWith(`${fold(dir)}/`);

const INSTALL = /(^|[\s;&|(])(npm\s+(install|i|ci|add|update)\b|pnpm\s+(install|i|add|update)\b|yarn(\s+(install|add|upgrade)\b|\s*($|[;&|)])))/m;
const RECURSIVE_DELETE = /(^|[\s;&|(])(rm\b[^\n;|&]*\s(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b|rmdir\s+\/s\b|Remove-Item\b[^\n;|&]*-Recurse|rimraf\b|del\s+\/s\b)/im;

function texts(toolName: string, input: Record<string, unknown>): string[] {
	if (/(^|__)bash$/.test(toolName)) return [String(input.command ?? "")];
	if (/(^|__)ctx_execute(_file)?$/.test(toolName)) {
		const lang = String(input.language ?? "").toLowerCase();
		return ["shell", "bash", "sh", "zsh", "powershell", "pwsh", "ps1"].includes(lang) ? [String(input.code ?? "")] : [];
	}
	if (/(^|__)ctx_batch_execute$/.test(toolName) && Array.isArray(input.commands)) return input.commands.map((c) => String((c as { command?: unknown })?.command ?? ""));
	return [];
}

/** Why the call would change the original repo through a link, or null. */
export function sharedProblem(toolName: string, input: Record<string, unknown>, o: SharedOptions): string | null {
	if (!o.linked.length) return null;
	const rel = (l: string) => slash(path.relative(o.setRoot, l));
	/** The link's path inside its repo, which is what /wt unlink takes. */
	const inRepo = (l: string) => rel(l).split("/").slice(1).join("/") || rel(l);
	if (/(^|__)(edit|write)$/.test(toolName)) {
		const p = String(input.path ?? input.file_path ?? "");
		if (!p) return null;
		const abs = path.isAbsolute(p) ? p : path.join(o.cwd, p);
		const hit = o.linked.find((l) => insidePath(abs, l));
		return hit ? `${rel(hit)} is a link to the original repo; editing ${p} would change the original's files. Ask the user to run /wt unlink ${inRepo(hit)}.` : null;
	}
	for (const t of texts(toolName, input)) {
		const text = t.split(BS).join("/");
		if (INSTALL.test(text)) {
			const nm = o.linked.find((l) => slash(l).endsWith("/node_modules"));
			if (nm) return `node_modules in ${slash(path.dirname(nm))} is linked to the original repo; installing would change it. Ask the user to run /wt unlink node_modules first.`;
		}
		if (RECURSIVE_DELETE.test(text)) {
			for (const l of o.linked) {
				const r = inRepo(l);
				const names = [slash(l), rel(l), r];
				const tokens = text.split(/[\s"'`;|&()]+/).map((x) => x.replace(/^\.\//, "").replace(/\/+$/, ""));
				const hit = tokens.some((tok) => tok && names.some((n) => fold(tok) === fold(n) || fold(tok).endsWith(`/${fold(r)}`)));
				if (hit) return `${r} is a link to the original repo; deleting recursively could delete the original's files. Ask the user to run /wt unlink ${r}.`;
			}
		}
	}
	return null;
}
