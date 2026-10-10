import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { getEnvironment } from '../../src/core/tools.js';
import { addAeComp, addFileAsset, createProject, loadProject, validateTimeline } from '../../src/core/project.js';
import { hashFile } from '../../src/core/hash.js';
import { Assembler, probe } from '../../src/engine/ffmpeg.js';
import { runQc } from '../../src/engine/qc.js';
import { PRESETS } from '../../src/engine/presets.js';
import { readXmeml, writeXmeml } from '../../src/io/xmeml.js';
import type { AeBackend } from '../../src/core/types.js';

const env = await getEnvironment();
let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(os.tmpdir(), 'editmcp-e2e-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
async function ff(args: string[]) {
  await execa(env.tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { windowsHide: true, timeout: 60_000 });
}

describe('real ffmpeg integration (synthetic media + mocked Adobe)', () => {
  it('uses elapsed duration for variable-frame-rate footage', async () => {
    const camera = join(dir, 'vfr.mp4');
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=50:duration=2', '-vf', "select='eq(mod(n,5),0)+eq(mod(n,5),1)'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'ultrafast', camera]);
    const raw = JSON.parse((await execa(env.tools.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', camera], { windowsHide: true, timeout: 60_000 })).stdout);
    const info = await probe(env.tools, camera, { fps: 25 });
    expect(info.durationFrames).toBe(Math.round(Number(raw.streams[0].duration) * 25));
  });

  it('encodes every bundled delivery preset with its declared dimensions and codecs', async () => {
    const source = join(dir, 'presets.mov');
    await ff(['-f', 'lavfi', '-i', 'color=blue:size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-c:a', 'pcm_s24le', source]);
    const p = await createProject(join(dir, 'presets'), { name: 'presets', width: 320, height: 180 });
    await addFileAsset(p, source, { id: 'cam' });
    p.timeline.video = [{ id: 'one', src: 'cam', in: 0, dur: 25 }];
    const assembler = new Assembler({ tools: env.tools, env: { ...env, encoders: { ...env.encoders, h264_nvenc: false, h264_qsv: false } }, ae: { kind: 'mock' } as AeBackend });
    const master = await assembler.build(p, { skipQc: true, skipDeliver: true });
    const outputs = await assembler.deliver(p, master.version.id, Object.keys(PRESETS));
    const expected = { h264: 'h264', hevc: 'hevc', prores_422hq: 'prores', prores_4444: 'prores', xdcam_hd422: 'mpeg2video', dnxhr_hqx: 'dnxhd' };
    for (const [target, output] of Object.entries(outputs)) {
      const preset = PRESETS[target]!;
      const info = await probe(env.tools, output);
      expect(info).toMatchObject({ width: preset.video.width, height: preset.video.height, videoCodec: expected[preset.video.codec], audioCodec: preset.audio.codec, sampleRate: 48000, channels: 2, durationFrames: 25 });
      const data = JSON.parse((await execa(env.tools.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], { windowsHide: true, timeout: 60_000 })).stdout);
      if (target === 'th_tv') expect(data.streams[0].field_order).toBe('tt');
      await execa(env.tools.ffmpeg, ['-v', 'error', '-nostdin', '-i', output, '-map', '0:v', '-map', '0:a', '-f', 'null', '-'], { windowsHide: true, timeout: 60_000 });
    }
    const proxy = await assembler.reviewProxy(p, master.version.id);
    expect((await probe(env.tools, proxy)).videoCodec).toBe('h264');
  });

  it('cuts the same project frames as fps conversion followed by trim', async () => {
    const camera = join(dir, 'grid.nut');
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=50', '-t', '2', '-c:v', 'ffv1', camera]);
    const p = await createProject(join(dir, 'grid'), { name: 'grid', width: 320, height: 180 });
    await addFileAsset(p, camera, { id: 'cam' });
    p.timeline.video = [{ id: 'one', src: 'cam', in: 10, dur: 10 }];
    const ae = { kind: 'mock' } as AeBackend;
    await new Assembler({ tools: env.tools, env, ae }).build(p, { skipQc: true, skipDeliver: true });
    const manifest = JSON.parse(await readFile(join(p.dir, 'cache', 'segments', 'manifest.json'), 'utf8'));
    const segment = join(p.dir, 'cache', 'segments', Object.values(manifest.entries)[0]!.file);
    const expected = join(dir, 'expected.mov');
    await ff(['-i', camera, '-vf', 'fps=25,trim=start_frame=10:end_frame=20,setpts=PTS-STARTPTS,setsar=1,format=yuv422p10le', '-an', '-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le', expected]);
    const digest = async (file: string) => (await execa(env.tools.ffmpeg, ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-'], { windowsHide: true, timeout: 60_000 })).stdout.split(/\r?\n/).filter((l) => !l.startsWith('#')).map((l) => l.split(',').at(-1)?.trim());
    expect(await digest(segment)).toEqual(await digest(expected));
  });

  it('stores source duration in project frames and notices replacement media', async () => {
    const camera = join(dir, '50fps.mp4');
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=50', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', camera]);
    const info = await probe(env.tools, camera, { fps: 25 });
    expect(info.fps).toBe(50);
    expect(info.durationFrames).toBe(50);
    const p = await createProject(join(dir, 'rate'), { name: 'rate', width: 320, height: 180 });
    await addFileAsset(p, camera, { id: 'cam', probe: (file) => probe(env.tools, file, { fps: p.meta.fps }) });
    p.timeline.video = [{ id: 'one', src: 'cam', in: 0, dur: 50 }];
    const ae = { kind: 'mock' } as AeBackend;
    const assembler = new Assembler({ ...env, env, ae, concurrency: 1 });
    const first = await assembler.build(p, { skipQc: true, skipDeliver: true });
    const oldHash = p.assets.cam!.kind !== 'aecomp' && p.assets.cam!.hash;
    await ff(['-f', 'lavfi', '-i', 'color=red:size=320x180:rate=50', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', camera]);
    const second = await assembler.build(p, { skipQc: true, skipDeliver: true });
    expect(second.stats.segmentsRendered).toBe(1);
    expect(p.assets.cam!.kind !== 'aecomp' && p.assets.cam!.hash).not.toBe(oldHash);
    expect(await hashFile(first.version.master)).not.toBe(await hashFile(second.version.master));
  });

  it('builds five clips, odd/even dissolves, VO ducking, reuses cache and changes only one comp', async () => {
    const mediaDir = join(dir, "สื่อ 'ทดสอบ'");
    await mkdir(mediaDir);
    const camera = join(mediaDir, 'กล้อง.mp4');
    const prores = join(mediaDir, 'graphic.mov');
    const still = join(mediaDir, 'ภาพ.png');
    const music = join(mediaDir, 'เพลง.wav');
    const voice = join(mediaDir, 'เสียง.wav');
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', camera]);
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-t', '5', '-an', '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', prores]);
    await ff(['-f', 'lavfi', '-i', 'color=yellow:size=320x180', '-frames:v', '1', still]);
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=8', '-ac', '2', music]);
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2', '-ac', '2', voice]);
    let fingerprint = 'comp-before';
    const ae: AeBackend = {
      kind: 'mock',
      fingerprint: async () => ({ Title: fingerprint }),
      render: async (req) => {
        await ff(['-f', 'lavfi', '-i', `color=${fingerprint === 'comp-before' ? 'blue' : 'green'}:size=320x180:rate=25`, '-t', '5', '-an', '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', req.outPath]);
        return { path: req.outPath, frames: 125, elapsedMs: 0, usedFallback: false, log: 'mock Adobe' };
      },
      listComps: async () => [], inspectComp: async () => { throw new Error('unused'); }, edit: async () => { throw new Error('unused'); },
      previewFrame: async () => { throw new Error('unused'); }, version: async () => 'mock',
    };
    const p = await createProject(join(dir, 'โปรเจกต์'), { name: 'ทดสอบ', width: 320, height: 180 });
    for (const [id, file] of [['cam', camera], ['hq', prores], ['still', still], ['music', music], ['vo', voice]]) {
      await addFileAsset(p, file!, { id, probe: (f) => probe(env.tools, f, { fps: p.meta.fps }) });
    }
    addAeComp(p, join(mediaDir, 'template.aep'), 'Title', 'title');
    p.timeline.video = [
      { id: 'a', src: 'cam', in: 10, dur: 40, marker: 'เปิด' },
      { id: 'b', src: 'hq', in: 10, dur: 40 },
      { id: 'c', src: 'title', in: 10, dur: 40 },
      { id: 'd', src: 'still', in: 0, dur: 40 },
      { id: 'e', src: 'cam', in: 70, dur: 40, scale: 110 },
    ];
    p.timeline.cuts = [{ after: 'a', dissolve: 10 }, { after: 'b', dissolve: 13 }, { after: 'c', dissolve: 10 }, { after: 'd', dissolve: 0 }];
    p.timeline.audio = { vo: [{ id: 'v', src: 'vo', at: 50, dur: 50, fadeIn: 3, fadeOut: 3 }], music: [{ id: 'm', src: 'music', at: 0, gainDb: -6 }], sfx: [], duck: { underDb: -12, attackMs: 150, releaseMs: 400 } };
    expect(validateTimeline(p)).toEqual([]);
    const assembler = new Assembler({ tools: env.tools, env: { ...env, encoders: { ...env.encoders, h264_nvenc: false, h264_qsv: false } }, ae, qc: runQc, concurrency: 1 });
    const first = await assembler.build(p, { skipDeliver: true });
    expect(first.stats).toMatchObject({ segmentsRendered: 5, dissolvesRendered: 3, compsRendered: 1 });
    expect(first.version.qc?.frames).toBe(200);
    expect(first.version.qc?.issues.some((i) => i.kind === 'frames' || i.kind === 'loudness')).toBe(false);
    const masterHash = await hashFile(first.version.master);
    const manifestDir = join(p.dir, 'cache', 'segments');
    const cacheBefore = await readdir(manifestDir);
    const manifest = JSON.parse(await readFile(join(manifestDir, 'manifest.json'), 'utf8'));
    expect(Object.values(manifest.entries).some((e) => (e as { clipId: string; mode: string }).clipId === 'b' && (e as { mode: string }).mode === 'copy')).toBe(true);
    const second = await assembler.build(p, { skipQc: true, skipDeliver: true });
    expect(second.stats).toMatchObject({ segmentsRendered: 0, dissolvesRendered: 0, compsRendered: 0, segmentsReused: 5, compsReused: 1 });
    expect(await readdir(manifestDir)).toEqual(cacheBefore);
    const intact = Object.values(manifest.entries).find((e) => (e as { clipId: string }).clipId === 'e') as { file: string };
    await writeFile(join(manifestDir, intact.file), 'truncated cache');
    const recovered = await assembler.build(p, { skipQc: true, skipDeliver: true });
    expect(recovered.stats).toMatchObject({ segmentsRendered: 1, segmentsReused: 4, compsRendered: 0 });
    fingerprint = 'comp-after';
    const third = await assembler.build(p, { skipQc: true, skipDeliver: true });
    expect(third.stats).toMatchObject({ segmentsRendered: 1, segmentsReused: 4, dissolvesRendered: 2, compsRendered: 1 });
    expect(await hashFile(first.version.master)).toBe(masterHash);
    expect(new Set(p.versions.map((v) => v.master)).size).toBe(4);
    const xml = writeXmeml(p, { sequenceName: 'E2E' });
    const imported = readXmeml(xml, p);
    expect(imported.unresolvedPaths).toEqual([]);
    expect(imported.timeline.video).toEqual(p.timeline.video);
    expect(imported.timeline.cuts).toEqual(p.timeline.cuts);
    p.delivery.overrides = {
      yt: { video: { codec: 'h264', width: 320, height: 180, useGpu: false } },
      fb: { video: { codec: 'h264', width: 320, height: 180, useGpu: false } },
    };
    const delivered = await assembler.deliver(p, third.version.id, ['yt', 'fb']);
    for (const [target, file] of Object.entries(delivered)) {
      const qc = await runQc({ tools: env.tools, path: file, expectedFrames: 200, fps: 25, loudness: { integratedLufs: target === 'yt' ? -14 : -16, truePeakDb: -1 } });
      expect(qc.issues.filter((i) => ['frames', 'loudness', 'truepeak'].includes(i.kind))).toEqual([]);
    }
    const repeat = await assembler.deliver(p, third.version.id, ['yt']);
    expect(repeat.yt).not.toBe(delivered.yt);
    expect((await probe(env.tools, repeat.yt!)).durationFrames).toBe(200);
    const saved = await loadProject(p.dir);
    expect(saved.versions).toHaveLength(4);
    await mkdir('tmp', { recursive: true });
    await writeFile('tmp/e2e-results.json', JSON.stringify({ first: first.stats, cached: second.stats, changedComp: third.stats, frames: 200, adobe: 'mock', delivery: ['yt', 'fb'] }, null, 2));
  });
});
