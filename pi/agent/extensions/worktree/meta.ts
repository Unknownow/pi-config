/** `<set>/.pi-set.json`: what /wt new recorded about a set. Sets made by older versions have none. */

import * as fs from "node:fs";
import * as path from "node:path";

export interface SetMeta {
	v: 1;
	created: string;
	branch: string;
	repos: { main: string; dir: string }[];
}

export function readMeta(set: string): SetMeta | null {
	try {
		const m = JSON.parse(fs.readFileSync(path.join(set, ".pi-set.json"), "utf8")) as SetMeta;
		return m && m.v === 1 && typeof m.branch === "string" && Array.isArray(m.repos) ? m : null;
	} catch {
		return null;
	}
}

export function writeMeta(set: string, meta: SetMeta): void {
	try {
		fs.mkdirSync(set, { recursive: true });
		fs.writeFileSync(path.join(set, ".pi-set.json"), JSON.stringify(meta, null, 2));
	} catch {}
}
