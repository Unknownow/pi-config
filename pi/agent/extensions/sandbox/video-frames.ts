/** video_frames: probe a video with ffprobe and pull still frames with ffmpeg into the temp folder. */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MAX_FRAMES = 16;
const DEFAULT_FRAMES = 6;
const DEFAULT_WIDTH = 768;
const CONCURRENCY = 4;
const RUN_TIMEOUT_MS = 60_000;
const CACHE_DAYS = 7;

export interface VideoParams {
	path: string;
	count?: number;
	times?: number[];
	start?: number;
	end?: number;
	width?: number;
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface VideoDeps {
	cwd?: string;
	dir?: string;
	signal?: AbortSignal;
	/** Runs a program; tests replace it. */
	run?: (bin: string, args: string[], signal?: AbortSignal) => Promise<RunResult>;
	/** Finds ffmpeg/ffprobe; tests replace it. */
	find?: (name: string) => string | undefined;
}

export interface VideoInfo {
	duration: number;
	width?: number;
	height?: number;
	fps?: number;
	codec?: string;
	audio: boolean;
}

export interface Frame {
	time: number;
	file: string;
	data: string;
	mimeType: "image/jpeg";
}

/** PATH first, then the WinGet links folder, which a running process may not have on its PATH yet. */
export function findBinary(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const exe = process.platform === "win32" ? `${name}.exe` : name;
	const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
	if (process.platform === "win32" && env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"));
	for (const dir of dirs) {
		const file = path.join(dir, exe);
		if (fs.existsSync(file)) return file;
	}
	return undefined;
}

function runProgram(bin: string, args: string[], signal?: AbortSignal): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, signal: AbortSignal.any([AbortSignal.timeout(RUN_TIMEOUT_MS), ...(signal ? [signal] : [])]) });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("error", (e) => resolve({ code: -1, stdout, stderr: stderr || e.message }));
		child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
	});
}

function parseRate(rate: unknown): number | undefined {
	const m = /^(\d+)\/(\d+)$/.exec(String(rate ?? ""));
	if (!m || Number(m[2]) === 0) return undefined;
	return Math.round((Number(m[1]) / Number(m[2])) * 100) / 100;
}

export function parseProbe(json: string): VideoInfo {
	const d = JSON.parse(json) as { format?: { duration?: string }; streams?: Record<string, unknown>[] };
	const streams = d.streams ?? [];
	const video = streams.find((s) => s.codec_type === "video");
	if (!video) throw new Error("no video stream in the file");
	const duration = Number(d.format?.duration ?? video.duration);
	return {
		duration: Number.isFinite(duration) ? duration : 0,
		width: typeof video.width === "number" ? video.width : undefined,
		height: typeof video.height === "number" ? video.height : undefined,
		fps: parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate),
		codec: typeof video.codec_name === "string" ? video.codec_name : undefined,
		audio: streams.some((s) => s.codec_type === "audio"),
	};
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The frame times: the given ones, or `count` evenly spread over [start, end], each in the middle of its slice. */
export function frameTimes(params: VideoParams, duration: number): number[] {
	const last = Math.max(0, duration - 0.05);
	if (params.times?.length) return [...new Set(params.times.slice(0, MAX_FRAMES).map((t) => Math.round(clamp(Number(t) || 0, 0, last) * 1000) / 1000))];
	const start = clamp(params.start ?? 0, 0, last);
	const end = clamp(params.end ?? duration, start, duration);
	const count = clamp(Math.round(params.count ?? DEFAULT_FRAMES), 1, MAX_FRAMES);
	const step = (end - start) / count;
	return [...new Set(Array.from({ length: count }, (_, i) => Math.round((start + step * (i + 0.5)) * 1000) / 1000))];
}

/** Drops frame folders not touched for a week. */
function pruneCache(root: string, now = Date.now()): void {
	try {
		for (const name of fs.readdirSync(root)) {
			const dir = path.join(root, name);
			if (now - fs.statSync(dir).mtimeMs > CACHE_DAYS * 86_400_000) fs.rmSync(dir, { recursive: true, force: true });
		}
	} catch {
		// a cache we cannot clean is still usable
	}
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = [];
	for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
	return out;
}

export async function videoFrames(params: VideoParams, deps: VideoDeps = {}): Promise<{ text: string; frames: Frame[] }> {
	const file = path.resolve(deps.cwd ?? process.cwd(), params.path);
	if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`no such file: ${file}`);
	const find = deps.find ?? findBinary;
	const run = deps.run ?? runProgram;
	const ffprobe = find("ffprobe");
	const ffmpeg = find("ffmpeg");
	if (!ffprobe || !ffmpeg) throw new Error("ffmpeg/ffprobe not found; install them (winget install Gyan.FFmpeg) and try again");

	const probe = await run(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,duration", "-of", "json", file], deps.signal);
	if (probe.code !== 0) throw new Error(`ffprobe failed: ${probe.stderr.trim().slice(0, 500)}`);
	const info = parseProbe(probe.stdout);

	const width = clamp(Math.round(params.width ?? DEFAULT_WIDTH), 64, 1920);
	const stat = fs.statSync(file);
	const key = createHash("sha1").update(`${file}|${stat.size}|${stat.mtimeMs}`).digest("hex").slice(0, 16);
	if (!deps.dir) pruneCache(path.join(os.tmpdir(), "pi-video-frames"));
	const dir = path.join(deps.dir ?? path.join(os.tmpdir(), "pi-video-frames"), key);
	fs.mkdirSync(dir, { recursive: true });
	fs.utimesSync(dir, new Date(), new Date());

	const failed: string[] = [];
	const frames = await inBatches(frameTimes(params, info.duration), CONCURRENCY, async (time): Promise<Frame | undefined> => {
		const out = path.join(dir, `t${Math.round(time * 1000)}-w${width}.jpg`);
		if (!fs.existsSync(out)) {
			const r = await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-ss", String(time), "-i", file, "-frames:v", "1", "-vf", `scale='min(${width},iw)':-2`, "-q:v", "4", "-y", out], deps.signal);
			if (r.code !== 0 || !fs.existsSync(out)) {
				failed.push(`${time}s: ${r.stderr.trim().split("\n")[0] || `exit ${r.code}`}`);
				return undefined;
			}
		}
		return { time, file: out, data: fs.readFileSync(out).toString("base64"), mimeType: "image/jpeg" };
	});
	const ok = frames.filter((f): f is Frame => !!f);

	const size = info.width && info.height ? `${info.width}x${info.height}` : "unknown size";
	const lines = [
		`Video: ${file}`,
		`Duration: ${info.duration.toFixed(2)} s, ${size}${info.fps ? `, ${info.fps} fps` : ""}${info.codec ? `, ${info.codec}` : ""}, ${info.audio ? "with" : "no"} audio`,
		`Frames (${ok.length}, saved in ${dir}):`,
		...ok.map((f) => `- ${f.time.toFixed(3)} s: ${path.basename(f.file)}`),
	];
	if (failed.length) lines.push("Failed:", ...failed.map((f) => `- ${f}`));
	if (!info.duration && !params.times?.length) lines.push("The file reports no duration, so only the first frame was taken; pass times to pick others.");
	if (!ok.length) lines.push("No frame could be extracted.");
	return { text: lines.join("\n"), frames: ok };
}
