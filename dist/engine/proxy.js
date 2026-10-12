/**
 * Edit proxies for Premiere (DESIGN.md §14): small H.264 MP4s that Premiere can attach to the
 * originals (Proxy > Attach Proxies, or premiere_import_media). Same frame count, frame rate,
 * timecode and audio channels as the original; named `<original name>_Proxy.mp4` so where a proxy
 * comes from is always obvious. Never overwrites: an existing proxy is kept and reported.
 */
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { basename, dirname, extname, join, parse, relative, resolve } from 'node:path';
import { probeFrameCount } from './aerender.js';
const VIDEO = new Set(['.mp4', '.mov', '.mxf', '.mts', '.m2ts', '.avi', '.mkv']);
/** Originals under `sources` (files or folders) → `<proxyDir>/<folder>/<name>_Proxy.mp4`, keeping the folder layout. */
export async function planProxies(sources, proxyDir) {
    const out = [];
    const seen = new Set();
    const add = (file, root) => {
        const rel = relative(root, dirname(file));
        const target = join(resolve(proxyDir), basename(root), rel, `${basename(file, extname(file))}_Proxy.mp4`);
        const key = target.toLowerCase();
        if (seen.has(key))
            throw new Error(`two originals would get the same proxy name: ${target}`);
        seen.add(key);
        out.push({ source: file, proxy: target });
    };
    const walk = async (dir, root) => {
        for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = join(dir, e.name);
            if (e.isDirectory()) {
                if (resolve(full).toLowerCase() !== resolve(proxyDir).toLowerCase())
                    await walk(full, root);
            }
            else if (e.isFile() && VIDEO.has(extname(e.name).toLowerCase()) && !/_proxy$/i.test(basename(e.name, extname(e.name))))
                add(full, root);
        }
    };
    for (const s of sources.map((x) => resolve(x))) {
        const st = await stat(s).catch(() => undefined);
        if (!st)
            throw new Error(`not found: ${s}`);
        if (st.isDirectory())
            await walk(s, s);
        else
            add(s, dirname(s));
    }
    return out;
}
async function probeSource(tools, path, spawn) {
    const r = await spawn(tools.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,r_frame_rate,width,height:stream_tags=timecode:format=duration:format_tags=timecode', '-of', 'json', path], { reject: false, windowsHide: true, timeout: 60_000 });
    if (r.exitCode !== 0)
        throw new Error(`ffprobe failed on ${path}: ${String(r.stderr).slice(-300)}`);
    const j = JSON.parse(String(r.stdout));
    const v = j.streams?.find((s) => s.codec_type === 'video');
    if (!v?.r_frame_rate || !v.width || !v.height)
        throw new Error(`no video stream in ${path}`);
    const timecode = j.format?.tags?.timecode ?? j.streams?.map((s) => s.tags?.timecode).find((t) => !!t);
    return {
        fps: v.r_frame_rate, durationSec: Number(j.format?.duration ?? 0), width: v.width, height: v.height,
        audioStreams: j.streams?.filter((s) => s.codec_type === 'audio').length ?? 0, ...(timecode ? { timecode } : {}),
    };
}
/** ~3 Mbit/s at 540p plus audio: for the free-space check before starting. */
function estimateProxyBytes(durationSec, height = 540) {
    return Math.ceil(durationSec * ((3_000_000 * (height / 540) ** 2) + 256_000) / 8);
}
export async function makeProxies(tools, encoders, jobs, opts = {}) {
    const spawn = opts.spawn ?? execa;
    const height = opts.height ?? 540;
    const todo = jobs.filter((j) => !existsSync(j.proxy));
    // free space first: a full disk mid-run is the failure the user hit before
    if (todo.length) {
        let need = 0;
        for (const j of todo)
            need += estimateProxyBytes((await probeSource(tools, j.source, spawn)).durationSec, height);
        const root = parse(resolve(todo[0].proxy)).root;
        const free = await statfs(root).then((s) => Number(s.bavail) * Number(s.bsize), () => undefined);
        if (free !== undefined && free < need * 1.2 + 5 * 2 ** 30) {
            throw new Error(`not enough space on ${root} for the proxies: need about ${(need / 2 ** 30).toFixed(1)} GB + 5 GB spare, ${(free / 2 ** 30).toFixed(1)} GB free / พื้นที่ไม่พอสำหรับ proxy`);
        }
    }
    const rows = [];
    let bytes = 0;
    for (let i = 0; i < jobs.length; i++) {
        const j = jobs[i];
        opts.onProgress?.(i, jobs.length, j.source);
        if (opts.signal?.aborted)
            throw new Error('cancelled');
        if (existsSync(j.proxy)) {
            rows.push({ ...j, status: 'exists' });
            continue;
        }
        try {
            const info = await probeSource(tools, j.source, spawn);
            await mkdir(dirname(j.proxy), { recursive: true });
            const tmp = join(dirname(j.proxy), `.${basename(j.proxy, '.mp4')}.part.mp4`);
            await rm(tmp, { force: true });
            const audio = info.audioStreams > 0 ? ['-map', '0:a', '-c:a', 'aac', '-b:a', '192k'] : [];
            const tc = info.timecode ? ['-timecode', info.timecode, '-write_tmcd', '1'] : [];
            const run = async (gpu) => spawn(tools.ffmpeg, [
                '-hide_banner', '-nostdin', '-n', '-i', j.source,
                '-map', '0:v:0', ...audio,
                '-vf', `scale=-2:${height}:flags=bicubic,format=yuv420p`, '-fps_mode', 'passthrough',
                ...(gpu ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '26', '-b:v', '0'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23']),
                '-g', String(Math.max(1, Math.round(evalRate(info.fps)))),
                ...tc, '-map_metadata', '0', '-movflags', '+faststart', tmp,
            ], { reject: false, windowsHide: true, timeout: Math.max(600_000, info.durationSec * 20_000), ...(opts.signal ? { cancelSignal: opts.signal } : {}) });
            let r = await run(encoders.h264_nvenc);
            if (r.exitCode !== 0 && encoders.h264_nvenc) {
                await rm(tmp, { force: true });
                r = await run(false);
            }
            if (r.exitCode !== 0)
                throw new Error(String(r.stderr).slice(-500));
            // same frame count as the original, or Premiere drifts against the proxy
            const [a, b] = await Promise.all([probeFrameCount(tools, j.source, spawn, opts.signal), probeFrameCount(tools, tmp, spawn, opts.signal)]);
            if (a !== b) {
                await rm(tmp, { force: true });
                throw new Error(`frame count differs: original ${a}, proxy ${b}`);
            }
            if (existsSync(j.proxy)) {
                await rm(tmp, { force: true });
                rows.push({ ...j, status: 'exists' });
                continue;
            }
            await rename(tmp, j.proxy);
            const size = (await stat(j.proxy)).size;
            bytes += size;
            rows.push({ ...j, status: 'made', frames: b, bytes: size });
        }
        catch (e) {
            if (opts.signal?.aborted)
                throw e;
            rows.push({ ...j, status: 'failed', error: e instanceof Error ? e.message : String(e) });
        }
    }
    opts.onProgress?.(jobs.length, jobs.length, '');
    return { rows, bytes };
}
function evalRate(r) {
    const [n, d] = r.split('/').map(Number);
    return d ? (n ?? 0) / d : (n ?? 0);
}
//# sourceMappingURL=proxy.js.map