/** Glob matching for owned and forbidden paths. Forward slashes, case-insensitive. */

export function normalizePath(p: string): string {
	return p.replace(/[\\]/g, "/").replace(/^\.\//, "");
}

/** `**` crosses folders, `*` and `?` stay inside one. `dir/**` matches everything below dir. */
export function globToRegExp(glob: string): RegExp {
	const g = normalizePath(glob).replace(/[/]+$/, "");
	// a path without wildcards, or ending in a slash, names a folder: everything below it matches
	const dir = !/[*?]/.test(glob) || /[/\\]$/.test(glob);
	let re = "";
	for (let i = 0; i < g.length; i++) {
		const c = g[i];
		if (c === "*") {
			if (g[i + 1] === "*") {
				i++;
				if (g[i + 1] === "/") {
					i++;
					re += "(?:.*/)?";
				} else re += ".*";
			} else re += "[^/]*";
		} else if (c === "?") re += "[^/]";
		else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}${dir ? "(?:/.*)?" : ""}$`, "i");
}

export function matchesAny(file: string, globs: string[]): boolean {
	const f = normalizePath(file);
	return globs.some((g) => globToRegExp(g).test(f));
}

/** Files that are in a forbidden glob, or in no owned glob. Forbids win over owns. */
export function outsideOwned(files: string[], owns: string[], forbids: string[]): string[] {
	return files.filter((f) => matchesAny(f, forbids) || !matchesAny(f, owns));
}

/** The folder part of a glob before its first wildcard, without a trailing slash ("" when the glob starts with one). */
function literalDir(glob: string): string {
	const g = normalizePath(glob).toLowerCase();
	const i = g.search(/[*?]/);
	const lit = i < 0 ? g : g.slice(0, g.lastIndexOf("/", i) + 1 > 0 ? g.lastIndexOf("/", i) + 1 : 0);
	return lit.replace(/\/+$/, "");
}

/** Whether two canonical globs (`key:path` or bare) may match the same file. Conservative: equal or nested literal folders count. Different repo keys never overlap. */
export function globsMayOverlap(a: string, b: string): boolean {
	const ka = /^([a-z0-9._-]+):/i.exec(a)?.[1].toLowerCase() ?? "";
	const kb = /^([a-z0-9._-]+):/i.exec(b)?.[1].toLowerCase() ?? "";
	if (ka !== kb) return false;
	const pa = literalDir(ka ? a.slice(ka.length + 1) : a);
	const pb = literalDir(kb ? b.slice(kb.length + 1) : b);
	return pa === pb || pa === "" || pb === "" || pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`);
}

/** The files of `git status --porcelain=v1 -z` (untrimmed output): entries are `XY path`, split on NUL; after a rename or copy the next entry is the old path and is skipped. Pure. */
export function parsePorcelainZ(out: string): string[] {
	const parts = out.split("\0");
	const files: string[] = [];
	for (let i = 0; i < parts.length; i++) {
		const e = parts[i];
		if (e.length < 4) continue;
		files.push(e.slice(3));
		if (e[0] === "R" || e[0] === "C" || e[1] === "R" || e[1] === "C") i++;
	}
	return files;
}
