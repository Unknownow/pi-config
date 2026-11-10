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
