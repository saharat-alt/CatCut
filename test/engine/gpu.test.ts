import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { Assembler } from '../../src/engine/ffmpeg.js';
import { createProject } from '../../src/core/project.js';
import type { AeBackend, Environment, Version } from '../../src/core/types.js';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: spawn }));
let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

it('falls back to CPU after a GPU driver failure for delivery and review proxies', async () => {
  dir = await mkdtemp(join(os.tmpdir(), 'editmcp-gpu-test-'));
  const p = await createProject(dir, { name: 'gpu', width: 320, height: 180 });
  const master = join(dir, 'master.mov'); await writeFile(master, 'fake');
  p.timeline.video = [{ id: 'c', src: 'a', in: 0, dur: 25 }];
  p.versions = [{ id: 'v001', master, deliverables: {} } as Version];
  const env: Environment = { tools: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }, encoders: { h264_nvenc: true, h264_qsv: false, hevc_nvenc: false, libx264: true, prores_ks: true, dnxhd: true, mpeg2video: true }, freeRamGb: 4, totalRamGb: 16, cpuThreads: 4 };
  spawn.mockImplementation(async (bin: string, args: string[]) => {
    if (bin === 'ffprobe') return { exitCode: 0, stdout: JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'prores', width: 320, height: 180, r_frame_rate: '25/1', nb_frames: '25' }] }), stderr: '' };
    if (args.includes('h264_nvenc')) return { exitCode: 1, stdout: '', stderr: 'Cannot load CUDA driver' };
    expect(args).toContain('libx264'); expect(args).not.toContain('-rc');
    await writeFile(args.at(-1)!, 'CPU output');
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  const assembler = new Assembler({ tools: env.tools, env, ae: { kind: 'mock' } as AeBackend });
  expect((await assembler.deliver(p, 'v001', ['led'])).led).toMatch(/\.mov$/);
  expect(await assembler.reviewProxy(p, 'v001')).toMatch(/\.mp4$/);
  expect(spawn.mock.calls.filter(([, args]) => args.includes('h264_nvenc'))).toHaveLength(2);
  expect(spawn.mock.calls.filter(([, args]) => args.includes('libx264'))).toHaveLength(2);
});
