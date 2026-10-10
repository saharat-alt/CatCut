import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { getEnvironment } from '../../src/core/tools.js';
import { addFileAsset, createProject } from '../../src/core/project.js';
import { Assembler, probe } from '../../src/engine/ffmpeg.js';
import type { AeBackend, Project } from '../../src/core/types.js';

const env = await getEnvironment();
const ae = { kind: 'mock' } as AeBackend;
let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(os.tmpdir(), 'editmcp-seek-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

async function ff(args: string[]): Promise<void> {
  await execa(env.tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { windowsHide: true, timeout: 120_000 });
}
async function digest(file: string): Promise<string[]> {
  const { stdout } = await execa(env.tools.ffmpeg, ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-'], { windowsHide: true, timeout: 60_000 });
  return stdout.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').at(-1)!.trim());
}
async function raw(args: string[]): Promise<Buffer> {
  const r = await execa(env.tools.ffmpeg, ['-v', 'error', '-nostdin', ...args, '-'], { windowsHide: true, timeout: 60_000, encoding: 'buffer' });
  return Buffer.from(r.stdout);
}
async function cacheEntries(p: Project): Promise<Array<{ file: string; kind: string; mode: string; clipId?: string; frames: number }>> {
  const m = JSON.parse(await readFile(join(p.dir, 'cache', 'segments', 'manifest.json'), 'utf8'));
  return Object.values(m.entries);
}
const PRORES = ['-an', '-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le'];
/** The pre-seek reference: decode from frame 0, then fps + trim on project frames. */
const fromStart = (fps: number, srcIn: number, n: number) =>
  `setpts=PTS-STARTPTS,fps=${fps},trim=start_frame=${srcIn}:end_frame=${srcIn + n},setpts=PTS-STARTPTS,setsar=1,format=yuv422p10le`;

describe('seeking segment/dissolve encodes (deep in-points)', () => {
  it('produce the same frames as decoding from the start, for bodies and dissolve sides', async () => {
    // 60 s sources with 10 s GOPs: 50 fps (fps conversion), 25 fps with B-frames (no fps filter),
    // and 50 fps whose video starts 0.37 s after the container start.
    const src50 = join(dir, 'src50.mp4');
    const src25 = join(dir, 'src25.mp4');
    const off50 = join(dir, 'off50.mkv');
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=50', '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '500', src50]);
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '250', '-bf', '2', src25]);
    await ff(['-itsoffset', '0.37', '-i', src50, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=61', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', off50]);

    const p = await createProject(join(dir, 'seek'), { name: 'seek', width: 320, height: 180 });
    for (const [id, file] of [['s50', src50], ['s25', src25], ['off', off50]] as const) {
      await addFileAsset(p, file, { id, probe: (f) => probe(env.tools, f, { fps: 25 }) });
    }
    p.timeline.video = [
      { id: 'a', src: 's50', in: 1200, dur: 30 },
      { id: 'b', src: 's25', in: 1300, dur: 30 },
      { id: 'c', src: 'off', in: 1400, dur: 20 },
    ];
    p.timeline.cuts = [{ after: 'a', dissolve: 10 }];
    p.timeline.audio.useClipAudio = false;
    const t0 = Date.now();
    const res = await new Assembler({ tools: env.tools, env, ae, concurrency: 1 }).build(p, { skipQc: true, skipDeliver: true });
    expect(res.stats).toMatchObject({ segmentsRendered: 3, dissolvesRendered: 1 });
    expect(Date.now() - t0).toBeLessThan(60_000);

    const entries = await cacheEntries(p);
    const seg = (clipId: string) => join(p.dir, 'cache', 'segments', entries.find((e) => e.clipId === clipId)!.file);
    const refs = join(dir, 'refs');
    await mkdir(refs, { recursive: true });

    // bodies: a = [1200, 1225), b = [1305, 1330), c = [1400, 1420)
    for (const [clipId, file, srcIn, n] of [['a', src50, 1200, 25], ['b', src25, 1305, 25], ['c', off50, 1400, 20]] as const) {
      const ref = join(refs, `${clipId}.mov`);
      await ff(['-i', file, '-vf', fromStart(25, srcIn, n), '-frames:v', String(n), ...PRORES, ref]);
      const want = await digest(ref);
      expect(want).toHaveLength(n);
      expect(await digest(seg(clipId)), `body ${clipId}`).toEqual(want);
    }

    // dissolve a->b (10 frames): A side [1225, 1235) of s50, B side [1295, 1305) of s25
    const dissolve = join(p.dir, 'cache', 'segments', entries.find((e) => e.kind === 'dissolve')!.file);
    const ref = join(refs, 'dissolve.mov');
    await ff([
      '-i', src50, '-i', src25, '-filter_complex',
      `[0:v:0]${fromStart(25, 1225, 10)}[va];[1:v:0]${fromStart(25, 1295, 10)}[vb];[va][vb]blend=all_expr='A+(B-A)*clip((round(T*25)+0.5)/10,0,1)+0.5'[v]`,
      '-map', '[v]', '-frames:v', '10', ...PRORES, ref,
    ]);
    expect(await digest(dissolve)).toEqual(await digest(ref));
  }, 180_000);
});

describe('frame-exact cuts on a 1/fps time base at 30 fps', () => {
  // AE's Lossless AVI has time base 1/fps; the fps filter outputs 1/fps too. Half a frame at 30 fps is
  // not a whole number of microseconds, so trim used to round its margins away (last frame lost, or
  // the body shifted one frame early).
  it('keeps every frame and the exact in-point', async () => {
    const avi = join(dir, 'ae_lossless.avi');
    const mp4 = join(dir, 'src25.mp4');
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '6', '-c:v', 'rawvideo', '-pix_fmt', 'bgr24', avi]);
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', mp4]);
    const p = await createProject(join(dir, 'tb30'), { name: 'tb30', width: 320, height: 180, fps: 30 });
    await addFileAsset(p, avi, { id: 'avi', probe: (f) => probe(env.tools, f, { fps: 30 }) });
    await addFileAsset(p, mp4, { id: 'mp4', probe: (f) => probe(env.tools, f, { fps: 30 }) });
    p.timeline.video = [
      { id: 'whole', src: 'avi', in: 0, dur: 180 },
      { id: 'mid', src: 'avi', in: 10, dur: 20 },
      { id: 'conv', src: 'mp4', in: 7, dur: 20 },
    ];
    p.timeline.audio.useClipAudio = false;
    await new Assembler({ tools: env.tools, env, ae, concurrency: 1 }).build(p, { skipQc: true, skipDeliver: true });
    const entries = await cacheEntries(p);
    for (const [clipId, file, srcIn, n] of [['whole', avi, 0, 180], ['mid', avi, 10, 20], ['conv', mp4, 7, 20]] as const) {
      const ref = join(dir, `ref_${clipId}.mov`);
      await ff(['-i', file, '-vf', fromStart(30, srcIn, n), '-frames:v', String(n), ...PRORES, ref]);
      const want = await digest(ref);
      expect(want).toHaveLength(n);
      expect(await digest(join(p.dir, 'cache', 'segments', entries.find((e) => e.clipId === clipId)!.file)), clipId).toEqual(want);
    }
  }, 120_000);
});

describe('A/V origin', () => {
  // Flash on video frame 30 and a beep at the same presentation time; the video stream starts
  // 0.4 s after the audio (container start), so the beep sits at 0.4 + 30/25 = 1.6 s.
  async function synth(out: string, vcodec: string[]): Promise<void> {
    const v = join(dir, `v_${Date.now()}.mov`);
    const a = join(dir, `a_${Date.now()}.wav`);
    await ff(['-f', 'lavfi', '-i', 'color=black:s=320x180:r=25:d=4', '-vf', "drawbox=c=white:t=fill:enable='eq(n,30)'", ...vcodec, v]);
    await ff(['-f', 'lavfi', '-i', "aevalsrc='if(between(t,1.6,1.7),0.5*sin(2*PI*1000*t),0)':s=48000:d=5:c=stereo", a]);
    await ff(['-itsoffset', '0.4', '-i', v, '-i', a, '-map', '0:v', '-map', '1:a', '-c', 'copy', out]);
  }

  async function offsets(master: string): Promise<{ flashSec: number; beepSec: number }> {
    const pix = await raw(['-i', master, '-map', '0:v:0', '-vf', 'scale=16:16,format=gray', '-f', 'rawvideo']);
    let flash = -1;
    for (let f = 0; f * 256 < pix.length; f++) {
      let sum = 0;
      for (let i = 0; i < 256; i++) sum += pix[f * 256 + i]!;
      if (sum / 256 > 128) { flash = f; break; }
    }
    const pcm = await raw(['-i', master, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le']);
    const s = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 4));
    let max = 0;
    for (const x of s) max = Math.max(max, Math.abs(x));
    const beep = s.findIndex((x) => Math.abs(x) > max * 0.25);
    expect(flash).toBeGreaterThanOrEqual(0);
    expect(beep).toBeGreaterThanOrEqual(0);
    return { flashSec: flash / 25, beepSec: beep / 48000 };
  }

  for (const variant of ['encode', 'copy'] as const) {
    it(`keeps clip audio in sync with the picture when the video starts late (${variant} path)`, async () => {
      const file = join(dir, `late_${variant}.${variant === 'copy' ? 'mov' : 'mkv'}`);
      await synth(file, variant === 'copy' ? ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le'] : ['-c:v', 'ffv1']);
      const p = await createProject(join(dir, `av_${variant}`), { name: 'av', width: 320, height: 180 });
      await addFileAsset(p, file, { id: 'cam', probe: (f) => probe(env.tools, f, { fps: 25 }) });
      p.timeline.video = [{ id: 'one', src: 'cam', in: 10, dur: 50 }];
      const res = await new Assembler({ tools: env.tools, env, ae, concurrency: 1 }).build(p, { skipQc: true, skipDeliver: true });
      expect((await cacheEntries(p))[0]!.mode).toBe(variant);
      const { flashSec, beepSec } = await offsets(res.version.master);
      expect(flashSec).toBeCloseTo(20 / 25, 5); // source frame 30 - in 10
      expect(Math.abs(beepSec - flashSec)).toBeLessThanOrEqual(1 / 25);
    }, 120_000);
  }
});
