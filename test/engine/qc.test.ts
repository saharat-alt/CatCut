import { beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverTools } from '../../src/core/tools.js';
import { measureLoudness, runQc } from '../../src/engine/qc.js';
import type { QcArgs } from '../../src/engine/qc.js';
import type { ToolPaths } from '../../src/core/types.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Thai folder name on purpose: paths must survive as plain argv (never inside filter strings).
const MEDIA = join(ROOT, 'tmp', 'test-media', 'qc', 'ทดสอบ');
const FPS = 25;
const W = 640;
const H = 360;

/**
 * 100 frames @ 25 fps, 640x360, ProRes 422 HQ + 1 kHz sine (pcm_s24le):
 *   f0–24   motion
 *   f25–49  black (1 s)
 *   f50–59  motion
 *   f60–84  frozen (one testsrc2 frame looped, 1 s)
 *   f85–99  motion
 *   audio   silent from 2.0 s to 3.5 s (f50–87)
 */
const SYNTH = join(MEDIA, 'synth.mov');
/** 50 frames: motion f0–19 then frozen until EOF; audio silent from 0.5 s until EOF. */
const EOF_CLIP = join(MEDIA, 'eof.mov');
/** 50 frames mpeg2video in mpegts, no audio: forces the -count_frames path. */
const NOAUDIO_TS = join(MEDIA, 'noaudio.ts');

let tools: ToolPaths;

async function ff(args: string[]): Promise<void> {
  const r = await execa(tools.ffmpeg, ['-hide_banner', '-nostats', '-nostdin', '-y', ...args], { reject: false, windowsHide: true });
  if (r.exitCode !== 0) throw new Error(`ffmpeg synth failed: ${r.stderr.split(/\r?\n/).slice(-5).join('\n')}`);
}

beforeAll(async () => {
  tools = discoverTools();
  await rm(join(ROOT, 'tmp', 'test-media', 'qc'), { recursive: true, force: true });
  await mkdir(MEDIA, { recursive: true });
  const src = `testsrc2=size=${W}x${H}:rate=${FPS}`;
  await ff([
    '-f', 'lavfi', '-i', `${src}:duration=4`,
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=4',
    '-filter_complex',
    [
      '[0:v]trim=start_frame=0:end_frame=25,setpts=PTS-STARTPTS[p0]',
      `color=black:size=${W}x${H}:rate=${FPS}:duration=1[p1]`,
      '[0:v]trim=start_frame=50:end_frame=60,setpts=PTS-STARTPTS[p2]',
      `[0:v]trim=start_frame=70:end_frame=71,loop=loop=24:size=1:start=0,setpts=N/(${FPS}*TB)[p3]`,
      '[0:v]trim=start_frame=85:end_frame=100,setpts=PTS-STARTPTS[p4]',
      '[p0][p1][p2][p3][p4]concat=n=5:v=1:a=0,format=yuv422p10le[v]',
      "[1:a]volume='if(between(t,2.0,3.5),0,0.3)':eval=frame,aformat=sample_fmts=s32:channel_layouts=stereo[a]",
    ].join(';'),
    '-map', '[v]', '-map', '[a]', '-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-c:a', 'pcm_s24le', '-r', String(FPS), SYNTH,
  ]);
  await ff([
    '-f', 'lavfi', '-i', `${src}:duration=2`,
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=2',
    '-filter_complex',
    [
      '[0:v]trim=start_frame=0:end_frame=20,setpts=PTS-STARTPTS[p0]',
      `[0:v]trim=start_frame=30:end_frame=31,loop=loop=29:size=1:start=0,setpts=N/(${FPS}*TB)[p1]`,
      '[p0][p1]concat=n=2:v=1:a=0,format=yuv422p10le[v]',
      "[1:a]volume='if(gte(t,0.5),0,0.3)':eval=frame,aformat=sample_fmts=s32:channel_layouts=stereo[a]",
    ].join(';'),
    '-map', '[v]', '-map', '[a]', '-c:v', 'prores_ks', '-profile:v', '3', '-c:a', 'pcm_s24le', '-r', String(FPS), EOF_CLIP,
  ]);
  await ff(['-f', 'lavfi', '-i', `${src}:duration=2`, '-c:v', 'mpeg2video', '-q:v', '4', '-f', 'mpegts', NOAUDIO_TS]);
});

const near = (actual: number | undefined, expected: number, tol = 3) => {
  expect(actual).toBeDefined();
  expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(tol);
};

describe('runQc', () => {
  it('counts frames exactly and detects black / freeze / silence within ±3 frames', async () => {
    const sheet = join(MEDIA, 'out', 'synth_contact.png');
    const args: QcArgs = {
      tools,
      path: SYNTH,
      expectedFrames: 100,
      fps: FPS,
      contactSheetPath: sheet,
      clipStarts: [
        { clipId: 'c1', start: 0, dur: 40 },
        { clipId: 'c2', start: 40, dur: 60 },
      ],
    };
    const report = await runQc(args);

    expect(report.frames).toBe(100);
    expect(report.expectedFrames).toBe(100);
    expect(report.issues.filter((i) => i.kind === 'frames')).toHaveLength(0);
    expect(report.issues.filter((i) => i.kind === 'spec')).toHaveLength(0);

    const black = report.issues.filter((i) => i.kind === 'black');
    expect(black).toHaveLength(1);
    near(black[0]!.startFrame, 25);
    near(black[0]!.endFrame, 50);
    expect(black[0]!.clipId).toBe('c1');

    // The black interval is also "frozen" but must be reported once, as black.
    const freeze = report.issues.filter((i) => i.kind === 'freeze');
    expect(freeze).toHaveLength(1);
    near(freeze[0]!.startFrame, 60);
    near(freeze[0]!.endFrame, 85);
    expect(freeze[0]!.severity).toBe('warn');
    expect(freeze[0]!.clipId).toBe('c2');
    expect(freeze[0]!.message).toContain('00:00:02:10');

    const silence = report.issues.filter((i) => i.kind === 'silence');
    expect(silence).toHaveLength(1);
    near(silence[0]!.startFrame, 50);
    near(silence[0]!.endFrame, 88);
    expect(silence[0]!.severity).toBe('warn');

    // Loudness measured (sine at 0.3 amplitude, 1.5 s silent): roughly -32 LUFS / -31 dBTP.
    expect(report.integratedLufs).toBeDefined();
    expect(report.integratedLufs!).toBeGreaterThan(-40);
    expect(report.integratedLufs!).toBeLessThan(-25);
    expect(report.truePeakDb!).toBeGreaterThan(-35);
    expect(report.truePeakDb!).toBeLessThan(-28);
    expect(typeof report.lra).toBe('number');

    // No loudness target → warnings only → ok.
    expect(report.issues.every((i) => i.severity === 'warn')).toBe(true);
    expect(report.ok).toBe(true);

    // Contact sheet: real PNG, 6 columns of 320 px thumbs, 100 frames / step 3 = 34 thumbs → 6 rows.
    expect(report.contactSheet).toBe(sheet);
    const png = await readFile(sheet);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const dims = await execa(tools.ffprobe, ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', sheet], { windowsHide: true });
    const [w, h] = dims.stdout.trim().split(',').map(Number);
    // tile geometry: cols*w + (cols-1)*padding + 2*margin
    expect(w).toBe(6 * 320 + 5 * 2 + 2 * 2);
    expect(h).toBe(6 * 180 + 5 * 2 + 2 * 2);
  });

  it('flags loudness and true peak against a preset target, and frame-count mismatch as errors', async () => {
    const report = await runQc({
      tools,
      path: SYNTH,
      expectedFrames: 101,
      fps: FPS,
      loudness: { integratedLufs: -24, truePeakDb: -40, toleranceLu: 1 },
    });
    expect(report.ok).toBe(false);
    expect(report.frames).toBe(100);
    const frames = report.issues.find((i) => i.kind === 'frames');
    expect(frames?.severity).toBe('error');
    expect(frames?.message).toContain('100');
    expect(frames?.message).toContain('101');
    expect(report.issues.find((i) => i.kind === 'loudness')?.severity).toBe('error');
    expect(report.issues.find((i) => i.kind === 'truepeak')?.severity).toBe('error');
  });

  it('passes a loudness target that is met', async () => {
    const loud = await measureLoudness(tools, SYNTH);
    const report = await runQc({
      tools,
      path: SYNTH,
      expectedFrames: 100,
      fps: FPS,
      loudness: { integratedLufs: loud.integratedLufs, truePeakDb: loud.truePeakDb + 0.5, toleranceLu: 1 },
    });
    expect(report.ok).toBe(true);
    expect(report.issues.filter((i) => i.kind === 'loudness' || i.kind === 'truepeak')).toHaveLength(0);
  });

  it('never overwrites an existing contact sheet', async () => {
    const sheet = join(MEDIA, 'out', 'dup.png');
    const a = await runQc({ tools, path: EOF_CLIP, expectedFrames: 50, fps: FPS, contactSheetPath: sheet });
    const b = await runQc({ tools, path: EOF_CLIP, expectedFrames: 50, fps: FPS, contactSheetPath: sheet });
    expect(a.contactSheet).toBe(sheet);
    expect(b.contactSheet).toBe(join(MEDIA, 'out', 'dup_2.png'));
    expect(existsSync(sheet)).toBe(true);
    expect(existsSync(b.contactSheet!)).toBe(true);
  });

  it('closes freeze / silence that run until EOF at the file end', async () => {
    const report = await runQc({ tools, path: EOF_CLIP, expectedFrames: 50, fps: FPS });
    expect(report.frames).toBe(50);
    const freeze = report.issues.filter((i) => i.kind === 'freeze');
    expect(freeze).toHaveLength(1);
    near(freeze[0]!.startFrame, 20);
    expect(freeze[0]!.endFrame).toBe(50);
    expect(freeze[0]!.message).toContain('ท้ายไฟล์');
    const silence = report.issues.filter((i) => i.kind === 'silence');
    expect(silence).toHaveLength(1);
    near(silence[0]!.startFrame, 13);
    near(silence[0]!.endFrame, 50);
    expect(report.issues.filter((i) => i.kind === 'black')).toHaveLength(0);
  });

  it('handles a stream without audio and without a container frame count', async () => {
    const report = await runQc({
      tools,
      path: NOAUDIO_TS,
      expectedFrames: 50,
      fps: FPS,
      loudness: { integratedLufs: -23, truePeakDb: -1 },
    });
    expect(report.frames).toBe(50);
    expect(report.integratedLufs).toBeUndefined();
    expect(report.issues.filter((i) => i.kind === 'silence')).toHaveLength(0);
    const loud = report.issues.find((i) => i.kind === 'loudness');
    expect(loud?.severity).toBe('error');
    expect(report.ok).toBe(false);
  });

  it('aborts promptly through the signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(runQc({ tools, path: SYNTH, expectedFrames: 100, fps: FPS, signal: ac.signal })).rejects.toThrow(/cancel/i);
  });
});

describe('measureLoudness', () => {
  it('returns integrated loudness, true peak and LRA', async () => {
    const loud = await measureLoudness(tools, SYNTH);
    expect(loud.integratedLufs).toBeGreaterThan(-40);
    expect(loud.integratedLufs).toBeLessThan(-25);
    expect(loud.truePeakDb).toBeGreaterThan(-35);
    expect(loud.truePeakDb).toBeLessThan(-28);
    expect(loud.lra).toBeGreaterThanOrEqual(0);
  });
});
