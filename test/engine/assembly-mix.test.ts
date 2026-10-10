import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { getEnvironment } from '../../src/core/tools.js';
import { addAeComp, addFileAsset, createProject } from '../../src/core/project.js';
import { Assembler, probe } from '../../src/engine/ffmpeg.js';
import { measureLoudness } from '../../src/engine/qc.js';
import type { AeBackend } from '../../src/core/types.js';

const env = await getEnvironment();
const ae = { kind: 'mock' } as AeBackend;
const W = 320;
const H = 180;
let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(os.tmpdir(), 'editmcp-mix-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

async function ff(args: string[]): Promise<void> {
  await execa(env.tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { windowsHide: true, timeout: 120_000 });
}
async function raw(args: string[]): Promise<Buffer> {
  const r = await execa(env.tools.ffmpeg, ['-v', 'error', '-nostdin', ...args, '-'], { windowsHide: true, timeout: 60_000, encoding: 'buffer' });
  return Buffer.from(r.stdout);
}
const solid = (color: string, out: string) =>
  ff(['-f', 'lavfi', '-i', `color=${color}:size=${W}x${H}:rate=25`, '-t', '4', '-an', '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', out]);

describe('audio mix headroom', () => {
  it('does not clip a mix that sums past 0 dBFS before loudnorm', async () => {
    const pic = join(dir, 'pic.mov');
    const music = join(dir, 'music.wav');
    const sfx = join(dir, 'sfx.wav');
    await solid('gray', pic);
    // Two in-phase 0.7 sines: the sum peaks at 1.4 (+2.9 dBFS).
    for (const f of [music, sfx]) await ff(['-f', 'lavfi', '-i', 'aevalsrc=0.7*sin(2*PI*440*t):s=48000:d=4:c=stereo', '-c:a', 'pcm_f32le', f]);
    const p = await createProject(join(dir, 'mix'), { name: 'mix', width: W, height: H });
    for (const [id, file] of [['pic', pic], ['music', music], ['sfx', sfx]] as const) {
      await addFileAsset(p, file, { id, probe: (f) => probe(env.tools, f, { fps: 25 }) });
    }
    p.timeline.video = [{ id: 'one', src: 'pic', in: 0, dur: 100 }];
    p.timeline.audio = { vo: [], music: [{ id: 'm', src: 'music', at: 0 }], sfx: [{ id: 's', src: 'sfx', at: 0 }] };
    const res = await new Assembler({ tools: env.tools, env, ae, concurrency: 1 }).build(p, { skipQc: true, skipDeliver: true });

    const pcm = await raw(['-i', res.version.master, '-map', '0:a:0', '-ac', '1', '-f', 'f32le']);
    const s = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 4)).subarray(48000, 3 * 48000);
    let peak = 0;
    let sq = 0;
    for (const x of s) { peak = Math.max(peak, Math.abs(x)); sq += x * x; }
    const crest = peak / Math.sqrt(sq / s.length);
    expect(peak).toBeLessThan(1); // no sample at full scale
    expect(crest).toBeGreaterThan(1.35); // still a sine (sqrt 2); a clipped sum flattens to ~1.2
    const loud = await measureLoudness(env.tools, res.version.master);
    expect(Math.abs(loud.integratedLufs - -23)).toBeLessThanOrEqual(1);
    expect(loud.truePeakDb).toBeLessThanOrEqual(-0.5);
  }, 120_000);
});

describe('build order', () => {
  it('rejects a structurally broken timeline before any After Effects work', async () => {
    const p = await createProject(join(dir, 'broken'), { name: 'broken', width: W, height: H });
    addAeComp(p, join(dir, 'never.aep'), 'Title', 'title');
    p.timeline.video = [{ id: 'a', src: 'title', in: 0, dur: 0 }, { id: 'b', src: 'title', in: 0, dur: 25 }];
    p.timeline.cuts = [{ after: 'nope', dissolve: 4 }];
    let aeCalls = 0;
    const busyAe = {
      kind: 'mock',
      fingerprint: async () => { aeCalls++; return { Title: 'x' }; },
      render: async () => { aeCalls++; throw new Error('aerender must not run'); },
    } as unknown as AeBackend;
    await expect(new Assembler({ tools: env.tools, env, ae: busyAe }).build(p, { skipQc: true, skipDeliver: true }))
      .rejects.toThrow(/timeline invalid[\s\S]*dur must be > 0[\s\S]*unknown clip/);
    expect(aeCalls).toBe(0);
  });
});

describe('interlaced delivery', () => {
  it('scales the 50p frames before weaving fields, so each field stays one source frame', async () => {
    // 50p master alternating black / white frames: after the weave, lines alternate black / white.
    // Scaling the woven frame instead would average neighbouring lines into grey.
    const alt = join(dir, 'alt50.mov');
    await ff(['-f', 'lavfi', '-i', 'color=black:size=640x360:rate=50', '-t', '2', '-vf', "drawbox=c=white:t=fill:enable='mod(n,2)'", '-an', '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', alt]);
    const p = await createProject(join(dir, 'interlace'), { name: 'interlace', fps: 50, width: 640, height: 360 });
    await addFileAsset(p, alt, { id: 'alt', probe: (f) => probe(env.tools, f, { fps: 50 }) });
    p.timeline.video = [{ id: 'one', src: 'alt', in: 0, dur: 50 }];
    p.delivery.overrides = { th_tv: { video: { codec: 'xdcam_hd422', width: 320, height: 180, fps: 25, interlaced: true, bitrateMbps: 50, cbr: true } } };
    const assembler = new Assembler({ tools: env.tools, env, ae, concurrency: 1 });
    const res = await assembler.build(p, { skipQc: true, skipDeliver: true });
    const out = (await assembler.deliver(p, res.version.id, ['th_tv'])).th_tv!;
    expect(await probe(env.tools, out, { fps: 25 })).toMatchObject({ width: 320, height: 180, durationFrames: 25 });
    const pix = await raw(['-i', out, '-map', '0:v:0', '-frames:v', '1', '-vf', 'format=gray', '-f', 'rawvideo']);
    let diff = 0;
    for (let y = 0; y < 178; y += 2) {
      for (let x = 0; x < 320; x++) diff += Math.abs(pix[y * 320 + x]! - pix[(y + 1) * 320 + x]!);
    }
    expect(diff / (89 * 320)).toBeGreaterThan(150);
  }, 120_000);
});

describe('dissolve curve', () => {
  it('mixes frame k of n at (k + 0.5) / n and leaves frames outside [C-a, C+b) pure', async () => {
    const black = join(dir, 'black.mov');
    const white = join(dir, 'white.mov');
    await solid('black', black);
    await solid('white', white);
    const p = await createProject(join(dir, 'curve'), { name: 'curve', width: W, height: H });
    await addFileAsset(p, black, { id: 'black', probe: (f) => probe(env.tools, f, { fps: 25 }) });
    await addFileAsset(p, white, { id: 'white', probe: (f) => probe(env.tools, f, { fps: 25 }) });
    p.timeline.video = [
      { id: 'a', src: 'black', in: 10, dur: 20 },
      { id: 'b', src: 'white', in: 10, dur: 20 },
      { id: 'c', src: 'black', in: 10, dur: 20 },
    ];
    // cut 20: N=1 -> [20, 21); cut 40: N=2 -> [39, 41)
    p.timeline.cuts = [{ after: 'a', dissolve: 1 }, { after: 'b', dissolve: 2 }];
    p.timeline.audio.useClipAudio = false;
    const res = await new Assembler({ tools: env.tools, env, ae, concurrency: 1 }).build(p, { skipQc: true, skipDeliver: true });
    expect(res.stats.dissolvesRendered).toBe(2);

    // Mean 10-bit luma per frame.
    const buf = await raw(['-i', res.version.master, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'yuv422p10le']);
    const frameBytes = W * H * 4; // Y (2 bytes) + U + V (1 byte each per pixel on average)
    const luma = (f: number): number => {
      let sum = 0;
      for (let i = 0; i < W * H; i++) sum += buf.readUInt16LE(f * frameBytes + i * 2);
      return sum / (W * H);
    };
    expect(buf.length / frameBytes).toBe(60);
    const B0 = luma(0); // black
    const W0 = luma(30); // white
    expect(W0 - B0).toBeGreaterThan(800);
    const at = (w: number) => B0 + (W0 - B0) * w; // w = white weight
    const near = (f: number, want: number) => expect(Math.abs(luma(f) - want), `frame ${f}: ${luma(f)} vs ${want}`).toBeLessThanOrEqual(4);
    near(19, at(0));
    near(20, at(0.5)); // N=1: a 50/50 frame, not a hard cut
    near(21, at(1));
    near(38, at(1));
    near(39, at(0.75)); // N=2: 25% of the incoming black
    near(40, at(0.25)); // 75% black
    near(41, at(0));
  }, 120_000);
});
