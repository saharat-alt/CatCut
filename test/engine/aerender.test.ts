import { afterEach, describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { discoverTools } from '../../src/core/tools.js';
import {
  AerenderError, aerender, createProgressParser, defaultMfrPercent, isMissingOmTemplate, moveFile, transcodeToProres, type SpawnFn,
} from '../../src/engine/aerender.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup() {
  const dir = await mkdtemp(join(os.tmpdir(), 'editmcp-render-test-'));
  dirs.push(dir);
  const aep = join(dir, 'input.aep');
  await writeFile(aep, 'fake');
  const tools = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', aerender: 'aerender.exe' };
  const spawn = vi.fn(async (bin: string, args: string[]) => {
    if (bin === 'aerender.exe') {
      const output = args[args.indexOf('-output') + 1]!;
      expect(output).toMatch(/^[\x00-\x7f]+$/);
      expect(args).not.toContain('-reuse');
      await writeFile(output, 'new render');
      return { exitCode: 0, stdout: 'PROGRESS: Frame Rate: 25\nPROGRESS: Duration: 0:00:00:02\nPROGRESS: 0:00:00:01 (2)', stderr: '' };
    }
    return { exitCode: 0, stdout: '2', stderr: '' };
  });
  return { dir, aep, tools, spawn };
}

describe('aerender (mock spawns)', () => {
  it('renders the inclusive frame range to ASCII temp and preserves existing Thai outputs', async () => {
    const { dir, aep, tools, spawn } = await setup();
    const outPath = join(dir, 'ไทย.mov');
    await writeFile(outPath, 'old render');
    const r = await aerender(tools, { aep, comp: 'ไทย', outPath, startFrame: 10, endFrame: 11, omTemplate: 'ProRes', rsTemplate: 'Best Settings' }, { spawn: spawn as unknown as SpawnFn });
    expect(r.frames).toBe(2);
    expect(r.path).not.toBe(outPath);
    expect(await readFile(outPath, 'utf8')).toBe('old render');
    expect(await readFile(r.path, 'utf8')).toBe('new render');
    expect(spawn.mock.calls[0]![1]).toEqual(expect.arrayContaining(['-s', '10', '-e', '11']));
  });
  it('rejects frame count mismatch and already cancelled requests', async () => {
    const { dir, aep, tools, spawn } = await setup();
    const req = { aep, comp: 'Title', outPath: join(dir, 'out.mov'), startFrame: 0, endFrame: 9, omTemplate: 'ProRes', rsTemplate: 'Best Settings' };
    await expect(aerender(tools, req, { spawn: spawn as unknown as SpawnFn })).rejects.toThrow(/frame count mismatch/);
    const controller = new AbortController(); controller.abort();
    spawn.mockClear();
    await expect(aerender(tools, { ...req, signal: controller.signal }, { spawn: spawn as unknown as SpawnFn })).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });
  it('timeout kills the whole process tree and releases the render queue', async () => {
    const { dir, aep, tools } = await setup();
    const kill = vi.fn();
    const spawn = vi.fn((bin: string) => {
      if (bin === 'taskkill') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      let finish: (value: unknown) => void;
      const promise = new Promise((resolve) => { finish = resolve; });
      return Object.assign(promise, { pid: 123456, kill: () => { kill(); finish({ exitCode: 1, stdout: '', stderr: '' }); } });
    });
    await expect(aerender(tools, { aep, comp: 'Title', outPath: join(dir, 'out.mov'), startFrame: 0, endFrame: 1, omTemplate: 'ProRes', rsTemplate: 'Best Settings', timeoutMs: 10 }, { spawn: spawn as unknown as SpawnFn })).rejects.toThrow(/timed out/);
    expect(kill).toHaveBeenCalled();
    if (process.platform === 'win32') expect(spawn).toHaveBeenCalledWith('taskkill', expect.arrayContaining(['/T', '/F', '/PID', '123456']), expect.anything());
  });
  it('publishes exclusively and parses render progress', async () => {
    const { dir } = await setup();
    const from = join(dir, 'from'), to = join(dir, 'to');
    await writeFile(from, 'new'); await writeFile(to, 'old');
    await expect(moveFile(from, to)).rejects.toThrow(/overwrite/);
    expect(await readFile(to, 'utf8')).toBe('old');
    const parser = createProgressParser();
    parser.feed('PROGRESS: Duration: 0:00:01:00');
    parser.feed('PROGRESS: Frame Rate: 25');
    expect(parser.feed('PROGRESS: 0:00:00:10 (11)')).toMatchObject({ done: 11, total: 25 });
  });
  it('preserves optional comp audio and bounds fallback conversion with cancellation', async () => {
    const { dir, tools } = await setup();
    const controller = new AbortController();
    const dst = join(dir, 'fallback.mov');
    const spawn = vi.fn(async (_bin: string, args: string[], opts: { timeout?: number; cancelSignal?: AbortSignal }) => {
      expect(args).toEqual(expect.arrayContaining(['-map', '0:a:0?', '-c:a', 'pcm_s24le', '-n']));
      expect(args).not.toContain('-an');
      expect(opts.cancelSignal).toBe(controller.signal);
      expect(opts.timeout).toBeGreaterThan(0);
      await writeFile(dst, 'converted');
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    await transcodeToProres(tools, 'fake.avi', dst, spawn as unknown as SpawnFn, controller.signal);
  });
  it('passes Thai comp names and project paths verbatim as an argv array, with the display-start offset', async () => {
    const { dir, tools, spawn } = await setup();
    const aep = join(dir, 'โปรเจกต์ ทดสอบ.aep');
    await writeFile(aep, 'fake');
    const comp = 'คอมพ์ ไทย "หลัก" & | %PATH%';
    await aerender(tools, { aep, comp, outPath: join(dir, 'ผลลัพธ์.mov'), startFrame: 10, endFrame: 11, frameOffset: 90000, mfrPercent: 90, omTemplate: 'ProRes', rsTemplate: 'Best Settings' }, { spawn: spawn as unknown as SpawnFn });
    const [bin, args, options] = spawn.mock.calls[0]! as unknown as [string, string[], Record<string, unknown>];
    expect(bin).toBe('aerender.exe');
    expect(args[args.indexOf('-project') + 1]).toBe(aep);
    expect(args[args.indexOf('-comp') + 1]).toBe(comp);
    expect(args).toEqual(expect.arrayContaining(['-s', '90010', '-e', '90011', '-mfr', 'ON', '90']));
    expect(options.shell).toBeUndefined();
  });
  it('requires an explicit frame range and checks the count against it, not aerender\'s Duration line', async () => {
    const { dir, aep, tools, spawn } = await setup();
    const base = { aep, comp: 'Title', outPath: join(dir, 'out.mov'), omTemplate: 'ProRes', rsTemplate: 'Best Settings' };
    await expect(aerender(tools, base, { spawn: spawn as unknown as SpawnFn })).rejects.toThrow(/explicit/);
    expect(spawn).not.toHaveBeenCalled();
    // aerender reports a 2-frame Duration (work area) and ffprobe agrees, but the comp range is 5 frames.
    await expect(aerender(tools, { ...base, startFrame: 0, endFrame: 4 }, { spawn: spawn as unknown as SpawnFn })).rejects.toThrow(/got 2, expected 5/);
  });
  it('deletes partial aer_* temp files after failed, mismatched and timed-out renders', async () => {
    const { dir, aep, tools } = await setup();
    const out = join(dir, 'renders');
    await mkdir(out);
    const leftovers = async () => (await readdir(out)).filter((f) => f.startsWith('aer_'));
    const failing = vi.fn(async (_bin: string, args: string[]) => {
      await writeFile(args[args.indexOf('-output') + 1]!, 'partial');
      return { exitCode: 1, stdout: 'aerender ERROR: render failed', stderr: '' };
    });
    const req = { aep, comp: 'Title', outPath: join(out, 'x.mov'), startFrame: 0, endFrame: 9, omTemplate: 'ProRes', rsTemplate: 'Best Settings' };
    await expect(aerender(tools, req, { spawn: failing as unknown as SpawnFn })).rejects.toThrow(/exited with code 1/);
    expect(await leftovers()).toEqual([]);
    const { spawn } = await setup();
    await expect(aerender(tools, req, { spawn: spawn as unknown as SpawnFn })).rejects.toThrow(/mismatch/);
    expect(await leftovers()).toEqual([]);
    const hanging = vi.fn((bin: string, args: string[]) => {
      if (bin === 'taskkill') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      let finish: (value: unknown) => void;
      const promise = new Promise((resolve) => { finish = resolve; });
      void writeFile(args[args.indexOf('-output') + 1]!, 'partial');
      return Object.assign(promise, { pid: 654321, kill: () => finish({ exitCode: 1, stdout: '', stderr: '' }) });
    });
    await expect(aerender(tools, { ...req, timeoutMs: 50 }, { spawn: hanging as unknown as SpawnFn })).rejects.toThrow(/timed out/);
    expect(await leftovers()).toEqual([]);
  });
  it('recognizes only aerender\'s missing output-module template error', () => {
    const missing = new AerenderError('x', 'exit', ['aerender ERROR: No output module template was found with the given name.']);
    expect(isMissingOmTemplate(missing)).toBe(true);
    expect(isMissingOmTemplate(new AerenderError('x', 'timeout', missing.errors))).toBe(false);
    expect(isMissingOmTemplate(new AerenderError('x', 'abort', missing.errors))).toBe(false);
    expect(isMissingOmTemplate(new Error('aerender ERROR: No output module template was found'))).toBe(false);
    const comp = 'output module template not found';
    const named = new AerenderError(`aerender exited\n$ aerender -comp "${comp}"`, 'exit', [`aerender ERROR: Unable to render comp ${comp}: disk full`]);
    expect(isMissingOmTemplate(named, [comp])).toBe(false);
    const quoted = new AerenderError('x', 'exit', ['aerender ERROR: comp "missing output module template invalid" crashed']);
    expect(isMissingOmTemplate(quoted)).toBe(false);
  });
  it('uses -mfr 90 with plenty of RAM and less when memory is low', () => {
    expect(defaultMfrPercent(32)).toBe(90);
    expect(defaultMfrPercent(6)).toBeLessThan(90);
    expect(defaultMfrPercent(1)).toBeLessThan(defaultMfrPercent(6));
  });
  it('transcodes RGB to BT.709 limited-range ProRes with matching color tags (real ffmpeg)', async () => {
    const tools = discoverTools();
    const { dir } = await setup();
    // 10-bit limited-range BT.709 Y'CbCr of pure primaries.
    const expectFor = (r: number, g: number, b: number) => {
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      return [64 + 876 * y, 512 + 896 * (b - y) / 1.8556, 512 + 896 * (r - y) / 1.5748];
    };
    for (const [hex, rgb] of [['FF0000', [1, 0, 0]], ['00FF00', [0, 1, 0]], ['0000FF', [0, 0, 1]]] as const) {
      const src = join(dir, `${hex}.mov`), dst = join(dir, `${hex}_prores.mov`), raw = join(dir, `${hex}.yuv`);
      await execa(tools.ffmpeg, ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', `color=c=0x${hex}:s=64x64:r=25:d=0.2`, '-vf', 'format=rgb24', '-c:v', 'qtrle', src], { windowsHide: true, timeout: 60_000 });
      await transcodeToProres(tools, src, dst);
      const probe = JSON.parse((await execa(tools.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', dst], { windowsHide: true, timeout: 60_000 })).stdout).streams[0];
      expect(probe).toMatchObject({ codec_name: 'prores', pix_fmt: 'yuv422p10le', color_space: 'bt709', color_primaries: 'bt709', color_transfer: 'bt709', color_range: 'tv' });
      await execa(tools.ffmpeg, ['-v', 'error', '-nostdin', '-y', '-i', dst, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv422p10le', raw], { windowsHide: true, timeout: 60_000 });
      const buf = await readFile(raw);
      const w = 64, h = 64, ySize = w * h * 2, cSize = (w / 2) * h * 2;
      const got = [buf.readUInt16LE((32 * w + 32) * 2), buf.readUInt16LE(ySize + (32 * (w / 2) + 16) * 2), buf.readUInt16LE(ySize + cSize + (32 * (w / 2) + 16) * 2)];
      const want = expectFor(rgb[0], rgb[1], rgb[2]);
      for (let i = 0; i < 3; i++) expect(Math.abs(got[i]! - want[i]!), `${hex} component ${i}: got ${got[i]} want ${want[i]!.toFixed(1)}`).toBeLessThanOrEqual(4);
    }
  });
});
