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
			// A folder that holds a link: some delete tools follow the link into the original.
			// Only the delete command's own arguments count, not a `cd` or `find .` elsewhere in the text.
			const args = text.split(/[;&|\n]+/).filter((s) => RECURSIVE_DELETE.test(s)).flatMap((seg) => {
				const toks = seg.split(/[\s"'`;|&()]+/);
				const v = toks.findIndex((x) => /^(rm|rmdir|remove-item|rimraf|del)$/i.test(x));
				if (v < 0 || (v > 0 && /^rm$/i.test(toks[v]) && /^git$/i.test(toks[v - 1]))) return [];
				const cmd = /^(rmdir|del)$/i.test(toks[v]);
				return toks.slice(v + 1).filter((x) => !(cmd && /^\/[sq]$/i.test(x)));
			});
			for (const raw of args) {
				if (!raw || raw.startsWith("-")) continue;
				const tok = raw === "*" || raw === "**" ? "." : raw.replace(/\/\*{1,2}$/, "");
				const abs = path.isAbsolute(tok) ? tok : path.join(o.cwd, tok);
				const l = o.linked.find((x) => insidePath(x, abs));
				if (l) return `${raw} holds ${inRepo(l)}, a link to the original repo; deleting it recursively could delete the original's files. Ask the user to run /wt unlink ${inRepo(l)} first (or /wt remove for the whole set).`;
			}
		}
	}
	return null;
}
