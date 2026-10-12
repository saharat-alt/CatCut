/**
 * Media-analysis tools (DESIGN.md §13.2 rows 2, 3, 7): shot index, timeline lint/snap, footage scan.
 * Long work runs as jobs; a call waits up to ~20 s and otherwise returns the job id.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { hashFile } from '../core/hash.js';
import { isProtected } from '../core/project.js';
import { framesToTc, splitDissolve } from '../core/timecode.js';
import { applyAliases, scanFootage } from '../engine/scan.js';
import { DEFAULT_SCENE_THRESHOLD, detectShots, ffmpegVersion, loadCachedShots } from '../engine/shots.js';
import { lintTimeline, snapToShots } from '../engine/timeline-lint.js';
import { requireFfmpeg, requireProject } from './state.js';
import { tool, ToolError } from './tooldef.js';
const WAIT_MS = 20_000;
const DEFAULT_SNAP_K = 5; // fixes leaks of up to 5 frames = every flash under the default 6-frame lint
// ---------- helpers ----------
async function runJob(state, name, wait, fn) {
    const job = state.jobs.start(name, fn);
    const pending = () => ({ ok: true, jobId: job.id, status: state.jobs.get(job.id)?.status ?? job.status, pending: true, hint: 'ยังทำงานอยู่ — รอผลด้วย job_wait {id} / still running: call job_wait {id}' });
    if (wait === false)
        return pending();
    let timer;
    const info = await Promise.race([
        state.jobs.wait(job.id),
        new Promise((r) => { timer = setTimeout(() => r(undefined), WAIT_MS); }),
    ]);
    clearTimeout(timer);
    if (!info)
        return pending();
    if (info.status === 'done')
        return { ...info.result, jobId: job.id };
    throw new ToolError(info.error ?? `${name} ${info.status}`, { jobId: job.id, status: info.status });
}
/** Decodable picture file of an asset: camera/graphic files, or the last AE render. */
function mediaPath(a) {
    if (a.kind === 'aecomp')
        return a.render?.path && existsSync(a.render.path) ? a.render.path : undefined;
    if (a.kind === 'still' || a.kind === 'audio')
        return undefined;
    return a.path;
}
function shotsDir(p) {
    return join(p.dir, 'cache', 'shots');
}
/** Default analysis set: assets used by the video track (falls back to every video asset). */
function defaultAssetIds(p) {
    const used = [...new Set(p.timeline.video.map((c) => c.src))].filter((id) => p.assets[id] && mediaPath(p.assets[id]));
    return used.length ? used : Object.values(p.assets).filter((a) => mediaPath(a)).map((a) => a.id);
}
async function contentHash(a, path) {
    return a.kind !== 'aecomp' && a.hash ? a.hash : hashFile(path);
}
async function ffVer(state) {
    return state.env.ffmpegVersion ?? ffmpegVersion(state.env.tools);
}
/** Cached shot indexes for the given assets; never decodes. */
async function cachedShots(state, p, ids, threshold) {
    const map = new Map();
    const missing = [];
    const ver = await ffVer(state);
    for (const id of ids) {
        const a = p.assets[id];
        const path = a && mediaPath(a);
        if (!a || !path || !existsSync(path))
            continue;
        const idx = await loadCachedShots(shotsDir(p), await contentHash(a, path), { fps: p.meta.fps, threshold, ffmpegVersion: ver });
        if (idx)
            map.set(id, idx);
        else
            missing.push(id);
    }
    return { map, missing };
}
function withTc(issues, fps) {
    return issues.map((i) => ({ ...i, tc: i.tc ?? (i.startFrame !== undefined ? framesToTc(i.startFrame, fps) : undefined) }));
}
function countBy(issues) {
    const out = {};
    for (const i of issues)
        out[i.kind] = (out[i.kind] ?? 0) + 1;
    return out;
}
/** history/timeline-<ISO-safe>-<n>.json (same format timeline_restore lists); exclusive create, never overwrites. */
async function backupTimeline(p, reason) {
    const dir = join(p.dir, 'history');
    await mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    const stamp = now.replace(/[:.]/g, '-');
    const body = `${JSON.stringify({ savedAt: now, reason, timeline: p.timeline }, null, 2)}\n`;
    for (let n = 1;; n++) {
        const file = join(dir, `timeline-${stamp}-${n}.json`);
        try {
            await writeFile(file, body, { encoding: 'utf8', flag: 'wx' });
            return file;
        }
        catch (e) {
            if (e.code !== 'EEXIST')
                throw e;
        }
    }
}
const thresholdArg = z.number().positive().max(100).optional().describe(`scdet scene threshold 0–100 (default ${DEFAULT_SCENE_THRESHOLD})`);
// ---------- tools ----------
export const MEDIA_TOOLS = [
    tool({
        name: 'shots_detect',
        description: 'หาจุดเปลี่ยนช็อตในไฟล์ต้นทาง (scdet, cache ตาม hash ไฟล์) + ค่าการเคลื่อนไหวต่อช็อต (job) · Detect source shot changes + per-shot motion for assets (cached by file hash)',
        input: {
            assetIds: z.array(z.string()).optional().describe('default: assets used on the video track'),
            threshold: thresholdArg,
            force: z.boolean().optional().describe('ignore the cache'),
            wait: z.boolean().optional().describe('default true: wait up to ~20 s for the result'),
        },
        writesProject: true,
        handler: async (a, state) => {
            const p = requireProject(state);
            requireFfmpeg(state);
            const ids = a.assetIds ?? defaultAssetIds(p);
            const unknown = ids.filter((id) => !p.assets[id]);
            if (unknown.length)
                throw new ToolError(`ไม่รู้จัก asset / unknown assets: ${unknown.join(', ')}`, { unknown });
            const threshold = a.threshold ?? DEFAULT_SCENE_THRESHOLD;
            const fps = p.meta.fps;
            return runJob(state, 'shots_detect', a.wait, async (ctx) => {
                const ver = await ffVer(state);
                const results = [];
                const skipped = [];
                let done = 0;
                for (const id of ids) {
                    ctx.progress({ stage: 'shots', done, total: ids.length, message: id });
                    const asset = p.assets[id];
                    const path = mediaPath(asset);
                    if (!path || !existsSync(path)) {
                        skipped.push({ assetId: id, reason: asset.kind === 'aecomp' ? 'ยังไม่มี render / no render yet' : asset.kind === 'still' || asset.kind === 'audio' ? 'ไม่ใช่วิดีโอ / not video' : 'ไม่พบไฟล์ / file missing' });
                        done++;
                        continue;
                    }
                    const idx = await detectShots(state.env.tools, path, {
                        fps, threshold, cacheDir: shotsDir(p), fileHash: await contentHash(asset, path), ffmpegVersion: ver, force: a.force, signal: ctx.signal,
                    });
                    ctx.log(`${id}: ${idx.cuts.length} cut(s), ${idx.frames} frames${idx.cached ? ' (cache)' : ''}`);
                    results.push({
                        assetId: id, frames: idx.frames, cached: idx.cached, cuts: idx.cuts.length,
                        cutsTc: idx.cuts.slice(0, 200).map((c) => ({ frame: c, tc: framesToTc(c, fps) })),
                        shots: idx.shots.slice(0, 200).map((s) => ({ start: s.start, end: s.end, motion: s.motion })),
                    });
                    ctx.progress({ stage: 'shots', done: ++done, total: ids.length, message: id });
                }
                return { ok: true, threshold, assets: results, skipped, hint: 'ต่อด้วย timeline_lint / next: timeline_lint' };
            });
        },
    }),
    tool({
        name: 'timeline_lint',
        description: 'ตรวจไทม์ไลน์กับ shot index: ข้ามรอยตัดต้นทาง (cutcross), เฟรมแวบ (flash), ใช้ต้นทางซ้ำ (repeat), ภาพนิ่งนาน (lowmotion, คำแนะนำ), สโลว์ฟุต fps ต่ำโดยไม่มี Optical Flow (slowmo) · Lint the timeline against cached source shot indexes',
        input: {
            flashFrames: z.number().int().min(1).optional().describe('visible shot piece shorter than this = flash (default 6)'),
            nearClips: z.number().int().min(1).optional().describe('repeat check window in clips (default 3)'),
            maxStaticSec: z.number().positive().optional().describe('default styleRules.maxStaticSec or 4'),
            staticMotion: z.number().min(0).optional().describe('motion (mafd) below this counts as static (default 0.5)'),
            checks: z.array(z.enum(['cutcross', 'flash', 'repeat', 'lowmotion', 'slowmo'])).optional(),
            threshold: thresholdArg,
        },
        handler: async (a, state) => {
            const p = requireProject(state);
            const { map, missing } = await cachedShots(state, p, defaultAssetIds(p), a.threshold ?? DEFAULT_SCENE_THRESHOLD);
            const issues = lintTimeline(p, map, { flashFrames: a.flashFrames, nearClips: a.nearClips, maxStaticSec: a.maxStaticSec, staticMotion: a.staticMotion, checks: a.checks });
            return {
                ok: true,
                issues: withTc(issues, p.meta.fps),
                counts: countBy(issues),
                analysedAssets: [...map.keys()],
                missingShots: missing,
                ...(missing.length ? { hint: `ยังไม่มี shot index ของ ${missing.join(', ')} — เรียก shots_detect ก่อน (repeat ตรวจได้แม้ไม่มี) / run shots_detect for these assets` } : {}),
                note: 'ทุกข้อเป็นคำเตือน — บรีฟ/ผู้ใช้เป็นผู้ตัดสิน / advisory: the brief decides',
            };
        },
    }),
    tool({
        name: 'timeline_snap',
        description: 'เสนอปรับ in/dur ให้หัว/ท้ายคลิปตรงรอยตัดต้นทาง (แก้เฟรมแวบ) คงความยาวไทม์ไลน์; ค่าเริ่มต้น dry run, apply: true เพื่อใช้ (สำรองไว้ใน history/) · Snap clip heads/tails to source shot boundaries',
        input: {
            clipIds: z.array(z.string()).optional().describe('default: every clip'),
            k: z.number().int().min(1).optional().describe(`snap when a source boundary is within k timeline frames inside the clip (default ${DEFAULT_SNAP_K})`),
            allowDurChange: z.boolean().optional().describe('allow shortening a clip when sliding cannot keep its duration (changes total length)'),
            apply: z.boolean().optional().describe('default false: only propose'),
            threshold: thresholdArg,
        },
        mutating: true,
        writesProject: true,
        handler: async (a, state) => {
            const p = requireProject(state);
            const k = a.k ?? DEFAULT_SNAP_K;
            const video = p.timeline.video;
            const wanted = a.clipIds ? new Set(a.clipIds) : undefined;
            if (wanted) {
                const unknown = [...wanted].filter((id) => !video.some((c) => c.id === id));
                if (unknown.length)
                    throw new ToolError(`ไม่พบคลิป / unknown clips: ${unknown.join(', ')}`, { unknown });
            }
            const { map, missing } = await cachedShots(state, p, [...new Set(video.map((c) => c.src))], a.threshold ?? DEFAULT_SCENE_THRESHOLD);
            const cutAfter = new Map(p.timeline.cuts.map((c) => [c.after, c.dissolve]));
            const proposals = video.flatMap((clip, i) => {
                if (wanted && !wanted.has(clip.id))
                    return [];
                const sd = map.get(clip.src);
                if (!sd)
                    return [];
                const prev = video[i - 1];
                return [snapToShots(clip, sd, k, {
                        headHandle: prev ? splitDissolve(cutAfter.get(prev.id) ?? 0).a : 0,
                        tailHandle: i < video.length - 1 ? splitDissolve(cutAfter.get(clip.id) ?? 0).b : 0,
                        allowDurChange: a.allowDurChange,
                    })];
            });
            const changes = proposals.filter((x) => x.changed);
            const warnings = proposals.filter((x) => x.warnings.length).map((x) => ({ clipId: x.clipId, warnings: x.warnings }));
            const base = { k, changes, warnings, missingShots: missing, ...(missing.length ? { hint: `เรียก shots_detect ก่อนสำหรับ ${missing.join(', ')} / run shots_detect first` } : {}) };
            if (!a.apply || !changes.length) {
                return { ok: true, applied: false, ...base, ...(changes.length ? { next: 'ตรวจแล้วเรียกซ้ำด้วย apply: true / call again with apply: true' } : {}) };
            }
            const backup = await backupTimeline(p, `before timeline_snap k=${k}`);
            const prevTimeline = p.timeline;
            const next = structuredClone(prevTimeline);
            for (const ch of changes) {
                const c = next.video.find((x) => x.id === ch.clipId);
                c.in = ch.in;
                c.dur = ch.dur;
            }
            state.api.project.setTimeline(p, next);
            const errors = state.api.project.validateTimeline(p);
            if (errors.length) {
                state.api.project.setTimeline(p, prevTimeline);
                throw new ToolError('ไทม์ไลน์หลัง snap ไม่ผ่านการตรวจสอบ ไม่ได้บันทึก / snapped timeline invalid, not applied', { errors, backup });
            }
            await state.api.project.saveProject(p);
            return { ok: true, applied: true, backup, ...base, hint: 'ย้อนกลับได้ด้วย timeline_restore / undo with timeline_restore' };
        },
    }),
    tool({
        name: 'proxy_make',
        description: 'ทำ proxy MP4 H.264 เล็ก ๆ ให้ Premiere แนบกับไฟล์ต้นฉบับ: ชื่อ `<ชื่อเดิม>_Proxy.mp4` เรียงโฟลเดอร์เหมือนต้นฉบับ, เฟรม/fps/timecode/ช่องเสียงเท่าต้นฉบับ, เช็กพื้นที่ก่อน, ไม่เขียนทับ (ทำต่อจากเดิมได้) · Edit proxies for Premiere; then premiere_import_media attaches them',
        input: {
            sources: z.array(z.string()).min(1).describe('original files or folders (e.g. the CARD folders)'),
            proxyDir: z.string().describe('where the proxies go (a fast drive with space; not inside a card folder)'),
            height: z.union([z.literal(540), z.literal(720), z.literal(1080)]).optional().describe('proxy height (default 540)'),
            wait: z.boolean().optional().describe('wait up to ~20 s for the result (default true; long runs return a job id: job_wait)'),
        },
        handler: async (a, state) => {
            requireFfmpeg(state);
            const { makeProxies, planProxies } = await import('../engine/proxy.js');
            const plan = await planProxies(a.sources, a.proxyDir);
            if (!plan.length)
                throw new ToolError('ไม่พบไฟล์วิดีโอในที่ระบุ / no video files found');
            return runJob(state, 'proxy_make', a.wait, async (ctx) => {
                const r = await makeProxies(state.env.tools, state.env.encoders, plan, {
                    ...(a.height ? { height: a.height } : {}), signal: ctx.signal,
                    onProgress: (done, total, file) => { ctx.progress({ stage: 'proxy', done, total, ...(file ? { message: file } : {}) }); },
                });
                const failed = r.rows.filter((x) => x.status === 'failed');
                return {
                    ok: failed.length === 0, proxyDir: resolve(a.proxyDir), files: r.rows.length,
                    made: r.rows.filter((x) => x.status === 'made').length, existed: r.rows.filter((x) => x.status === 'exists').length,
                    failed, addedGb: Math.round((r.bytes / 2 ** 30) * 100) / 100,
                    next: 'premiere_import_media {project, sources (the same originals), proxyDir} imports the originals and attaches these proxies',
                };
            });
        },
    }),
    tool({
        name: 'scan_footage',
        description: 'สำรวจโฟลเดอร์ฟุตเทจ (ไม่แก้ไฟล์ผู้ใช้): ความยาว/fps/VFR/codec/ช่องเสียง, pillarbox/letterbox, ชื่อไฟล์ไทยเพี้ยน (mojibake) + ชื่อที่ถูก, จัดกลุ่มตามเลข slot; apply: true สร้าง hardlink ชื่อถูกใน <project>/media-aliases/ · Inventory a footage folder',
        input: {
            dir: z.string().min(1).describe('folder to scan (absolute)'),
            recursive: z.boolean().optional(),
            crop: z.boolean().optional().describe('default true: cropdetect for pillarbox/letterbox'),
            apply: z.boolean().optional().describe('create correctly named hardlinks/copies for mojibake files inside <project>/media-aliases/ (needs an open project; user files are never renamed)'),
            wait: z.boolean().optional().describe('default true: wait up to ~20 s for the result'),
        },
        writesProject: true,
        handler: async (a, state) => {
            requireFfmpeg(state);
            const dir = resolve(a.dir);
            if (!existsSync(dir))
                throw new ToolError(`ไม่พบโฟลเดอร์ / folder not found: ${dir}`);
            const p = a.apply ? requireProject(state) : state.project;
            const aliasDir = p ? join(p.dir, 'media-aliases') : undefined;
            if (a.apply && aliasDir && isProtected(aliasDir))
                throw new ToolError('ห้ามเขียนในโฟลเดอร์ที่ป้องกันไว้ / protected path', { path: aliasDir });
            return runJob(state, 'scan_footage', a.wait, async (ctx) => {
                const report = await scanFootage(state.env.tools, dir, {
                    recursive: a.recursive, crop: a.crop, projectFps: p?.meta.fps, signal: ctx.signal,
                    onFile: (done, total, rel) => { ctx.progress({ stage: 'scan', done, total, message: rel }); },
                });
                const aliases = a.apply && aliasDir && report.renamePlan.length ? await applyAliases(report, aliasDir) : undefined;
                return {
                    ok: true, ...report, ...(aliases ? { aliases } : {}),
                    hint: report.renamePlan.length && !a.apply
                        ? 'พบชื่อไฟล์เพี้ยน — renamePlan เป็นแค่แผน (ไม่เปลี่ยนชื่อไฟล์ผู้ใช้); apply: true เพื่อสร้าง hardlink ชื่อถูกใน media-aliases/ / mojibake found: apply: true creates aliases'
                        : undefined,
                };
            });
        },
    }),
];
//# sourceMappingURL=tools-media.js.map