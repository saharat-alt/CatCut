/**
 * scan_footage (DESIGN.md §13.2 rows 6–7): inventory a footage folder without changing it.
 *
 * - ffprobe per media file: duration, fps, VFR (r_frame_rate ≠ avg_frame_rate), size, codec,
 *   field order, audio channels
 * - pillarbox / letterbox: cropdetect on a few frames sampled at 25/50/75 % (fast input seeking)
 * - mojibake names: UTF-8 Thai names that a zip tool decoded as cp437 (or cp1252/latin1) are mapped
 *   back to bytes and re-decoded; TIS-620 bytes are tried as well. User files are NEVER renamed:
 *   `applyAliases` creates correctly named hardlinks (copy as fallback) under <project>/media-aliases/.
 * - slot grouping by the leading digits of the (fixed) name, to help board matching
 */
import { execa } from 'execa';
import { constants, existsSync } from 'node:fs';
import { copyFile, link, mkdir, readdir, rename, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
const VIDEO_EXT = new Set(['.mov', '.mp4', '.m4v', '.mxf', '.avi', '.mkv', '.mts', '.m2ts', '.ts', '.webm', '.wmv', '.mpg', '.mpeg', '.3gp', '.dv', '.flv']);
const AUDIO_EXT = new Set(['.wav', '.mp3', '.aac', '.m4a', '.flac', '.ogg', '.opus', '.aif', '.aiff', '.wma', '.ac3']);
const STILL_EXT = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.gif', '.webp', '.psd', '.exr', '.dpx', '.tga', '.heic']);
const COMMON_FPS = [23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60, 100, 119.88, 120];
// ---------- mojibake ----------
/** cp437 0x80–0xFF. */
const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
/** cp1252 0x80–0x9F (undefined bytes map to the C1 control of the same value, as Windows does). */
const CP1252_80 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
const REV_CP437 = new Map([...CP437_HIGH].map((ch, i) => [ch, 0x80 + i]));
const REV_CP1252 = new Map();
for (let b = 0xa0; b <= 0xff; b++)
    REV_CP1252.set(String.fromCharCode(b), b);
[...CP1252_80].forEach((ch, i) => REV_CP1252.set(ch, 0x80 + i));
function encodeWith(s, rev) {
    const bytes = [];
    for (const ch of s) {
        const c = ch.codePointAt(0);
        if (c < 0x80) {
            bytes.push(c);
            continue;
        }
        const b = rev.get(ch);
        if (b === undefined)
            return undefined;
        bytes.push(b);
    }
    return Buffer.from(bytes);
}
const THAI = /[฀-๿]/u;
const utf8 = new TextDecoder('utf-8', { fatal: true });
function decodeUtf8(b) {
    try {
        return utf8.decode(b);
    }
    catch {
        return undefined;
    }
}
/** TIS-620 / cp874 Thai: 0xA1–0xFB → U+0E01–U+0E5B. */
function decodeTis620(b) {
    let out = '';
    for (const x of b) {
        if (x < 0x80)
            out += String.fromCharCode(x);
        else if (x >= 0xa1 && x <= 0xfb && !(x >= 0xdb && x <= 0xde))
            out += String.fromCharCode(0x0e00 + x - 0xa0);
        else
            return undefined;
    }
    return out;
}
/**
 * Proposed name when `name` looks like Thai (or other UTF-8) text misdecoded as cp437 / cp1252,
 * else undefined. Names that already contain Thai, or are plain ASCII, are left alone.
 */
export function fixMojibake(name) {
    if (THAI.test(name) || /^[\x00-\x7f]*$/.test(name))
        return undefined;
    for (const rev of [REV_CP437, REV_CP1252]) {
        const bytes = encodeWith(name, rev);
        if (!bytes)
            continue;
        const u = decodeUtf8(bytes);
        // a real UTF-8 round trip must produce something non-ASCII and different from the input
        if (u && u !== name && /[^\x00-\x7f]/.test(u) && !/[\u0080-\u009f�]/.test(u))
            return u.normalize('NFC');
        const t = decodeTis620(bytes);
        if (t && plausibleThai(t))
            return t;
    }
    return undefined;
}
const THAI_MARK = /[ัิ-ฺ็-๎]/u;
const THAI_BASE = /[ก-ะาำเ-ๆ]/u;
/** TIS-620 decodes any high byte to Thai, so demand ≥ 2 Thai letters and marks that sit on Thai letters ("Café" ≠ "Caf้"). */
function plausibleThai(s) {
    const chars = [...s];
    if (chars.filter((c) => THAI_BASE.test(c)).length < 2)
        return false;
    return chars.every((c, i) => !THAI_MARK.test(c) || (i > 0 && (THAI_BASE.test(chars[i - 1]) || THAI_MARK.test(chars[i - 1]))));
}
/** Slot id from a file/folder name: leading digits plus an optional single letter ("01_a.mov" → "01", "28r_x" → "28r"). */
export function slotOf(name) {
    const m = /^(\d{1,4})([a-z])?(?=$|[^a-z0-9])/i.exec(name) ?? /^(\d{1,4})([a-z])?/i.exec(name);
    return m ? `${m[1]}${(m[2] ?? '').toLowerCase()}` : undefined;
}
// ---------- probing ----------
async function run(file, args, timeoutMs, signal) {
    const r = await execa(file, args, { reject: false, windowsHide: true, stdin: 'ignore', timeout: timeoutMs, cancelSignal: signal, forceKillAfterDelay: 2000, maxBuffer: 16 * 2 ** 20 });
    if (r.isCanceled)
        throw new Error('scan cancelled');
    return { exitCode: r.timedOut ? -1 : (r.exitCode ?? -1), stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), timedOut: !!r.timedOut };
}
function rate(s) {
    if (typeof s !== 'string')
        return undefined;
    const [n, d] = s.split('/').map(Number);
    return n && d && Number.isFinite(n / d) ? n / d : undefined;
}
function num(v) {
    const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : undefined;
}
async function probeFile(tools, path, signal) {
    const r = await run(tools.ffprobe, [
        '-v', 'error',
        '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,field_order,pix_fmt,channels,duration,disposition:format=duration',
        '-of', 'json', path,
    ], 60_000, signal);
    if (r.exitCode !== 0)
        return undefined;
    let j;
    try {
        j = JSON.parse(r.stdout);
    }
    catch {
        return undefined;
    }
    const streams = j.streams ?? [];
    const v = streams.find((s) => s['codec_type'] === 'video' && !(s['disposition']?.['attached_pic']));
    const a = streams.find((s) => s['codec_type'] === 'audio');
    const p = {};
    p.durationSec = num(j.format?.['duration']) ?? num(v?.['duration']) ?? num(a?.['duration']);
    if (v) {
        p.videoCodec = typeof v['codec_name'] === 'string' ? v['codec_name'] : undefined;
        p.width = num(v['width']);
        p.height = num(v['height']);
        p.pixFmt = typeof v['pix_fmt'] === 'string' ? v['pix_fmt'] : undefined;
        p.fieldOrder = typeof v['field_order'] === 'string' ? v['field_order'] : undefined;
        p.rFrameRate = typeof v['r_frame_rate'] === 'string' ? v['r_frame_rate'] : undefined;
        p.avgFrameRate = typeof v['avg_frame_rate'] === 'string' ? v['avg_frame_rate'] : undefined;
        const r1 = rate(p.rFrameRate);
        const r2 = rate(p.avgFrameRate);
        p.fps = r2 ?? r1;
        if (r1 !== undefined && r2 !== undefined)
            p.vfr = Math.abs(r1 - r2) / r1 > 0.001;
    }
    if (a) {
        p.audioCodec = typeof a['codec_name'] === 'string' ? a['codec_name'] : undefined;
        p.audioChannels = num(a['channels']);
    }
    return p;
}
/**
 * Union of cropdetect boxes over frames sampled at 25/50/75 % (a dark scene alone can look letterboxed).
 * Each sample is a fast `-ss` seek + a handful of decoded frames.
 */
async function detectActiveArea(tools, path, p, signal) {
    if (!p.width || !p.height)
        return undefined;
    const dur = p.durationSec ?? 0;
    const points = dur > 1 ? [0.25, 0.5, 0.75].map((x) => x * dur) : [0];
    let box;
    for (const t of points) {
        const r = await run(tools.ffmpeg, [
            '-hide_banner', '-nostats', '-nostdin', '-v', 'info', '-ss', t.toFixed(3), '-an', '-sn', '-i', path,
            '-map', '0:v:0', '-frames:v', '6', '-vf', 'format=yuv420p,cropdetect=limit=0.1:round=2:reset=0', '-f', 'null', '-',
        ], 60_000, signal);
        const all = [...r.stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
        const m = all[all.length - 1];
        if (!m)
            continue;
        const [w, h, x, y] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
        if (w <= 0 || h <= 0 || w > p.width || h > p.height)
            continue; // all-black sample
        box = box
            ? { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x + w), y1: Math.max(box.y1, y + h) }
            : { x0: x, y0: y, x1: x + w, y1: y + h };
    }
    if (!box)
        return undefined;
    const w = box.x1 - box.x0;
    const h = box.y1 - box.y0;
    return {
        x: box.x0, y: box.y0, w, h,
        pillarbox: w < p.width * 0.97 && box.x0 > 0 && p.width - box.x1 > 0,
        letterbox: h < p.height * 0.97 && box.y0 > 0 && p.height - box.y1 > 0,
    };
}
// ---------- scan ----------
async function listFiles(dir, recursive) {
    const out = [];
    const walk = async (d) => {
        const entries = await readdir(d, { withFileTypes: true });
        for (const e of entries) {
            const full = join(d, e.name);
            if (e.isDirectory()) {
                if (recursive && !e.name.startsWith('.'))
                    await walk(full);
                continue;
            }
            if (e.isFile())
                out.push(full);
        }
    };
    await walk(dir);
    return out.sort();
}
function kindOf(path) {
    const ext = extname(path).toLowerCase();
    if (VIDEO_EXT.has(ext))
        return 'video';
    if (AUDIO_EXT.has(ext))
        return 'audio';
    if (STILL_EXT.has(ext))
        return 'still';
    return undefined;
}
function fixRel(rel) {
    const parts = rel.split(/[\\/]/);
    let changed = false;
    const fixed = parts.map((seg) => {
        const f = fixMojibake(seg);
        if (f && f !== seg) {
            changed = true;
            return f;
        }
        return seg;
    });
    return changed ? fixed.join(sep) : undefined;
}
async function pool(items, n, fn) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            await fn(items[i], i);
        }
    }));
}
export async function scanFootage(tools, dir, opts = {}) {
    const st = await stat(dir);
    if (!st.isDirectory())
        throw new Error(`not a folder: ${dir}`);
    const recursive = opts.recursive ?? false;
    const paths = (await listFiles(dir, recursive)).filter((p) => kindOf(p));
    const files = new Array(paths.length);
    let done = 0;
    await pool(paths, Math.max(1, opts.concurrency ?? 4), async (path, i) => {
        const rel = relative(dir, path);
        const kind = kindOf(path);
        const f = { path, rel, name: basename(path), kind, size: (await stat(path)).size, flags: [], notes: [] };
        const fixedRel = fixRel(rel);
        if (fixedRel) {
            f.fixedRel = fixedRel;
            f.flags.push('mojibake');
        }
        const name = basename(fixedRel ?? rel);
        f.slot = slotOf(name) ?? slotOf(basename(dirname(fixedRel ?? rel)));
        if (f.slot === undefined)
            delete f.slot;
        if (kind !== 'audio') {
            const p = await probeFile(tools, path, opts.signal);
            if (!p)
                f.flags.push('probe-failed');
            else {
                f.probe = p;
                if (!p.width)
                    f.flags.push('no-video');
                if (kind === 'video' && p.width && p.height) {
                    if (p.vfr)
                        f.flags.push('vfr');
                    if (p.fieldOrder && !/^(progressive|unknown)$/.test(p.fieldOrder))
                        f.flags.push('interlaced');
                    if (Math.min(p.width, p.height) < 720)
                        f.flags.push('low-res');
                    if (p.fps && !COMMON_FPS.some((c) => Math.abs(c - p.fps) < 0.02))
                        f.flags.push('odd-fps');
                    if (p.fps && opts.projectFps && !conforms(p.fps, opts.projectFps)) {
                        f.flags.push('fps-mismatch');
                        f.notes.push(`fps ${p.fps.toFixed(3)} ≠ โปรเจกต์ ${opts.projectFps} (จะถูก conform/ข้ามเฟรม)`);
                    }
                    if (opts.crop !== false) {
                        const area = await detectActiveArea(tools, path, p, opts.signal);
                        if (area) {
                            f.activeArea = area;
                            if (area.pillarbox)
                                f.flags.push('pillarbox');
                            if (area.letterbox)
                                f.flags.push('letterbox');
                            if (area.pillarbox || area.letterbox)
                                f.notes.push(`ภาพจริง ${area.w}x${area.h} ที่ (${area.x},${area.y}) ใน ${p.width}x${p.height} — ต้อง cover-crop/scale`);
                        }
                    }
                }
            }
        }
        else {
            const p = await probeFile(tools, path, opts.signal);
            if (p)
                f.probe = p;
            else
                f.flags.push('probe-failed');
        }
        files[i] = f;
        opts.onFile?.(++done, paths.length, rel);
    });
    const slots = {};
    const unslotted = [];
    const summary = { files: files.length };
    for (const f of files) {
        if (f.slot)
            (slots[f.slot] ??= []).push(f.fixedRel ?? f.rel);
        else
            unslotted.push(f.fixedRel ?? f.rel);
        for (const fl of f.flags)
            summary[fl] = (summary[fl] ?? 0) + 1;
    }
    return {
        dir, recursive, files,
        renamePlan: files.filter((f) => f.fixedRel).map((f) => ({ from: f.rel, to: f.fixedRel })),
        slots, unslotted, summary,
    };
}
/** Project fps conforms when the source is the same rate or an integer multiple (50 → 25). */
function conforms(src, project) {
    const ratio = src / project;
    return Math.abs(ratio - Math.round(ratio)) < 0.002 && Math.round(ratio) >= 1;
}
/**
 * Correctly named hardlinks (copy when the volume differs) for every mojibake file, inside
 * `aliasDir` only. Never touches the user's files and never overwrites: an existing alias is skipped.
 * `aliases.json` maps alias path → original path (merged with what is already there).
 */
export async function applyAliases(report, aliasDir) {
    await mkdir(aliasDir, { recursive: true });
    const res = { aliasDir, created: [], skipped: [], index: join(aliasDir, 'aliases.json') };
    for (const f of report.files) {
        if (!f.fixedRel)
            continue;
        const alias = join(aliasDir, f.fixedRel);
        if (existsSync(alias)) {
            res.skipped.push({ source: f.path, alias, reason: 'exists' });
            continue;
        }
        await mkdir(dirname(alias), { recursive: true });
        try {
            await link(f.path, alias);
            res.created.push({ source: f.path, alias, method: 'hardlink' });
        }
        catch (e) {
            const code = e.code;
            if (code === 'EEXIST') {
                res.skipped.push({ source: f.path, alias, reason: 'exists' });
                continue;
            }
            try {
                await copyFile(f.path, alias, constants.COPYFILE_EXCL);
                res.created.push({ source: f.path, alias, method: 'copy' });
            }
            catch (e2) {
                res.skipped.push({ source: f.path, alias, reason: e2 instanceof Error ? e2.message : String(e2) });
            }
        }
    }
    let index = {};
    if (existsSync(res.index)) {
        try {
            index = JSON.parse(await readFile(res.index, 'utf8'));
        }
        catch { /* rebuilt below */ }
    }
    for (const c of res.created)
        index[c.alias] = c.source;
    const tmp = `${res.index}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(index, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(tmp, res.index);
    return res;
}
//# sourceMappingURL=scan.js.map