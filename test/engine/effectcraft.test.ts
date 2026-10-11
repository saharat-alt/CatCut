import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AeBackend } from '../../src/core/types.js';
import { MockAeBackend } from '../../src/engine/ae.js';
import type { SpawnFn } from '../../src/engine/aerender.js';
import { createEffectCraftBackend, createMotionBackend, isEcProject } from '../../src/engine/effectcraft.js';

const T = 254_016_000_000; // ticks per second
const TOOLS = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', effectcraftCli: 'effectcraft-cli.exe' };

/** Minimal .ecproj (schema 2): Title (25 fps, 100 frames) uses a solid, a still and the Inner precomp; Other is unrelated. */
function project(logo: string, opts: { innerOpacity?: number; otherLabel?: string; expr?: string } = {}) {
  const comp = (id: number, name: string, seconds: number, layers: unknown[]) => ({
    id, name, label: 'Sandstone', comment: '', parent: null,
    kind: { type: 'Comp', width: 1920, height: 1080, frame_rate: { num: 25, den: 1 }, duration: seconds * T, display_start: 0, layers },
  });
  return {
    savedBy: '0.8.0', schema: 2, settings: { bit_depth: 'Bpc8' },
    items: {
      1: comp(1, 'Title', 4, [
        { id: 10, name: 'Logo', source: { type: 'Footage', item: 70 }, props: {} },
        { id: 11, name: 'Inner', source: { type: 'Comp', item: 71 }, props: {} },
        { id: 12, name: 'BG', source: { type: 'Solid', item: 3 }, props: opts.expr ? { opacity: { expression: opts.expr } } : {} },
      ]),
      3: { id: 3, name: 'BG', parent: 2, kind: { type: 'Solid', color: [0, 0, 1], width: 1920, height: 1080 } },
      70: { id: 70, name: 'logo.png', parent: null, kind: { type: 'Footage', path: logo, kind: 'Still' } },
      71: comp(71, 'Inner', 2, [{ id: 20, name: 'Text', source: { type: 'Text' }, props: { opacity: opts.innerOpacity ?? 100 } }]),
      72: { ...comp(72, 'Other', 1, []), label: opts.otherLabel ?? 'Red' },
    },
    next_id: 80,
  };
}

async function setup(spawnImpl?: (bin: string, args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>) {
  const dir = await mkdtemp(join(os.tmpdir(), 'catcut-ec-test-'));
  const logo = join(dir, 'logo.png');
  await writeFile(logo, 'png-v1');
  const ecproj = join(dir, 'งาน', 'title.ecproj');
  await mkdir(join(dir, 'งาน'), { recursive: true });
  await writeFile(ecproj, JSON.stringify(project(logo)));
  const spawn = vi.fn(spawnImpl ?? (async (_bin: string, args: string[]) => {
    const i = args.indexOf('--out');
    if (i >= 0) await writeFile(args[i + 1]!, args[0] === 'render' ? 'mov' : 'png');
    return { exitCode: 0, stdout: 'done', stderr: '' };
  }));
  const backend = createEffectCraftBackend(TOOLS, { spawn: spawn as unknown as SpawnFn, minFreeRamGb: 0 });
  return { dir, logo, ecproj, spawn, backend };
}

/** A runner reply as ec-runner.jsx prints it. */
const reply = (r: unknown) => ({ exitCode: 0, stdout: `log line\n@@CATCUT@@${JSON.stringify(r)}\n"result"`, stderr: '' });

describe('EffectCraft backend: reads the .ecproj directly', () => {
  it('lists comps with fps and frame counts from ticks, without launching anything', async () => {
    const { ecproj, spawn, backend } = await setup();
    expect(await backend.listComps(ecproj)).toEqual([
      { id: 1, name: 'Title', width: 1920, height: 1080, fps: 25, durationFrames: 100, numLayers: 3 },
      { id: 71, name: 'Inner', width: 1920, height: 1080, fps: 25, durationFrames: 50, numLayers: 1 },
      { id: 72, name: 'Other', width: 1920, height: 1080, fps: 25, durationFrames: 25, numLayers: 0 },
    ]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fingerprints the comp closure: precomps, solids, footage content, expression-referenced comps — not unrelated items', async () => {
    const { ecproj, logo, backend, spawn } = await setup();
    const fp = async () => (await backend.fingerprint(ecproj, ['Title']))['Title'];
    const base = await fp();
    expect(base).toMatch(/^[0-9a-f]+$/);
    expect(await fp()).toBe(base);
    await writeFile(ecproj, JSON.stringify(project(logo, { otherLabel: 'Blue' })));
    expect(await fp()).toBe(base); // unrelated comp
    await writeFile(ecproj, JSON.stringify(project(logo, { innerOpacity: 50 })));
    const precomp = await fp();
    expect(precomp).not.toBe(base); // precomp content
    await writeFile(ecproj, JSON.stringify(project(logo)));
    await writeFile(logo, 'png-v2');
    expect(await fp()).not.toBe(base); // footage bytes
    await writeFile(logo, 'png-v1');
    await writeFile(ecproj, JSON.stringify(project(logo, { expr: 'comp("Other").layer(1).opacity' })));
    const withExpr = await fp();
    await writeFile(ecproj, JSON.stringify(project(logo, { expr: 'comp("Other").layer(1).opacity', otherLabel: 'Blue' })));
    expect(await fp()).not.toBe(withExpr); // Other is now a dependency
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses ambiguous comp names and missing projects', async () => {
    const { ecproj, logo, backend, dir } = await setup();
    const p = project(logo) as { items: Record<string, { name: string }> };
    p.items['72']!.name = 'Title';
    await writeFile(ecproj, JSON.stringify(p));
    await expect(backend.fingerprint(ecproj)).rejects.toThrow(/ambiguous comp name: Title/);
    await expect(backend.render({ aep: ecproj, comp: 'Title', outPath: join(dir, 'x.mov') })).rejects.toThrow(/ambiguous/);
    await expect(backend.listComps(join(dir, 'nope.ecproj'))).rejects.toThrow(/project not found/);
  });
});

describe('EffectCraft backend: render and preview', () => {
  it('renders ProRes 422 HQ by comp name with half-frame bounds, into a temp file moved to the target', async () => {
    const { ecproj, spawn, backend, dir } = await setup();
    const target = join(dir, 'cache', 'ชื่อไทย_title.mov');
    const res = await backend.render({ aep: ecproj, comp: 'Title', outPath: target, startFrame: 10, endFrame: 19 });
    expect(res).toMatchObject({ path: target, frames: 10, usedFallback: false });
    expect(await readFile(target, 'utf8')).toBe('mov');
    const [bin, args, opts] = spawn.mock.calls[0]! as unknown as [string, string[], Record<string, unknown>];
    expect(bin).toBe('effectcraft-cli.exe');
    expect(args.slice(0, 3)).toEqual(['render', '--project', ecproj]);
    expect(args).toEqual(expect.arrayContaining(['--comp', 'Title', '--format', 'prores', '--prores', 'hq', '--audio', 'off']));
    expect(args[args.indexOf('--start') + 1]).toBe('0.380000');
    expect(args[args.indexOf('--end') + 1]).toBe('0.780000');
    const tmp = args[args.indexOf('--out') + 1]!;
    expect(/^[\x00-\x7f]*$/.test(tmp)).toBe(true); // the CLI only ever sees an ASCII temp path
    expect(existsSync(tmp)).toBe(false); // temp folder cleaned up
    expect(opts['shell']).toBeUndefined();
  });

  it('renders the whole comp by default and never overwrites an existing output', async () => {
    const { ecproj, spawn, backend, dir } = await setup();
    const target = join(dir, 'title.mov');
    await writeFile(target, 'keep');
    const res = await backend.render({ aep: ecproj, comp: 'Title', outPath: target });
    expect(res.path).toBe(join(dir, 'title_2.mov'));
    expect(res.frames).toBe(100);
    expect(await readFile(target, 'utf8')).toBe('keep');
    const args = spawn.mock.calls[0]![1] as string[];
    expect(args[args.indexOf('--start') + 1]).toBe('0.000000'); // clamped at 0
    expect(args[args.indexOf('--end') + 1]).toBe('3.980000');
    await expect(backend.render({ aep: ecproj, comp: 'Title', outPath: target, endFrame: 100 })).rejects.toThrow(/past the end/);
  });

  it('reports a failed render with the CLI output', async () => {
    const { ecproj, backend, dir } = await setup(async () => ({ exitCode: 1, stdout: '', stderr: 'comp has an unsupported effect' }));
    await expect(backend.render({ aep: ecproj, comp: 'Title', outPath: join(dir, 'x.mov') })).rejects.toThrow(/EffectCraft render failed \(1\): comp has an unsupported effect/);
  });

  it('previews one frame by comp id and refuses frames past the end', async () => {
    const { ecproj, spawn, backend, dir } = await setup();
    const png = await backend.previewFrame(ecproj, 'Title', 37, join(dir, 'f.png'));
    expect(await readFile(png, 'utf8')).toBe('png');
    const args = spawn.mock.calls[0]![1] as string[];
    expect(args).toEqual(expect.arrayContaining(['render-frame', '--comp', '1', '--frame', '37']));
    await expect(backend.previewFrame(ecproj, 'Title', 100, join(dir, 'g.png'))).rejects.toThrow(/past the end/);
  });

  it('kills the process tree on timeout', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'catcut-ec-test-'));
    const ecproj = join(dir, 'p.ecproj');
    await writeFile(ecproj, JSON.stringify(project(join(dir, 'logo.png'))));
    let killed = false;
    const spawn = vi.fn((bin: string) => {
      if (bin === 'taskkill') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      let done: (v: unknown) => void = () => {};
      const child = new Promise((r) => { done = r; }) as Promise<unknown> & { pid: number; kill: () => void };
      child.pid = 4242;
      child.kill = () => { killed = true; done({ exitCode: null, stdout: '', stderr: '' }); };
      return child;
    });
    const backend = createEffectCraftBackend(TOOLS, { spawn: spawn as unknown as SpawnFn, minFreeRamGb: 0, timeoutMs: 30 });
    await expect(backend.inspectComp(ecproj, 'Title')).rejects.toThrow(/timed out after 30 ms \(process tree killed\)/);
    expect(killed).toBe(true);
    if (process.platform === 'win32') expect(spawn.mock.calls.some((c) => c[0] === 'taskkill')).toBe(true);
  });

  it('says what to install when the CLI is missing', async () => {
    const { ecproj, dir } = await setup();
    const backend = createEffectCraftBackend({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }, { minFreeRamGb: 0 });
    await expect(backend.render({ aep: ecproj, comp: 'Title', outPath: join(dir, 'x.mov') })).rejects.toThrow(/effectcraft-cli not found/);
  });
});

describe('EffectCraft backend: runner jobs (inspect / edit / create)', () => {
  it('inspect runs ec-runner.jsx on the project and adds the JSON fingerprint', async () => {
    const detail = { id: 1, name: 'Title', width: 1920, height: 1080, fps: 25, durationFrames: 100, numLayers: 3, layers: [] };
    let launch = '';
    const { ecproj, spawn, backend } = await setup(async (_bin, args) => { launch = await readFile(args[1]!, 'utf8'); return reply({ ok: true, data: detail, log: [] }); });
    const d = await backend.inspectComp(ecproj, 'Title', 12);
    expect(d).toMatchObject(detail);
    expect(d.fingerprint).toBe((await backend.fingerprint(ecproj, ['Title']))['Title']);
    const args = spawn.mock.calls[0]![1] as string[];
    expect(args[0]).toBe('script');
    expect(args[2]).toBe(ecproj);
    expect(args).not.toContain('--save');
    expect(launch).toMatch(/^var CATCUT_JOB = \{"action":"inspect","comp":"Title","atFrame":12\};\n/);
    expect(launch).toContain('@@CATCUT@@'); // the runner body follows
  });

  it('surfaces runner errors and refuses output without a result line', async () => {
    const { ecproj, backend } = await setup(async () => reply({ ok: false, data: null, error: 'Error: layer not found: Nope' }));
    await expect(backend.inspectComp(ecproj, 'Title')).rejects.toThrow(/EffectCraft: Error: layer not found: Nope/);
    const b2 = (await setup(async () => ({ exitCode: 0, stdout: 'TypeError at 3:4', stderr: '' }))).backend;
    await expect(b2.inspectComp(ecproj, 'Title')).rejects.toThrow(/no result from the runner/);
  });

  it('edit in place: works on a copy, keeps a backup, then replaces the source', async () => {
    const { ecproj, logo, backend, dir } = await setup(async (_bin, args) => {
      // the runner saves the working copy (--save); simulate a changed precomp
      await writeFile(args[2]!, JSON.stringify(project(logo, { innerOpacity: 20 })));
      return reply({ ok: true, data: {}, log: ['setText'] });
    });
    const before = (await backend.fingerprint(ecproj, ['Title']))['Title'];
    const res = await backend.edit({ aep: ecproj, comp: 'Title', ops: [{ op: 'setText', layer: 'Text', text: 'สวัสดี' }] });
    expect(res.savedTo).toBe(ecproj);
    expect(res.fingerprint).toBe((await backend.fingerprint(ecproj, ['Title']))['Title']);
    expect(res.fingerprint).not.toBe(before);
    const files = await readdir(join(dir, 'งาน'));
    expect(files.filter((f) => /^title_backup_\d+\.ecproj$/.test(f))).toHaveLength(1);
    expect(files.some((f) => f.startsWith('.catcut-'))).toBe(false);
  });

  it('edit with saveAs never overwrites and leaves the source alone; a failed edit changes nothing', async () => {
    const { ecproj, backend, dir } = await setup(async () => reply({ ok: true, data: {}, log: [] }));
    const original = await readFile(ecproj, 'utf8');
    const out = join(dir, 'งาน', 'title_v2.ecproj');
    await backend.edit({ aep: ecproj, comp: 'Title', ops: [], saveAs: out });
    expect(existsSync(out)).toBe(true);
    expect(await readFile(ecproj, 'utf8')).toBe(original);
    await expect(backend.edit({ aep: ecproj, comp: 'Title', ops: [], saveAs: out })).rejects.toThrow(/refusing to overwrite/);
    await expect(backend.edit({ aep: ecproj, comp: 'Title', ops: [], saveAs: join(dir, 'x.aep') })).rejects.toThrow(/\.ecproj/);
    const failing = (await setup(async () => reply({ ok: false, data: null, error: 'Error: boom' })));
    const src = await readFile(failing.ecproj, 'utf8');
    await expect(failing.backend.edit({ aep: failing.ecproj, comp: 'Title', ops: [] })).rejects.toThrow(/boom/);
    expect(await readFile(failing.ecproj, 'utf8')).toBe(src);
    expect((await readdir(join(failing.dir, 'งาน'))).sort()).toEqual(['title.ecproj']);
  });

  it('create runs the script in an empty project, saves to a temp name, then copies to a never-existing .ecproj', async () => {
    let launch = '';
    const { backend, spawn, dir, logo } = await setup(async (_bin, args) => {
      launch = await readFile(args[1]!, 'utf8');
      await writeFile(args[args.indexOf('--save-as') + 1]!, JSON.stringify(project(logo)));
      return reply({ ok: true, data: [], log: ['built'] });
    });
    const saveAs = join(dir, 'งาน', 'new.ecproj');
    const res = await backend.create!({ jsx: 'var c = app.project.items.addComp("Title", 1920, 1080, 1, 4, 25);\u2028L("ok");', saveAs, scriptDir: dir });
    expect(res.savedTo).toBe(saveAs);
    expect(res.comps.map((c) => c.name)).toEqual(['Title', 'Inner', 'Other']);
    expect(res.log).toEqual(['built']);
    const args = spawn.mock.calls[0]![1] as string[];
    expect(args).toContain('--empty');
    expect(args[args.indexOf('--save-as') + 1]).toMatch(/[\\/]\.catcut-[0-9a-f-]+\.ecproj$/);
    expect(launch.split('\n')[0]).toContain('\\u2028'); // escaped inside the job literal
    expect(launch.split('\n')[0]).toContain(JSON.stringify(dir).slice(1, -1));
    await expect(backend.create!({ jsx: '', saveAs })).rejects.toThrow(/refusing to overwrite/);
    await expect(backend.create!({ jsx: '', saveAs: join(dir, 'x.aep') })).rejects.toThrow(/\.ecproj/);
    expect((await readdir(join(dir, 'งาน'))).filter((f) => f.startsWith('.catcut-'))).toEqual([]);
  });
});

describe('motion router', () => {
  async function routed() {
    const { ecproj, backend: ec, spawn, dir } = await setup();
    const ae = new MockAeBackend({ comps: [{ name: 'AeTitle', durationFrames: 50, layers: [{ name: 'T', kind: 'text', text: 'hi' }] }] });
    const r = createMotionBackend(ae as unknown as AeBackend & Record<string, unknown>, ec) as AeBackend & { lintComp: AeBackend['lintComp']; purgeCaches: () => Promise<void> };
    return { r, ae, ecproj, spawn, dir };
  }

  it('routes .ecproj to EffectCraft and everything else to After Effects', async () => {
    const { r, ae, ecproj, dir } = await routed();
    expect(isEcProject(ecproj)).toBe(true);
    expect(isEcProject('C:\\x\\TITLE.ECPROJ')).toBe(true);
    expect(isEcProject('C:\\x\\title.aep')).toBe(false);
    expect((await r.listComps(ecproj)).map((c) => c.name)).toEqual(['Title', 'Inner', 'Other']);
    expect((await r.listComps(join(dir, 'a.aep'))).map((c) => c.name)).toEqual(['AeTitle']);
    await r.render({ aep: join(dir, 'a.aep'), comp: 'AeTitle', outPath: join(dir, 'ae.mov') });
    expect(ae.calls).toEqual(['listComps', 'render:AeTitle']);
    expect(r.kind).toBe('mock'); // reports keep the After Effects backend kind
  });

  it('keeps After Effects-only tools for .aep and refuses them for .ecproj', async () => {
    const { r, ae, ecproj, dir } = await routed();
    expect((await r.lintComp!(join(dir, 'a.aep'), 'AeTitle')).comp).toBe('AeTitle');
    await expect(Promise.resolve().then(() => r.lintComp!(ecproj, 'Title'))).rejects.toThrow(/lintComp is not available for EffectCraft projects/);
    await r.purgeCaches();
    expect(ae.purged).toBe(1);
  });

  it('create goes by the saveAs extension', async () => {
    const { r } = await routed();
    await expect(Promise.resolve().then(() => r.create!({ jsx: '', saveAs: 'C:\\x\\a.aep' }))).rejects.toThrow(/cannot create/); // the mock AE has no create
  });
});
