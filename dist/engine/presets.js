/**
 * Delivery targets. Loudness is what the deliverable is normalised to; the ProRes master
 * itself is mixed to `MASTER_PRESET_ID`'s loudness (EBU R128: -23 LUFS / -1 dBTP).
 */
export const PRESETS = {
    yt: {
        id: 'yt',
        label: 'YouTube / online H.264 1080p',
        container: 'mp4',
        video: { codec: 'h264', width: 1920, height: 1080, bitrateMbps: 20, useGpu: true },
        audio: { codec: 'aac', bitrateKbps: 320, sampleRate: 48000, channels: 2 },
        loudness: { integratedLufs: -14, truePeakDb: -1 },
    },
    fb: {
        id: 'fb',
        label: 'Facebook / Instagram feed H.264 1080p',
        container: 'mp4',
        video: { codec: 'h264', width: 1920, height: 1080, bitrateMbps: 16, useGpu: true },
        audio: { codec: 'aac', bitrateKbps: 256, sampleRate: 48000, channels: 2 },
        loudness: { integratedLufs: -16, truePeakDb: -1 },
    },
    vert: {
        id: 'vert',
        label: 'Vertical 9:16 (Reels / TikTok / Shorts) H.264',
        container: 'mp4',
        video: { codec: 'h264', width: 1080, height: 1920, bitrateMbps: 16, useGpu: true },
        audio: { codec: 'aac', bitrateKbps: 256, sampleRate: 48000, channels: 2 },
        loudness: { integratedLufs: -14, truePeakDb: -1 },
    },
    th_tv: {
        id: 'th_tv',
        label: 'Thai TV broadcast XDCAM HD422 50 Mbps 1080i50 MXF',
        container: 'mxf',
        video: { codec: 'xdcam_hd422', width: 1920, height: 1080, fps: 25, interlaced: true, bitrateMbps: 50, cbr: true },
        audio: { codec: 'pcm_s24le', sampleRate: 48000, channels: 2 },
        loudness: { integratedLufs: -24, truePeakDb: -2 },
    },
    th_prores: {
        id: 'th_prores',
        label: 'Thai TV ProRes 422 HQ 1080p25 MOV',
        container: 'mov',
        video: { codec: 'prores_422hq', width: 1920, height: 1080 },
        audio: { codec: 'pcm_s24le', sampleRate: 48000, channels: 2 },
        loudness: { integratedLufs: -24, truePeakDb: -2 },
    },
    led: {
        id: 'led',
        label: 'LED wall / event playback H.264 50 Mbps CBR MOV',
        container: 'mov',
        video: { codec: 'h264', width: 1920, height: 1080, bitrateMbps: 50, cbr: true, useGpu: true },
        audio: { codec: 'pcm_s16le', sampleRate: 48000, channels: 2 },
    },
    m422hq: {
        id: 'm422hq',
        label: 'Master ProRes 422 HQ (EBU R128 -23 LUFS)',
        container: 'mov',
        video: { codec: 'prores_422hq', width: 1920, height: 1080 },
        audio: { codec: 'pcm_s24le', sampleRate: 48000, channels: 2 },
        loudness: { integratedLufs: -23, truePeakDb: -1, lra: 7 },
        textless: true,
    },
};
/** The preset whose loudness the ProRes master is mixed to. */
export const MASTER_PRESET_ID = 'm422hq';
export function resolvePreset(id, overrides) {
    const base = PRESETS[id];
    if (!base)
        throw new Error(`unknown delivery preset '${id}' (known: ${Object.keys(PRESETS).join(', ')})`);
    if (!overrides)
        return structuredClone(base);
    const out = {
        ...structuredClone(base),
        ...overrides,
        id: base.id,
        video: { ...base.video, ...(overrides.video ?? {}) },
        audio: { ...base.audio, ...(overrides.audio ?? {}) },
    };
    if (overrides.loudness !== undefined) {
        out.loudness = base.loudness ? { ...base.loudness, ...overrides.loudness } : { ...overrides.loudness };
    }
    return out;
}
const CONTAINER_EXT = { mp4: 'mp4', mov: 'mov', mxf: 'mxf' };
/** Encoder arguments only; scaling / fps / interlace filters are the caller's job. */
export function presetToFfmpegArgs(preset, env, opts) {
    const v = preset.video;
    const fps = Math.round(opts.fps);
    const gop = String(Math.max(1, fps * 2));
    const mbps = v.bitrateMbps;
    const videoArgs = [];
    const rateArgs = (encoder) => {
        if (!mbps)
            return encoder === 'nvenc' ? ['-rc', 'vbr', '-cq', '19', '-b:v', '0'] : ['-crf', '18'];
        const kb = Math.round(mbps * 1000);
        if (v.cbr) {
            return [
                ...(encoder === 'nvenc' ? ['-rc', 'cbr'] : ['-nal-hrd', 'cbr']),
                '-b:v', `${kb}k`, '-minrate', `${kb}k`, '-maxrate', `${kb}k`, '-bufsize', `${kb * 2}k`,
            ];
        }
        return [
            ...(encoder === 'nvenc' ? ['-rc', 'vbr'] : []),
            '-b:v', `${kb}k`, '-maxrate', `${Math.round(kb * 1.5)}k`, '-bufsize', `${kb * 2}k`,
        ];
    };
    switch (v.codec) {
        case 'h264': {
            if (v.useGpu && env.encoders.h264_nvenc) {
                videoArgs.push('-c:v', 'h264_nvenc', '-preset', 'p6', '-tune', 'hq', '-profile:v', 'high', ...rateArgs('nvenc'));
            }
            else {
                videoArgs.push('-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', ...rateArgs('x26x'));
            }
            videoArgs.push('-pix_fmt', 'yuv420p', '-g', gop, '-bf', '2');
            break;
        }
        case 'hevc': {
            if (v.useGpu && env.encoders.hevc_nvenc) {
                videoArgs.push('-c:v', 'hevc_nvenc', '-preset', 'p6', '-tune', 'hq', ...rateArgs('nvenc'), '-tag:v', 'hvc1');
            }
            else {
                videoArgs.push('-c:v', 'libx265', '-preset', 'slow', ...rateArgs('x26x'), '-tag:v', 'hvc1');
            }
            videoArgs.push('-pix_fmt', 'yuv420p', '-g', gop);
            break;
        }
        case 'prores_422hq':
            videoArgs.push('-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le');
            break;
        case 'prores_4444':
            videoArgs.push('-c:v', 'prores_ks', '-profile:v', '4', '-vendor', 'apl0', '-pix_fmt', 'yuv444p10le');
            break;
        case 'dnxhr_hqx':
            videoArgs.push('-c:v', 'dnxhd', '-profile:v', 'dnxhr_hqx', '-pix_fmt', 'yuv422p10le');
            break;
        case 'xdcam_hd422': {
            const kb = Math.round((mbps ?? 50) * 1000);
            videoArgs.push('-c:v', 'mpeg2video', '-profile:v', '0', '-level:v', '2', '-pix_fmt', 'yuv422p', '-b:v', `${kb}k`, '-minrate', `${kb}k`, '-maxrate', `${kb}k`, '-bufsize', '17825792', '-rc_init_occupancy', '17825792', '-g', '12', '-bf', '2', '-dc', '10', '-intra_vlc', '1', '-non_linear_quant', '1', '-qmin', '1', '-qmax', '12', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
            if (v.interlaced)
                videoArgs.push('-flags', '+ildct+ilme', '-field_order', 'tt');
            if (preset.container === 'mxf')
                videoArgs.push('-f', 'mxf');
            break;
        }
        default: {
            const never = v.codec;
            throw new Error(`unsupported video codec ${String(never)}`);
        }
    }
    if (v.interlaced && v.codec !== 'xdcam_hd422')
        videoArgs.push('-flags', '+ildct+ilme', '-field_order', 'tt');
    if (preset.container === 'mp4')
        videoArgs.push('-movflags', '+faststart');
    const a = preset.audio;
    const audioArgs = ['-c:a', a.codec, '-ar', String(a.sampleRate), '-ac', String(a.channels)];
    if (a.codec === 'aac')
        audioArgs.push('-b:a', `${a.bitrateKbps ?? 256}k`);
    return { videoArgs, audioArgs, container: preset.container, ext: CONTAINER_EXT[preset.container] };
}
//# sourceMappingURL=presets.js.map