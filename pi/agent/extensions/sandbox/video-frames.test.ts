import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { findBinary, frameTimes, parseProbe, videoFrames } from "./video-frames.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-video-test-"));
const PROBE = JSON.stringify({
	format: { duration: "10.000000" },
	streams: [
		{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30000/1001" },
		{ codec_type: "audio", codec_name: "aac" },
	],
});

test("parseProbe reads duration, size, fps and audio", () => {
	assert.deepEqual(parseProbe(PROBE), { duration: 10, width: 1920, height: 1080, fps: 29.97, codec: "h264", audio: true });
	assert.throws(() => parseProbe(JSON.stringify({ streams: [{ codec_type: "audio" }] })), /no video stream/);
});

test("frameTimes spreads frames evenly, honours start/end, clamps times and count", () => {
	assert.deepEqual(frameTimes({ path: "x" }, 12), [1, 3, 5, 7, 9, 11]);
	assert.deepEqual(frameTimes({ path: "x", count: 2, start: 4, end: 8 }, 12), [5, 7]);
	assert.deepEqual(frameTimes({ path: "x", times: [-1, 3, 3, 99] }, 10), [0, 3, 9.95]);
	assert.equal(frameTimes({ path: "x", count: 100 }, 10).length, 16);
	assert.equal(frameTimes({ path: "x", count: 0 }, 10).length, 1);
	assert.deepEqual(frameTimes({ path: "x" }, 0), [0], "no duration: one frame, no duplicates");
	assert.deepEqual(frameTimes({ path: "x", times: [1.0001, 1.0004] }, 10), [1], "times that share a file name are one frame");
});

test("findBinary looks on PATH", () => {
	const dir = tmp();
	const exe = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
	fs.writeFileSync(path.join(dir, exe), "");
	assert.equal(findBinary("ffprobe", { PATH: dir }), path.join(dir, exe));
	assert.equal(findBinary("ffprobe", { PATH: tmp() }), undefined);
});

test("missing file and missing ffmpeg are clear errors", async () => {
	const dir = tmp();
	await assert.rejects(videoFrames({ path: "nope.mp4" }, { cwd: dir, find: () => "x" }), /no such file/);
	fs.writeFileSync(path.join(dir, "a.mp4"), "x");
	await assert.rejects(videoFrames({ path: "a.mp4" }, { cwd: dir, find: () => undefined }), /winget install Gyan\.FFmpeg/);
});

test("extracts frames, reuses them, and reports failures", async () => {
	const dir = tmp();
	fs.writeFileSync(path.join(dir, "a.mp4"), "x");
	const calls: string[][] = [];
	const run = async (bin: string, args: string[]) => {
		calls.push([bin, ...args]);
		if (bin === "ffprobe") return { code: 0, stdout: PROBE, stderr: "" };
		const t = args[args.indexOf("-ss") + 1];
		if (t === "9") return { code: 1, stdout: "", stderr: "bad frame\nmore" };
		fs.writeFileSync(args[args.length - 1], "jpg");
		return { code: 0, stdout: "", stderr: "" };
	};
	const deps = { cwd: dir, dir: path.join(dir, "out"), find: (n: string) => n, run };
	const r = await videoFrames({ path: "a.mp4", count: 5 }, deps);
	assert.equal(r.frames.length, 4);
	assert.equal(r.frames[0].data, Buffer.from("jpg").toString("base64"));
	assert.match(r.text, /Duration: 10\.00 s, 1920x1080, 29\.97 fps, h264, with audio/);
	assert.match(r.text, /Failed:\n- 9s: bad frame$/);
	const ffmpegCalls = calls.filter((c) => c[0] === "ffmpeg").length;
	await videoFrames({ path: "a.mp4", count: 5 }, deps);
	assert.equal(calls.filter((c) => c[0] === "ffmpeg").length - ffmpegCalls, 1, "only the failed frame is retried");
});

const ffmpeg = findBinary("ffmpeg");
test("real ffmpeg: frames of a generated clip", { skip: !ffmpeg || !findBinary("ffprobe") ? "ffmpeg not installed" : false }, async () => {
	const dir = tmp();
	const clip = path.join(dir, "clip.mp4");
	const gen = spawnSync(ffmpeg as string, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10", "-pix_fmt", "yuv420p", clip]);
	assert.equal(gen.status, 0, String(gen.stderr));
	const r = await videoFrames({ path: clip, count: 3, width: 160 }, { dir: path.join(dir, "out") });
	assert.equal(r.frames.length, 3, r.text);
	assert.match(r.text, /320x240, 10 fps/);
	for (const f of r.frames) assert.equal(fs.readFileSync(f.file).subarray(0, 2).toString("hex"), "ffd8");
});
