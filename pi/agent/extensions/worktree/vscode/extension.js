// pi-terminal-bridge: lets pi's /wt new open a terminal in this VS Code window.
const vscode = require("vscode");
const net = require("net");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { parseRequest } = require("./request.js");

const MAX_LINE = 64 * 1024;

function pipePath() {
	const id = `pi-vscode-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
	return process.platform === "win32" ? `\\\\.\\pipe\\${id}` : path.join(os.tmpdir(), `${id}.sock`);
}

function handle(sock) {
	let buf = "";
	let handled = false;
	const reply = (obj) => sock.end(`${JSON.stringify(obj)}\n`);
	sock.setEncoding("utf8");
	sock.on("error", () => {});
	sock.on("data", (d) => {
		if (handled) return;
		buf += d;
		const i = buf.indexOf("\n");
		if (i < 0) {
			if (buf.length > MAX_LINE) {
				handled = true;
				reply({ ok: false, error: "bad request: too long" });
			}
			return;
		}
		handled = true;
		const p = parseRequest(buf.slice(0, i));
		if (!p.ok) return reply({ ok: false, error: p.error });
		try {
			const t = vscode.window.createTerminal({
				name: p.req.name,
				cwd: p.req.cwd,
				shellPath: p.req.shellPath,
				shellArgs: p.req.shellArgs,
				location: vscode.TerminalLocation.Panel,
			});
			t.show(false);
			reply({ ok: true });
		} catch (e) {
			reply({ ok: false, error: e && e.message ? e.message : String(e) });
		}
	});
}

function activate(context) {
	const pipe = pipePath();
	const server = net.createServer(handle);
	server.on("error", (e) => console.error("pi-terminal-bridge:", e));
	server.listen(pipe, () => {
		const c = context.environmentVariableCollection;
		c.persistent = false;
		c.description = "pi: lets /wt new open a terminal in this window";
		c.replace("PI_VSCODE_TERMINAL", pipe);
	});
	context.subscriptions.push({
		dispose() {
			server.close();
			if (process.platform !== "win32") {
				try {
					fs.unlinkSync(pipe);
				} catch {}
			}
		},
	});
}

function deactivate() {}

module.exports = { activate, deactivate };
