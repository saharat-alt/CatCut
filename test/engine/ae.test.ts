import { afterEach, describe, expect, it, vi } from 'vitest';
import { constants } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { createAeBackend } from '../../src/engine/ae.js';
import type { SpawnFn } from '../../src/engine/aerender.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup() {
  const dir = await mkdtemp(join(os.tmpdir(), 'editmcp-ae-test-'));
  dirs.push(dir);
  const aep = join(dir, 'งาน.aep');
  await writeFile(aep, 'original');
  const comp = { id: 1, name: 'Title', width: 320, height: 180, fps: 25, durationFrames: 100, numLayers: 1, layers: [], snapshot: { text: 'สวัสดี' } };
  const spawn = vi.fn(async (_bin: string, args: string[]) => {
    expect(args.slice(0, 3)).toEqual(['-m', '-noui', '-r']);
    const launcher = await readFile(args[3]!, 'utf8');
    const jobPath = JSON.parse(launcher.match(/var EDITMCP_JOB = (.*);/)![1]!);
    const job = JSON.parse(await readFile(jobPath, 'utf8'));
    if (job.action === 'edit') {
      expect(job.aep).not.toBe(aep);
      await writeFile(job.aep, 'edited');
    }
    const data = job.action === 'version' ? '26.0' : job.action === 'list' ? [comp] : job.action === 'fingerprint' ? { Title: comp.snapshot } : comp;
    await writeFile(job.result, JSON.stringify({ ok: true, data, log: ['done'] }));
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  const backend = createAeBackend({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', afterfx: 'AfterFX.com' }, { spawn: spawn as unknown as SpawnFn, minFreeRamGb: 0 });
  return { dir, aep, spawn, backend, comp };
}

describe('headless AE backend (mock processes only)', () => {
  it('is lazy; lists, inspects and fingerprints using a UTF-8 file job', async () => {
    const { aep, spawn, backend } = await setup();
    expect(spawn).not.toHaveBeenCalled();
    expect((await backend.listComps(aep))[0]?.name).toBe('Title');
    const detail = await backend.inspectComp(aep, 'Title');
    expect(detail.fingerprint).toMatch(/^[a-f0-9]{40}$/);
    expect((await backend.fingerprint(aep, ['Title'])).Title).toBe(detail.fingerprint);
    expect(await backend.version()).toBe('26.0');
  });
  it('edits a working copy, backs up the source, and never overwrites saveAs', async () => {
    const { dir, aep, backend } = await setup();
    const result = await backend.edit({ aep, comp: 'Title', ops: [{ op: 'setText', layer: 'Text', text: 'ใหม่' }] });
    expect(result.ok).toBe(true);
    expect(await readFile(aep, 'utf8')).toBe('edited');
    const backup = result.log.find((l) => l.startsWith('backup: '))!.slice(8);
    expect(await readFile(backup, 'utf8')).toBe('original');
    const saveAs = join(dir, 'copy.aep');
    await copyFile(aep, saveAs, constants.COPYFILE_EXCL);
    await expect(backend.edit({ aep, comp: 'Title', ops: [], saveAs })).rejects.toThrow(/exist|overwrite/);
  });
  it('keeps the original intact on AE failure or concurrent source changes', async () => {
    const { aep, spawn, backend } = await setup();
    spawn.mockImplementationOnce(async () => ({ exitCode: 1, stdout: '', stderr: 'bad effect' }));
    await expect(backend.edit({ aep, comp: 'Title', ops: [] })).rejects.toThrow(/bad effect/);
    expect(await readFile(aep, 'utf8')).toBe('original');
    const run = spawn.getMockImplementation()!;
    spawn.mockImplementationOnce(async (bin, args) => { const r = await run(bin, args); await writeFile(aep, 'changed externally'); return r; });
    await expect(backend.edit({ aep, comp: 'Title', ops: [] })).rejects.toThrow(/changed/);
    expect(await readFile(aep, 'utf8')).toBe('changed externally');
  });
  it('reports missing AE only when a command is used', async () => {
    const backend = createAeBackend({ ffmpeg: '', ffprobe: '' });
    await expect(backend.version()).rejects.toThrow(/AfterFX/);
  });
  it('invalidates expressions, proxies and changes to later image-sequence frames', async () => {
    const { dir, aep, comp, backend } = await setup();
    const first = join(dir, 'frame001.png'), later = join(dir, 'frame002.png'), proxy = join(dir, 'proxy.mov');
    await writeFile(first, 'first'); await writeFile(later, 'later'); await writeFile(proxy, 'proxy');
    const snapshot = { projectDependency: true, sequenceSource: { file: first, sequence: true }, proxy: { file: proxy } };
    Object.assign(comp, { snapshot });
    const a = (await backend.fingerprint(aep)).Title;
    await writeFile(later, 'changed later frame');
    const b = (await backend.fingerprint(aep)).Title;
    expect(b).not.toBe(a);
    await writeFile(proxy, 'changed proxy');
    const c = (await backend.fingerprint(aep)).Title;
    expect(c).not.toBe(b);
    await writeFile(aep, 'external control comp changed');
    expect((await backend.fingerprint(aep)).Title).not.toBe(c);
  });
});
