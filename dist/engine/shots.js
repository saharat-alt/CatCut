/**
 * Shot index per source file (DESIGN.md §13.2 row 2).
 *
 * One low-res decode (`scale=320:-2,format=gbrp,scdet`) per file, every frame (no keyframe skipping).
 * gbrp because scdet only compares the luma plane of YUV input and misses equal-luma colour changes. scdet
 * prints `lavfi.scd.mafd` (mean absolute frame difference = motion) and `lavfi.scd.score` for every
 * frame, and `lavfi.scd.time` on frames that start a new shot. Positions are mapped from pts_time
 * (relative to the first video frame) to integer frames at the PROJECT fps, which is what Clip.in uses.
 *
 * Cache: <project>/cache/shots/<fileHash>.json holds one entry per (threshold, ffmpeg version, fps).
 * Per-frame motion is stored sqrt-quantised to one byte per frame (base64), so long files stay small.
 */
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { hashFile } from '../core/hash.js';
export const DEFAULT_SCENE_THRESHOLD = 10; // scdet score 0..100
const CACHE_SCHEMA = 1;
const SCALE_WIDTH = 320;
// ---------- process ----------
async function run(file, args, timeoutMs, signal) {
    const r = await execa(file, args, {
        reject: false,
        windowsHide: true,
        stdin: 'ignore',
        timeout: timeoutMs,
        cancelSignal: signal,
        forceKillAfterDelay: 2000,
        maxBuffer: 512 * 2 ** 20,
    });
    if (r.isCanceled)
        throw new Error('shot detection cancelled');
    if (r.timedOut)
        throw new Error(`${basename(file)} timed out after ${timeoutMs} ms`);
    return { exitCode: r.exitCode ?? -1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
}
const versionMemo = new Map();
export function ffmpegVersion(tools) {
    let v = versionMemo.get(tools.ffmpeg);
    if (!v) {
        v = run(tools.ffmpeg, ['-hide_banner', '-version'], 30_000)
            .then((r) => r.stdout.split(/\r?\n/)[0]?.replace(/^ffmpeg version\s+/, '').trim() || 'unknown')
            .catch(() => 'unknown');
        versionMemo.set(tools.ffmpeg, v);
    }
    return v;
}
async function probeDurationSec(tools, path, signal) {
    const r = await run(tools.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], 60_000, signal);
    const d = Number(r.stdout.trim());
    return r.exitCode === 0 && Number.isFinite(d) && d > 0 ? d : undefined;
}
/** `frame:N pts:P pts_time:T` header followed by `lavfi.scd.*=v` lines (metadata=print). */
function parseScdet(text) {
    const out = [];
    let cur;
    for (const line of text.split(/\r?\n/)) {
        const h = /^frame:\s*\d+\s+pts:\s*\S+\s+pts_time:\s*(-?[\d.]+(?:e[-+]?\d+)?)/.exec(line);
        if (h) {
            cur = { t: Number(h[1]), mafd: 0, cut: false };
            out.push(cur);
            continue;
        }
        if (!cur)
            continue;
        const m = /^lavfi\.scd\.(mafd|time)=(-?[\d.]+(?:e[-+]?\d+)?)/.exec(line.trim());
        if (!m)
            continue;
        if (m[1] === 'mafd')
            cur.mafd = Number(m[2]) || 0;
        else
            cur.cut = true;
    }
    return out;
}
/** Frame records → index at project fps. Frames are positioned relative to the first video frame. */
function buildIndex(recs, fps, base) {
    const t0 = recs.length ? Math.min(...recs.slice(0, 8).map((r) => r.t)) : 0;
    const pos = (t) => Math.max(0, Math.round((t - t0) * fps));
    const last = recs.length ? pos(recs[recs.length - 1].t) : -1;
    const frames = last + 1;
    const motion = new Array(Math.max(0, frames)).fill(undefined);
    const cutSet = new Set();
    for (const r of recs) {
        const f = pos(r.t);
        if (f >= frames)
            continue;
        motion[f] = r.mafd;
        if (r.cut && f > 0)
            cutSet.add(f);
    }
    // Frame-rate conversion holes (source fps < project fps) repeat the previous value.
    let prev = 0;
    const filled = motion.map((v) => (prev = v ?? prev));
    const cuts = [...cutSet].sort((a, b) => a - b);
    return { ...base, fps, frames, cuts, shots: shotsFrom(cuts, frames, filled), motion: filled };
}
function shotsFrom(cuts, frames, motion) {
    const bounds = [0, ...cuts, frames];
    const shots = [];
    for (let i = 0; i + 1 < bounds.length; i++) {
        const start = bounds[i];
        const end = bounds[i + 1];
        if (end <= start)
            continue;
        shots.push({ start, end, motion: round3(meanMotion(motion, start, end, cuts)) });
    }
    return shots;
}
function round3(v) {
    return Math.round(v * 1000) / 1000;
}
/** Mean motion over [from, to), skipping cut frames (their mafd measures the cut, not motion). */
function meanMotion(motion, from, to, cuts = []) {
    let sum = 0;
    let n = 0;
    const skip = new Set(cuts);
    for (let f = Math.max(0, from); f < Math.min(to, motion.length); f++) {
        if (skip.has(f))
            continue;
        sum += motion[f];
        n++;
    }
    return n ? sum / n : 0;
}
function encodeMotion(m) {
    const buf = Buffer.alloc(m.length);
    m.forEach((v, i) => { buf[i] = Math.min(255, Math.round(Math.sqrt(Math.max(0, v)) * 25)); });
    return buf.toString('base64');
}
function decodeMotion(s) {
    return [...Buffer.from(s, 'base64')].map((q) => round3((q / 25) ** 2));
}
function sameKey(e, threshold, ver, fps) {
    return e.threshold === threshold && e.ffmpegVersion === ver && Math.abs(e.fps - fps) < 1e-6;
}
export function shotCachePath(cacheDir, fileHash) {
    return join(cacheDir, `${fileHash}.json`);
}
async function readCache(file) {
    if (!existsSync(file))
        return undefined;
    try {
        const j = JSON.parse(await readFile(file, 'utf8'));
        return Array.isArray(j.entries) ? j : undefined;
    }
    catch {
        return undefined; // corrupt cache: recompute
    }
}
/** Cached index for this file/threshold/ffmpeg/fps, without decoding anything. */
export async function loadCachedShots(cacheDir, fileHash, opts) {
    const c = await readCache(shotCachePath(cacheDir, fileHash));
    const th = opts.threshold ?? DEFAULT_SCENE_THRESHOLD;
    const e = c?.entries.find((x) => x.schema === CACHE_SCHEMA && sameKey(x, th, opts.ffmpegVersion, opts.fps));
    if (!e)
        return undefined;
    const { schema: _s, motionQ, ...rest } = e;
    return { ...rest, motion: decodeMotion(motionQ) };
}
async function writeCache(cacheDir, idx) {
    await mkdir(cacheDir, { recursive: true });
    const file = shotCachePath(cacheDir, idx.fileHash);
    const prev = await readCache(file);
    const { motion, ...rest } = idx;
    const entry = { schema: CACHE_SCHEMA, ...rest, motionQ: encodeMotion(motion) };
    const entries = (prev?.entries ?? []).filter((x) => !(x.schema === CACHE_SCHEMA && sameKey(x, idx.threshold, idx.ffmpegVersion, idx.fps)));
    entries.push(entry);
    // Cache, not an output: replaced atomically (temp file + rename) so readers never see half a file.
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ fileHash: idx.fileHash, entries })}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(tmp, file);
}
// ---------- detection ----------
/**
 * Shot changes + per-frame motion of the first video stream. The path is only ever an `-i` argument
 * (Thai paths are safe). Returns the cached index when one matches.
 */
export async function detectShots(tools, path, opts) {
    const threshold = opts.threshold ?? DEFAULT_SCENE_THRESHOLD;
    const [fileHash, ver] = await Promise.all([
        opts.fileHash ? Promise.resolve(opts.fileHash) : hashFile(path),
        opts.ffmpegVersion ? Promise.resolve(opts.ffmpegVersion) : ffmpegVersion(tools),
    ]);
    if (opts.cacheDir && !opts.force) {
        const hit = await loadCachedShots(opts.cacheDir, fileHash, { fps: opts.fps, threshold, ffmpegVersion: ver });
        if (hit)
            return { ...hit, path, cached: true };
    }
    let timeoutMs = opts.timeoutMs;
    if (!timeoutMs) {
        const dur = await probeDurationSec(tools, path, opts.signal);
        // low-res decode runs well above realtime; allow 2× realtime + slack
        timeoutMs = Math.max(120_000, Math.ceil((dur ?? 600) * 2) * 1000);
    }
    const vf = `scale=${SCALE_WIDTH}:-2:flags=fast_bilinear,format=gbrp,scdet=threshold=${threshold}:sc_pass=0,metadata=mode=print:file=-`;
    const r = await run(tools.ffmpeg, ['-hide_banner', '-nostats', '-nostdin', '-v', 'error', '-threads', '0', '-an', '-sn', '-dn', '-i', path, '-map', '0:v:0', '-vf', vf, '-f', 'null', '-'], timeoutMs, opts.signal);
    if (r.exitCode !== 0)
        throw new Error(`shot detection failed on ${path}: ${r.stderr.trim().split(/\r?\n/).slice(-4).join('\n')}`);
    const recs = parseScdet(r.stdout);
    if (!recs.length)
        throw new Error(`shot detection: no video frames decoded from ${path}`);
    const idx = buildIndex(recs, opts.fps, { path, fileHash, threshold, ffmpegVersion: ver, createdAt: new Date().toISOString() });
    if (opts.cacheDir)
        await writeCache(opts.cacheDir, idx);
    return { ...idx, cached: false };
}
//# sourceMappingURL=shots.js.map