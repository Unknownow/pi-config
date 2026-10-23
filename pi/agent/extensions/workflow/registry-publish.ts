/** Publish and Mirror steps: the executor publishes this flow's unity-packages versions and mirrors vendor packages through `publish_packages`. Pure text and decisions, kept apart so node tests can reach them. */

const PKG = /^com\.iecgames\.[a-z0-9][a-z0-9._-]*$/i;
const VERSIONED = /@|\/v?\d|\bv?\d+\.\d+/;

function stepLine(plan: string, id: string, word: string): string | null {
	const escaped = id.replace(/[^A-Za-z0-9_-]/g, (c) => `\\${c}`);
	const line = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?(?:\\[[ xX]\\][ \\t]*)?\\*\\*${escaped}\\.?\\*\\*[ \\t]*(.*)$`, "m").exec(plan);
	if (!line) return null;
	const m = new RegExp(`^${word}\\s*:\\s*(.*)$`, "i").exec(line[1].trim());
	return m ? m[1].trim() : null;
}

/** The packages a `**S<n>.** Publish: <package>[, <package>…]` step names; null when it is not a Publish step or names a version or something that is not a package. */
export function parsePublishStep(plan: string, id: string): { packages: string[] } | null {
	const text = stepLine(plan, id, "publish");
	if (text === null) return null;
	const packages = text.replace(/\.$/, "").split(/\s*,\s*|\s+and\s+/i).map((p) => p.replace(/[`"']/g, "").trim()).filter(Boolean);
	if (!packages.length || packages.some((p) => VERSIONED.test(p) && !PKG.test(p)) || packages.some((p) => !PKG.test(p))) return null;
	return { packages: [...new Set(packages)] };
}

/** `**S<n>.** Mirror: <folder>|all[; extras <name@version,…>]`. */
export function parseMirrorStep(plan: string, id: string): { target: string; extras: string[] } | null {
	const text = stepLine(plan, id, "mirror");
	if (text === null) return null;
	const [head, ...rest] = text.replace(/\.$/, "").split(/\s*;\s*/);
	const target = head.replace(/[`"']/g, "").trim();
	if (!target || /\s/.test(target) || (target !== "all" && !/^[A-Za-z0-9._-]+$/.test(target))) return null;
	let extras: string[] = [];
	for (const r of rest) {
		const m = /^extras\s+(.*)$/i.exec(r.trim());
		if (!m) return null;
		extras = m[1].replace(/[`"']/g, "").split(/\s*,\s*/).filter(Boolean);
		if (extras.some((e) => !/^[^@\s]+@\S+$/.test(e))) return null;
	}
	return { target, extras };
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The read-only check of a blocked publish: succeeds once the registry has what the versions wait for. */
export function blockedWaitCheck(root: string, items: { name: string; version: string }[]): string {
	const only = items.map((i) => `${i.name}@${i.version}`).join(",");
	return `node ${quote(`${root.replace(/\\/g, "/")}/scripts/update-packages.mjs`)} publish --only ${quote(only)} --dry-run --unblocked`;
}

/** Whether the publish lock is free, held by a live or recent session, or left behind. */
export function lockDecision(lock: { pid: number; startedAt: string } | null, now: number, pidAlive: (pid: number) => boolean): "free" | "held" | "stale" {
	if (!lock) return "free";
	const started = Date.parse(lock.startedAt);
	if (Number.isFinite(started) && now - started < 30 * 60_000) return "held";
	if (!Number.isInteger(lock.pid) || lock.pid <= 0) return "stale";
	return pidAlive(lock.pid) ? "held" : "stale";
}

/** The wait check for a held lock: succeeds once the lock file is gone, or is older than 30 minutes with a dead pid (the same rule as lockDecision). */
export function lockWaitCheck(lockFile: string): string {
	const p = lockFile.replace(/\\/g, "/");
	const js = `const fs=require('fs');const p='${p}';if(!fs.existsSync(p))process.exit(0);let l;try{l=JSON.parse(fs.readFileSync(p,'utf8'))}catch(e){l={pid:0,startedAt:fs.statSync(p).mtime}};let a=l.pid>0;if(a){try{process.kill(l.pid,0)}catch(e){a=false}};process.exit(Date.now()-Date.parse(l.startedAt)>1800000&&!a?0:1)`;
	return `node -e "${js}"`;
}

/** The `since` of a Publish/Mirror step's wait: the first one, so the wait's time limit counts across blocked retries. */
export function waitSince(prev: string | undefined, now: string): string {
	return prev ?? now;
}

/** Whether a delivery that ended with `ok` landed a merge, so the judged head may be read as merged. */
export function shouldRecordMerged(mode: string, ok: boolean): boolean {
	return mode === "merge" && ok;
}

type Item = { name: string; version: string };

/** Splits a Publish step's versions by the script's dry run: a candidate is published; a non-candidate whose tag is on origin is already on the registry (a tagged version stays a candidate until the registry has it); any other is not publishable. */
export function classifyPublish(items: Item[], dry: { items?: Item[]; notCandidates?: string[] }, taggedOnOrigin: Set<string>): { publish: Item[]; alreadyPublished: Item[]; notPublishable: string[] } {
	const out = { publish: [] as Item[], alreadyPublished: [] as Item[], notPublishable: [] as string[] };
	for (const i of items) {
		if (dry.items?.some((c) => c.name === i.name && c.version === i.version)) out.publish.push(i);
		else if (taggedOnOrigin.has(`${i.name}/v${i.version}`) && dry.notCandidates?.includes(`${i.name}@${i.version}`)) out.alreadyPublished.push(i);
		else out.notPublishable.push(`${i.name}@${i.version}`);
	}
	return out;
}

/** Arguments (after `node <script>`) of update-packages.mjs for these versions: the dry run that reports, or the confirmed publish. */
export function publishArgs(items: { name: string; version: string }[], dryRun: boolean): string[] {
	const only = items.map((i) => `${i.name}@${i.version}`).join(",");
	return dryRun ? ["publish", "--only", only, "--dry-run", "--json"] : ["publish", "--only", only, "--confirm", "publish"];
}

/** Arguments (after `node <script>`) of maintenance.mjs for a mirror step; `dryRun` leaves out the confirmation. */
export function mirrorArgs(step: { target: string; extras: string[] }, dryRun = false): string[] {
	const args = ["mirror", ...(step.target === "all" ? ["--all"] : ["--package", step.target])];
	if (step.extras.length) args.push("--extras", step.extras.join(","));
	if (!dryRun) args.push("--confirm", "mirror");
	return args;
}
