/** Validates a terminal request sent by pi. No VS Code import, so Node can test it. */

function parseRequest(line) {
	let r;
	try {
		r = JSON.parse(line);
	} catch {
		return { ok: false, error: "bad request: invalid JSON" };
	}
	if (!r || typeof r !== "object" || Array.isArray(r)) return { ok: false, error: "bad request: not an object" };
	for (const k of ["name", "cwd", "shellPath"]) {
		if (typeof r[k] !== "string" || !r[k]) return { ok: false, error: `bad request: ${k} must be a non-empty string` };
	}
	if (!Array.isArray(r.shellArgs) || !r.shellArgs.every((a) => typeof a === "string")) {
		return { ok: false, error: "bad request: shellArgs must be a list of strings" };
	}
	if (!/^([a-zA-Z]:)?[\\/]/.test(r.cwd)) return { ok: false, error: "bad request: cwd must be an absolute path" };
	return { ok: true, req: r };
}

module.exports = { parseRequest };
