/** Small glob matcher for repo-relative paths: `**` crosses folders, `*` and `?` stay inside one. */

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
	const hit = cache.get(glob);
	if (hit) return hit;
	const g = glob.split("\\").join("/");
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
	const out = new RegExp(`^${re}$`, "i");
	cache.set(glob, out);
	return out;
}

export function normPath(p: string): string {
	return p.split("\\").join("/").replace(/^\.\//, "");
}

export function matchesAny(globs: string[], p: string): boolean {
	const n = normPath(p);
	return globs.some((g) => globToRegExp(g).test(n));
}

/** Whether two glob sets can name the same file (approximated: a glob's literal prefix is a prefix of the other, or the other's path matches it). */
export function globsOverlap(a: string[], b: string[]): boolean {
	const prefix = (g: string) => normPath(g).split(/[*?]/)[0];
	for (const x of a) {
		for (const y of b) {
			const px = prefix(x);
			const py = prefix(y);
			if (px.startsWith(py) || py.startsWith(px)) return true;
		}
	}
	return false;
}

/** Whether two file lists (paths or globs) can name the same file: equal, one matches the other, or two globs share a literal directory prefix. */
export function filesOverlap(a: string[], b: string[]): boolean {
	const dirOf = (g: string) => {
		const lit = normPath(g).split(/[*?]/)[0];
		return lit.endsWith("/") ? lit : lit.slice(0, lit.lastIndexOf("/") + 1);
	};
	for (const x of a.map(normPath)) {
		for (const y of b.map(normPath)) {
			if (x === y || globToRegExp(x).test(y) || globToRegExp(y).test(x)) return true;
			if (/[*?]/.test(x) && /[*?]/.test(y)) {
				const dx = dirOf(x);
				const dy = dirOf(y);
				if (dx && dy && (dx.startsWith(dy) || dy.startsWith(dx))) return true;
				// a leading wildcard (`**/x.ts`) can sit in any directory: the file name parts decide
				if (!dx || !dy) {
					const bx = x.split("/").pop() ?? x;
					const by = y.split("/").pop() ?? y;
					if (globToRegExp(bx).test(by) || globToRegExp(by).test(bx)) return true;
				}
			}
		}
	}
	return false;
}
