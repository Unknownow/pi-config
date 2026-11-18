// Helper process for sync-lock.test.ts: take the lock, hold it, report.
// usage: node --experimental-strip-types sync-lock-child.ts <dir> <waitMs> <holdMs>
import { acquire } from "./sync-lock.ts";

const [dir, waitMs, holdMs] = process.argv.slice(2);
const lock = await acquire(dir, { waitMs: Number(waitMs), pollMs: 20 });
if (!lock) {
	console.log(JSON.stringify({ got: false }));
} else {
	const start = Date.now();
	await new Promise((r) => setTimeout(r, Number(holdMs)));
	const end = Date.now();
	lock.release();
	console.log(JSON.stringify({ got: true, start, end, pid: process.pid }));
}
