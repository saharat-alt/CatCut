import { execa } from 'execa';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
const WINGET_FFMPEG_GLOB = join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
function firstExisting(cands) {
    return cands.find((p) => p && existsSync(p));
}
/** Find ffmpeg/ffprobe: env EDITMCP_FFMPEG, PATH, then the winget install folder. */
export function findFfmpeg() {
    const envDir = process.env['EDITMCP_FFMPEG'];
    const cands = [];
    if (envDir)
        cands.push(join(envDir, 'ffmpeg.exe'), envDir);
    for (const dir of (process.env['PATH'] ?? '').split(';')) {
        if (dir)
            cands.push(join(dir, 'ffmpeg.exe'));
    }
    try {
        for (const pkg of readdirSync(WINGET_FFMPEG_GLOB)) {
            if (!/ffmpeg/i.test(pkg))
                continue;
            const pkgDir = join(WINGET_FFMPEG_GLOB, pkg);
            for (const sub of readdirSync(pkgDir)) {
                cands.push(join(pkgDir, sub, 'bin', 'ffmpeg.exe'));
            }
        }
    }
    catch { /* winget folder absent */ }
    const ffmpeg = firstExisting(cands);
    if (!ffmpeg)
        return undefined;
    const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
    return existsSync(ffprobe) ? { ffmpeg, ffprobe } : undefined;
}
/** Newest "Adobe After Effects 20xx" under Program Files (or EDITMCP_AE_DIR). */
export function findAfterEffects() {
    const envDir = process.env['EDITMCP_AE_DIR'];
    const roots = [envDir, 'C:\\Program Files\\Adobe'].filter(Boolean);
    const dirs = [];
    for (const root of roots) {
        try {
            if (envDir && root === envDir) {
                dirs.push(root);
                continue;
            }
            for (const d of readdirSync(root))
                if (/^Adobe After Effects \d{4}$/i.test(d))
                    dirs.push(join(root, d));
        }
        catch { /* no Adobe */ }
    }
    dirs.sort().reverse();
    for (const dir of dirs) {
        const sf = join(dir, 'Support Files');
        const com = join(sf, 'AfterFX.com');
        const exe = join(sf, 'AfterFX.exe');
        const aerender = join(sf, 'aerender.exe');
        const afterfx = firstExisting([com, exe]);
        if (afterfx)
            return { afterfx, aerender: existsSync(aerender) ? aerender : undefined, aeVersionDir: dir };
    }
    return {};
}
export function findPremiere() {
    const out = {};
    try {
        const root = 'C:\\Program Files\\Adobe';
        const dirs = readdirSync(root).sort().reverse();
        const pr = dirs.find((d) => /^Adobe Premiere Pro \d{4}$/i.test(d));
        const ame = dirs.find((d) => /^Adobe Media Encoder \d{4}$/i.test(d));
        if (pr)
            out.premiereExe = firstExisting([join(root, pr, 'Adobe Premiere Pro.exe')]);
        if (ame)
            out.mediaEncoderExe = firstExisting([join(root, ame, 'Adobe Media Encoder.exe')]);
    }
    catch { /* none */ }
    return out;
}
export function discoverTools() {
    const ff = findFfmpeg();
    if (!ff)
        throw new Error('ffmpeg/ffprobe not found. Install via winget (Gyan.FFmpeg) or set EDITMCP_FFMPEG to its bin folder.');
    return { ...ff, ...findAfterEffects(), ...findPremiere() };
}
export async function probeEncoders(ffmpeg) {
    const { stdout } = await execa(ffmpeg, ['-hide_banner', '-encoders'], { reject: false, windowsHide: true, timeout: 30_000 });
    const has = (name) => new RegExp(`^\\s*[A-Z.]{6}\\s+${name}\\s`, 'm').test(stdout);
    let version;
    try {
        const v = await execa(ffmpeg, ['-version'], { reject: false, windowsHide: true, timeout: 30_000 });
        version = v.stdout.split(/\r?\n/)[0]?.replace(/^ffmpeg version\s+/, '');
    }
    catch { /* ignore */ }
    return {
        h264_nvenc: has('h264_nvenc'),
        h264_qsv: has('h264_qsv'),
        hevc_nvenc: has('hevc_nvenc'),
        libx264: has('libx264'),
        prores_ks: has('prores_ks'),
        dnxhd: has('dnxhd'),
        mpeg2video: has('mpeg2video'),
        version,
    };
}
export async function getEnvironment() {
    const tools = discoverTools();
    const enc = await probeEncoders(tools.ffmpeg);
    const { version, ...encoders } = enc;
    return {
        tools,
        encoders,
        ffmpegVersion: version,
        totalRamGb: os.totalmem() / 2 ** 30,
        freeRamGb: os.freemem() / 2 ** 30,
        cpuThreads: os.cpus().length,
    };
}
//# sourceMappingURL=tools.js.map