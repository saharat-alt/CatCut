import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { aerender, createProgressParser, moveFile, transcodeToProres, type SpawnFn } from '../../src/engine/aerender.js';

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
    await expect(aerender(tools, { aep, comp: 'Title', outPath: join(dir, 'out.mov'), omTemplate: 'ProRes', rsTemplate: 'Best Settings', timeoutMs: 10 }, { spawn: spawn as unknown as SpawnFn })).rejects.toThrow(/timed out/);
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
});
