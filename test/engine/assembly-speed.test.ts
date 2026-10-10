import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { getEnvironment } from '../../src/core/tools.js';
import { addFileAsset, createProject, curvePos, speedCurve } from '../../src/core/project.js';
import { Assembler, probe } from '../../src/engine/ffmpeg.js';
import type { AeBackend, Clip, Project } from '../../src/core/types.js';

const env = await getEnvironment();
const ae = { kind: 'mock' } as AeBackend;
const W = 128;
const H = 72;
let dir: string;
let src: string; // frame N has luma 64 + 8N (10-bit), so the frame index can be read back from the picture
beforeAll(async () => {
  dir = await mkdtemp(join(os.tmpdir(), 'editmcp-speed-'));
  src = join(dir, 'ramp.mkv');
  await ff(['-f', 'lavfi', '-i', `nullsrc=s=${W}x${H}:r=25:d=4,format=yuv444p10le,geq=lum='64+8*N':cb=512:cr=512`, '-c:v', 'ffv1', src]);
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

async function ff(args: string[]): Promise<void> {
  await execa(env.tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { windowsHide: true, timeout: 120_000 });
}
async function raw(args: string[]): Promise<Buffer> {
  const r = await execa(env.tools.ffmpeg, ['-v', 'error', '-nostdin', ...args, '-'], { windowsHide: true, timeout: 60_000, encoding: 'buffer' });
  return Buffer.from(r.stdout);
}
/** Source frame index shown in each frame (fractional for blended frames), from the centre luma. */
async function frameIndex(file: string): Promise<number[]> {
  const buf = await raw(['-i', file, '-map', '0:v:0', '-vf', 'crop=16:16:(iw-16)/2:(ih-16)/2,format=yuv444p10le,extractplanes=y,scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'gray10le']);
  const out: number[] = [];
  for (let i = 0; i + 1 < buf.length; i += 2) out.push((buf.readUInt16LE(i) - 64) / 8);
  return out;
}
async function newProject(name: string, clips: Clip[], extra: Partial<Project['timeline']> = {}): Promise<Project> {
  const p = await createProject(join(dir, name), { name, width: W, height: H });
  await addFileAsset(p, src, { id: 'src', probe: (f) => probe(env.tools, f, { fps: 25 }) });
  p.timeline.video = clips;
  p.timeline.audio.useClipAudio = false;
  Object.assign(p.timeline, extra);
  return p;
}
const build = (p: Project) => new Assembler({ tools: env.tools, env, ae, concurrency: 2 }).build(p, { skipQc: true, skipDeliver: true });

describe('speed in the assembler', () => {
  it('0.5 nearest: every source frame twice, frame-exact, and the copy path is not used', async () => {
    const p = await newProject('half_nearest', [{ id: 'a', src: 'src', in: 10, dur: 20, speed: { rate: 0.5, interpolation: 'nearest' } }]);
    const res = await build(p);
    const idx = await frameIndex(res.version.master);
    expect(idx).toHaveLength(20);
    idx.forEach((v, k) => expect(v, `frame ${k}`).toBeCloseTo(10 + Math.floor(k * 0.5), 1));
  }, 120_000);

  it('0.5 blend: in-between frames are 50/50 mixes of their neighbours', async () => {
    const p = await newProject('half_blend', [{ id: 'a', src: 'src', in: 10, dur: 20, speed: { rate: 0.5, interpolation: 'blend' } }]);
    const idx = await frameIndex((await build(p)).version.master);
    expect(idx).toHaveLength(20);
    idx.forEach((v, k) => expect(Math.abs(v - (10 + k * 0.5)), `frame ${k}: ${v}`).toBeLessThan(0.15));
  }, 120_000);

  it('2.0 (default nearest): every other source frame', async () => {
    const p = await newProject('double', [{ id: 'a', src: 'src', in: 4, dur: 20, speed: { rate: 2 } }]);
    const idx = await frameIndex((await build(p)).version.master);
    expect(idx).toHaveLength(20);
    idx.forEach((v, k) => expect(v, `frame ${k}`).toBeCloseTo(4 + 2 * k, 1));
  }, 120_000);

  it('ramp 0.5 -> 1 over 12 frames is smooth: per-frame source steps never jump and follow the eased curve', async () => {
    const clip: Clip = { id: 'a', src: 'src', in: 5, dur: 30, speed: { rate: 1, rampFrom: 0.5, rampFrames: 12, interpolation: 'blend' } };
    const p = await newProject('ramp', [clip]);
    const idx = await frameIndex((await build(p)).version.master);
    expect(idx).toHaveLength(30);
    const curve = speedCurve(clip)!;
    idx.forEach((v, k) => expect(Math.abs(v - (5 + curvePos(curve, k))), `frame ${k}: ${v}`).toBeLessThan(0.15));
    const steps = idx.slice(1).map((v, k) => v - idx[k]!);
    for (let k = 1; k < steps.length; k++) expect(steps[k]!, `step ${k}`).toBeGreaterThan(steps[k - 1]! - 0.12); // monotonic up to noise
    for (const s of steps) { expect(s).toBeGreaterThan(0.35); expect(s).toBeLessThan(1.15); }
    expect(steps.slice(14).every((s) => Math.abs(s - 1) < 0.12)).toBe(true); // realtime after the ramp
  }, 120_000);

  it('motion (minterpolate) lands on the same slots and warns about its cost', async () => {
    const p = await newProject('motion', [{ id: 'a', src: 'src', in: 10, dur: 10, speed: { rate: 0.5, interpolation: 'motion' } }]);
    const warnings: string[] = [];
    const res = await new Assembler({ tools: env.tools, env, ae, concurrency: 1 }).build(p, {
      skipQc: true, skipDeliver: true, onProgress: (pr) => { if (pr.stage === 'warning' && pr.message) warnings.push(pr.message); },
    });
    const idx = await frameIndex(res.version.master);
    expect(idx).toHaveLength(10);
    idx.forEach((v, k) => expect(Math.abs(v - (10 + k * 0.5)), `frame ${k}: ${v}`).toBeLessThan(0.3)); // flat frames: like a blend
    expect(warnings.some((w) => /motion interpolation/.test(w))).toBe(true);
  }, 120_000);

  it('dissolves take their handles through the speed curve (A at 0.5 into B)', async () => {
    const p = await newProject('dissolve', [
      { id: 'a', src: 'src', in: 10, dur: 20, speed: { rate: 0.5, interpolation: 'nearest' } },
      { id: 'b', src: 'src', in: 60, dur: 20 },
    ], { cuts: [{ after: 'a', dissolve: 6 }] });
    const res = await build(p);
    expect(res.stats.dissolvesRendered).toBe(1);
    const idx = await frameIndex(res.version.master);
    expect(idx).toHaveLength(40);
    // body of a before the dissolve [0, 17) is pure a; the dissolve covers [17, 23)
    for (let k = 0; k < 17; k++) expect(idx[k]).toBeCloseTo(10 + Math.floor(k * 0.5), 1);
    // after the dissolve, b plays in realtime from 60 + 3
    for (let k = 23; k < 40; k++) expect(idx[k]).toBeCloseTo(60 + (k - 20), 1);
    // inside the dissolve: frame 17 + j mixes a's frame 10 + floor((17 + j) / 2) with b's 57 + j at (j + 0.5) / 6
    for (let j = 0; j < 6; j++) {
      const w = (j + 0.5) / 6;
      expect(Math.abs(idx[17 + j]! - ((1 - w) * (10 + Math.floor((17 + j) / 2)) + w * (57 + j)))).toBeLessThan(0.3);
    }
  }, 120_000);

  it('speed and push-in are part of the segment cache key', async () => {
    const p = await newProject('keys', [{ id: 'a', src: 'src', in: 10, dur: 10 }]);
    await build(p);
    const again = await build(p);
    expect(again.stats.segmentsReused).toBe(1);
    p.timeline.video[0]!.speed = { rate: 0.5 };
    expect((await build(p)).stats.segmentsRendered).toBe(1);
    p.timeline.video[0]!.pushIn = 10;
    expect((await build(p)).stats.segmentsRendered).toBe(1);
    expect((await build(p)).stats.segmentsReused).toBe(1);
  }, 120_000);

  it('keeps clip audio the length of the retimed picture (atempo)', async () => {
    const av = join(dir, 'av.mkv');
    await ff(['-i', src, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'pcm_s16le', av]);
    const p = await createProject(join(dir, 'audio'), { name: 'audio', width: W, height: H });
    await addFileAsset(p, av, { id: 'av', probe: (f) => probe(env.tools, f, { fps: 25 }) });
    p.timeline.video = [
      { id: 'a', src: 'av', in: 10, dur: 25, speed: { rate: 0.5 } },
      { id: 'b', src: 'av', in: 30, dur: 25, speed: { rate: 1.5, rampFrom: 1, rampFrames: 8 } },
    ];
    const res = await build(p);
    const pcm = await raw(['-i', res.version.master, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le']);
    const s = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 4));
    expect(s.length / 48000).toBeCloseTo(50 / 25, 2);
    // sound all the way through both clips (no gap at the ramp boundary)
    for (let t = 0.05; t < 1.95; t += 0.1) {
      const w = s.subarray(Math.round(t * 48000), Math.round(t * 48000) + 480);
      const rms = Math.sqrt(w.reduce((a, x) => a + x * x, 0) / w.length);
      expect(rms, `t=${t.toFixed(2)}`).toBeGreaterThan(0.01);
    }
  }, 120_000);
});

describe('push-in', () => {
  it('zooms progressively from 100% to 100+pushIn%, centred, on top of Clip.scale', async () => {
    const box = join(dir, 'box.mov');
    await ff(['-f', 'lavfi', '-i', `color=black:s=${W}x${H}:r=25:d=2`, '-vf', 'drawbox=x=44:y=16:w=40:h=40:c=white:t=fill', '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', box]);
    const p = await createProject(join(dir, 'push'), { name: 'push', width: W, height: H });
    await addFileAsset(p, box, { id: 'box', probe: (f) => probe(env.tools, f, { fps: 25 }) });
    p.timeline.video = [{ id: 'z', src: 'box', in: 0, dur: 25, pushIn: 20, scale: 110 }];
    const res = await build(p);
    const buf = await raw(['-i', res.version.master, '-vf', 'format=gray', '-f', 'rawvideo']);
    const widths: number[] = [];
    for (let f = 0; f * W * H < buf.length; f++) {
      const row = buf.subarray(f * W * H + (H / 2) * W, f * W * H + (H / 2 + 1) * W);
      let n = 0;
      let first = -1;
      row.forEach((v, x) => { if (v > 128) { n++; if (first < 0) first = x; } });
      widths.push(n);
      expect(Math.abs(first + n / 2 - W / 2), `centred at frame ${f}`).toBeLessThanOrEqual(2);
    }
    expect(widths).toHaveLength(25);
    expect(widths[0]).toBeGreaterThanOrEqual(43); // 40 px * 1.10
    expect(widths[0]).toBeLessThanOrEqual(45);
    expect(widths[24]).toBeGreaterThanOrEqual(51); // 40 * 1.10 * 1.20 = 52.8
    expect(widths[24]).toBeLessThanOrEqual(55);
    for (let f = 1; f < 25; f++) expect(widths[f]!).toBeGreaterThanOrEqual(widths[f - 1]!);
  }, 120_000);
});

describe('previewRange', () => {
  it('encodes only the segments touching the range into the shared cache, and a build reuses them', async () => {
    const p = await newProject('preview', [
      { id: 'a', src: 'src', in: 0, dur: 20 },
      { id: 'b', src: 'src', in: 30, dur: 20, speed: { rate: 0.5 } },
      { id: 'c', src: 'src', in: 60, dur: 20 },
      { id: 'd', src: 'src', in: 80, dur: 10 },
    ], { cuts: [{ after: 'b', dissolve: 4 }] });
    const asm = new Assembler({ tools: env.tools, env, ae, concurrency: 1 });
    const r = await asm.previewRange(p, { from: 25, to: 45 });
    expect(r.frames).toBe(20);
    expect(existsSync(r.path)).toBe(true);
    expect(r.path).toContain(join('review', 'previews'));
    expect(r).toMatchObject({ segmentsRendered: 2, dissolvesRendered: 1, segmentsReused: 0 }); // b body, c body, b->c
    const info = await probe(env.tools, r.path, { fps: 25 });
    expect(info.height).toBe(36);
    // frame 25 of the timeline = b's frame 5 = source 30 + 2.5 (blend)
    const idx = await frameIndex(r.path);
    expect(idx).toHaveLength(20);
    expect(Math.abs(idx[0]! - 32.5)).toBeLessThan(0.6);

    const again = await asm.previewRange(p, { from: 25, to: 45 });
    expect(again.path).not.toBe(r.path); // never overwrites
    expect(again.segmentsRendered).toBe(0);

    const res = await asm.build(p, { skipQc: true, skipDeliver: true });
    expect(res.stats.segmentsReused).toBe(2);
    expect(res.stats.segmentsRendered).toBe(2);
    expect(res.stats.dissolvesRendered).toBe(0);

    const fromMaster = await asm.previewRange(p, { from: 0, to: 10, version: res.version.id, scale: 0.25 });
    expect(fromMaster).toMatchObject({ frames: 10, source: 'version' });
    expect((await frameIndex(fromMaster.path))[3]).toBeCloseTo(3, 0);
    const manifest = JSON.parse(await readFile(join(p.dir, 'cache', 'segments', 'manifest.json'), 'utf8'));
    expect(Object.keys(manifest.entries)).toHaveLength(5);
  }, 180_000);
});
