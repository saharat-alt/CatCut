import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashJson } from '../../src/core/hash.js';
import { createProject, loadProject, saveProject } from '../../src/core/project.js';
import type { Project, Version } from '../../src/core/types.js';
import {
  diskReport, findAeDiskCache, gcApply, gcPlan, parseAePrefs, preflight, setVersionKeep,
  type GcPlan, type KeptVersion, type StatFsFn,
} from '../../src/engine/housekeeping.js';

const TMP_ROOT = path.join(process.cwd(), 'tmp', 'housekeeping-test');
const GB = 1024 ** 3;
let root: string;
beforeAll(async () => {
  mkdirSync(TMP_ROOT, { recursive: true });
  root = await mkdtemp(path.join(TMP_ROOT, 'h-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const statfsFree = (freeBytes: number): StatFsFn => async () => ({ bavail: freeBytes / 4096, bsize: 4096, blocks: (2000 * GB) / 4096 });
const OLD = new Date(Date.now() - 3 * 3600_000);

async function put(file: string, bytes: number, old = true): Promise<string> {
  mkdirSync(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(bytes, 1));
  if (old) await utimes(file, OLD, OLD);
  return file;
}

function version(p: Project, n: number, shots: string[]): Version {
  const id = `v${String(n).padStart(3, '0')}`;
  return {
    id, createdAt: new Date(Date.UTC(2026, 0, n)).toISOString(), planHash: id, master: path.join(p.dir, 'out', id, `t_${id}.mov`), deliverables: {},
    reviewPlan: { fps: 25, width: 64, height: 48, frames: 10 * shots.length, shots: shots.map((s, i) => ({ id: s, src: 'cam', start: i * 10, in: 0, dur: 10 })) },
    stats: { segmentsTotal: 0, segmentsRendered: 0, segmentsReused: 0, dissolvesRendered: 0, compsRendered: 0, compsReused: 0, timingsMs: {} },
  };
}

/** 5 versions; v001/v002 used clips old1/old2; v003..v005 use a/b. */
async function fixture(name: string): Promise<{ p: Project; outside: string; live: string[] }> {
  const p = await createProject(path.join(root, name), { name });
  p.assets = {
    cam: { id: 'cam', kind: 'camera', path: path.join(p.dir, 'footage', 'cam.mov') },
    t1: { id: 't1', kind: 'aecomp', aep: 'X:/g.aep', comp: 'T', render: { path: path.join(p.dir, 'cache', 'renders', 't1_new.mov'), frames: 10, fingerprint: 'n', renderedAt: '' } },
  };
  p.timeline.video = [{ id: 'a', src: 'cam', in: 0, dur: 10 }, { id: 'b', src: 'cam', in: 10, dur: 10 }];
  p.versions = [version(p, 1, ['old1']), version(p, 2, ['old1', 'old2']), version(p, 3, ['a']), version(p, 4, ['a', 'b']), version(p, 5, ['a', 'b'])];
  for (const v of p.versions) await put(v.master, 1000);
  await put(path.join(p.dir, 'out', 'v002', 't_v002_yt.mp4'), 500);
  const seg = path.join(p.dir, 'cache', 'segments');
  await put(path.join(seg, 'k_old1.mov'), 100);
  await put(path.join(seg, 'k_old2.mov'), 100);
  const live = [await put(path.join(seg, 'k_a.mov'), 100), await put(path.join(seg, 'k_b.mov'), 100), await put(path.join(seg, 'k_diss.mov'), 100)];
  await put(path.join(seg, 'stray.mov'), 50); // not in the manifest, old
  live.push(await put(path.join(seg, 'fresh.mov'), 50, false)); // not in the manifest, may belong to a running build
  await writeFile(path.join(seg, 'manifest.json'), JSON.stringify({
    schema: 1,
    entries: {
      k_old1: { file: 'k_old1.mov', frames: 10, kind: 'segment', mode: 'copy', clipId: 'old1', createdAt: '' },
      k_old2: { file: 'k_old2.mov', frames: 10, kind: 'segment', mode: 'copy', clipId: 'old2', createdAt: '' },
      k_a: { file: 'k_a.mov', frames: 10, kind: 'segment', mode: 'copy', clipId: 'a', createdAt: '' },
      k_b: { file: 'k_b.mov', frames: 10, kind: 'segment', mode: 'copy', clipId: 'b', createdAt: '' },
      k_diss: { file: 'k_diss.mov', frames: 4, kind: 'dissolve', mode: 'encode', createdAt: '' },
    },
  }));
  await put(path.join(p.dir, 'cache', 'renders', 't1_old.mov'), 300);
  live.push(await put(path.join(p.dir, 'cache', 'renders', 't1_new.mov'), 300));
  await put(path.join(p.dir, 'cache', 'tmp', 'abc.mov'), 70);
  await put(path.join(p.dir, 'out', 'v009', 'failed.mov'), 40); // folder with no version record
  const outside = await put(path.join(p.dir, 'footage', 'cam.mov'), 999);
  await saveProject(p);
  return { p, outside, live };
}

describe('gc plan', () => {
  it('lists only files inside cache/ and out/, keeps the latest N, keep-flagged versions and live cache', async () => {
    const { p, outside, live } = await fixture('plan');
    setVersionKeep(p, 'v001', true);
    const plan = await gcPlan(p, { keepLatest: 2 });
    const rels = plan.items.map((i) => i.rel.replace(/\\/g, '/')).sort();
    expect(rels).toEqual([
      'cache/renders/t1_old.mov',
      'cache/segments/k_old2.mov', // old2 only used by v002 (not kept); old1 is used by kept v001
      'cache/segments/stray.mov',
      'cache/tmp/abc.mov',
      'out/v002/t_v002.mov',
      'out/v002/t_v002_yt.mp4',
      'out/v003/t_v003.mov',
      'out/v009/failed.mov',
    ]);
    expect(plan.retainedVersions).toEqual(['v001', 'v004', 'v005']);
    expect(plan.keptUnknown).toBe(1); // the dissolve
    expect(plan.totalBytes).toBe(300 + 100 + 50 + 70 + 1000 + 500 + 1000 + 40);
    for (const it of plan.items) {
      const rel = path.relative(p.dir, it.path);
      expect(rel.startsWith('cache') || rel.startsWith('out')).toBe(true);
    }
    expect(plan.items.some((i) => i.path === outside)).toBe(false);
    for (const f of live) expect(plan.items.some((i) => i.path === f)).toBe(false);
    expect(existsSync(path.join(p.dir, 'cache', 'gc', `plan-${plan.planId}.json`))).toBe(true);
    // nothing deleted by planning
    expect(existsSync(path.join(p.dir, 'out', 'v002', 't_v002.mov'))).toBe(true);
  });

  it('exact referenced segment keys override the clip-id heuristic', async () => {
    const { p } = await fixture('plan-keys');
    const plan = await gcPlan(p, { keepLatest: 3, referencedSegmentKeys: new Set(['k_a', 'k_b']) });
    const segs = plan.items.filter((i) => i.reason === 'unused-segment').map((i) => path.basename(i.path)).sort();
    expect(segs).toEqual(['k_diss.mov', 'k_old1.mov', 'k_old2.mov']);
  });
});

describe('gc apply', () => {
  let p: Project;
  let plan: GcPlan;
  beforeEach(async () => {
    ({ p } = await fixture(`apply-${Math.random().toString(36).slice(2, 8)}`));
    plan = await gcPlan(p, { keepLatest: 3 });
  });

  it('refuses without the confirm token', async () => {
    await expect(gcApply(p, plan.planId, 'yes')).rejects.toThrow(/confirm/);
    await expect(gcApply(p, plan.planId, '')).rejects.toThrow(/confirm/);
    expect(existsSync(plan.items[0]!.path)).toBe(true);
  });

  it('refuses a stale plan', async () => {
    const later = new Date(Date.parse(plan.createdAt) + 11 * 60_000);
    await expect(gcApply(p, plan.planId, 'ลบ', { now: () => later })).rejects.toThrow(/10/);
    expect(plan.items.every((i) => existsSync(i.path))).toBe(true);
  });

  it('refuses a tampered plan and never deletes outside cache/ and out/', async () => {
    const file = path.join(p.dir, 'cache', 'gc', `plan-${plan.planId}.json`);
    const outside = path.join(p.dir, 'footage', 'cam.mov');
    const evil = path.join(root, 'victim.txt');
    await writeFile(evil, 'keep me');
    const tampered = { ...plan, items: [...plan.items, { path: outside, rel: path.relative(p.dir, outside), bytes: 999, mtimeMs: 0, reason: 'stale-temp' }] };
    await writeFile(file, JSON.stringify(tampered));
    await expect(gcApply(p, plan.planId, 'delete')).rejects.toThrow(/modified/);

    // even with a correctly re-hashed plan, per-file checks refuse paths outside cache/ and out/
    const { hash: _h, ...body } = tampered;
    void _h;
    const st = await import('node:fs/promises').then((m) => m.stat(outside));
    const evilSt = await import('node:fs/promises').then((m) => m.stat(evil));
    body.items = [
      ...plan.items,
      { path: outside, rel: path.relative(p.dir, outside), bytes: st.size, mtimeMs: st.mtimeMs, reason: 'stale-temp' },
      { path: evil, rel: path.relative(p.dir, evil), bytes: evilSt.size, mtimeMs: evilSt.mtimeMs, reason: 'stale-temp' },
      { path: path.join(p.dir, 'project.json'), rel: 'project.json', bytes: 1, mtimeMs: 0, reason: 'stale-temp' },
    ];
    await writeFile(file, JSON.stringify({ ...body, hash: hashJson(body) }));
    const r = await gcApply(p, plan.planId, 'delete');
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(evil)).toBe(true);
    expect(existsSync(path.join(p.dir, 'project.json'))).toBe(true);
    expect(r.skipped.filter((s) => s.reason.includes('outside')).length).toBe(3);
    expect(r.deleted.length).toBe(plan.items.length);
  });

  it('deletes the planned files, logs every path, marks purged versions, and is single-use', async () => {
    const changed = plan.items.find((i) => i.reason === 'stale-temp')!;
    await writeFile(changed.path, 'different size now');
    const r = await gcApply(p, plan.planId, 'ลบ');
    expect(r.skipped).toEqual([{ path: changed.path, reason: 'changed since the plan' }]);
    expect(existsSync(changed.path)).toBe(true);
    for (const d of r.deleted) expect(existsSync(d.path)).toBe(false);
    expect(r.freedBytes).toBe(plan.totalBytes - changed.bytes);
    expect(existsSync(path.join(p.dir, 'out', 'v002'))).toBe(false); // emptied folder removed
    expect(existsSync(path.join(p.dir, 'out'))).toBe(true);
    expect(r.purgedVersions).toEqual(['v001', 'v002']);
    expect((p.versions[0] as KeptVersion).purgedAt).toBeTruthy();
    const log = await readFile(r.log, 'utf8');
    expect(path.dirname(r.log)).toBe(path.join(p.dir, 'history'));
    for (const d of r.deleted) expect(log).toContain(d.path);
    expect(log).toContain('SKIPPED');
    await expect(gcApply(p, plan.planId, 'ลบ')).rejects.toThrow(/not found|ไม่พบ/);
    expect((await readdir(path.join(p.dir, 'cache', 'gc'))).some((f) => f.endsWith('.applied.json'))).toBe(true);
  });
});

describe('version keep', () => {
  it('persists the keep flag', async () => {
    const { p } = await fixture('keep');
    setVersionKeep(p, 'v002', true);
    await saveProject(p);
    const re = await loadProject(p.dir);
    expect((re.versions[1] as KeptVersion).keep).toBe(true);
    setVersionKeep(re, 'v002', false);
    expect((re.versions[1] as KeptVersion).keep).toBeUndefined();
    expect(() => setVersionKeep(re, 'v999', true)).toThrow();
  });
});

describe('preflight', () => {
  const p = { dir: 'D:\\proj' } as Project;
  it('errors below 5 GB left after the estimate, warns below 20 GB, silent above', async () => {
    expect(await preflight(p, 0, { statfs: statfsFree(100 * GB) })).toEqual([]);
    const warn = await preflight(p, 2 * GB, { statfs: statfsFree(21 * GB) });
    expect(warn.map((i) => [i.kind, i.severity])).toEqual([['disk', 'warn']]);
    const err = await preflight(p, 2 * GB, { statfs: statfsFree(6 * GB) });
    expect(err.map((i) => [i.kind, i.severity])).toEqual([['disk', 'error']]);
    expect((await preflight(p, 0, { statfs: statfsFree(4.9 * GB) }))[0]?.severity).toBe('error');
    expect(await preflight(p, 0, { statfs: statfsFree(20 * GB) })).toEqual([]);
  });

  it('checks extra drives without the estimate and reports unreadable drives', async () => {
    const statfs: StatFsFn = async (x) => ({ bavail: (x.toUpperCase().startsWith('C:') ? 3 * GB : 50 * GB) / 4096, bsize: 4096, blocks: 1 });
    const r = await preflight(p, 10 * GB, { statfs, extraPaths: ['C:\\Users\\x\\AppData\\Local\\Temp', 'D:\\other'] });
    expect(r).toHaveLength(1);
    expect(r[0]?.severity).toBe('error');
    expect(r[0]?.message).toContain('C:\\');
    const bad = await preflight(p, 0, { statfs: async () => { throw new Error('nope'); } });
    expect(bad[0]?.severity).toBe('warn');
  });
});

describe('AE disk cache + disk report', () => {
  it('parses AE prefs including continued strings', () => {
    const prefs = parseAePrefs([
      '["Disk Cache Controls"]',
      '\t"Enabled 2" = "1"',
      '\t"Folder 7" = "E:\\AE Cache\\very long"\\',
      '\t\t" folder"',
      '\t"Max Size 3" = "47"',
      '["Other"]',
      '\t"Flag" = 01',
    ].join('\r\n'));
    expect(prefs.get('Disk Cache Controls')?.get('Folder 7')).toBe('E:\\AE Cache\\very long folder');
    expect(prefs.get('Disk Cache Controls')?.get('Max Size 3')).toBe('47');
    expect(prefs.get('Other')?.has('Flag') ?? false).toBe(false); // unquoted hex values are ignored
  });

  it('finds the folder in the newest AE prefs, falls back to %LOCALAPPDATA%\\Temp, else unknown', async () => {
    const appdata = path.join(root, 'appdata');
    const cacheFolder = path.join(root, 'aecache');
    await put(path.join(appdata, 'Adobe', 'After Effects', '25.0', 'Adobe After Effects 25.0 Prefs.txt'), 0, false);
    await writeFile(path.join(appdata, 'Adobe', 'After Effects', '25.0', 'Adobe After Effects 25.0 Prefs.txt'), '["Disk Cache Controls"]\n\t"Folder 7" = "Z:\\old"\n');
    mkdirSync(path.join(appdata, 'Adobe', 'After Effects', '26.5'), { recursive: true });
    await writeFile(path.join(appdata, 'Adobe', 'After Effects', '26.5', 'Adobe After Effects 26.5 Prefs.txt'), `["Disk Cache Controls"]\n\t"Folder 7" = "${cacheFolder}"\n\t"Max Size 3" = "47"\n`, 'utf8');
    const found = await findAeDiskCache({ APPDATA: appdata });
    expect(found).toMatchObject({ folder: cacheFolder, source: 'prefs', aeVersion: '26.5', maxSizeGb: 47 });

    const local = path.join(root, 'local');
    mkdirSync(path.join(local, 'Temp'), { recursive: true });
    expect(await findAeDiskCache({ APPDATA: path.join(root, 'none'), LOCALAPPDATA: local })).toEqual({ folder: path.join(local, 'Temp'), source: 'default' });
    expect(await findAeDiskCache({})).toEqual({ source: 'unknown' });

    // disk report: sizes the "Disk Cache - <host>" folder only, project cache/out by version
    await put(path.join(cacheFolder, 'Adobe', 'After Effects', '26.5', 'Disk Cache - HOST.noindex', 'a.bin'), 1234, false);
    await put(path.join(cacheFolder, 'unrelated.bin'), 99999, false);
    const { p } = await fixture('report');
    setVersionKeep(p, 'v003', true);
    const rep = await diskReport(p, { statfs: statfsFree(42 * GB), env: { APPDATA: appdata } });
    expect(rep.aeCache.bytes).toBe(1234);
    expect(rep.aeCache.dirs).toHaveLength(1);
    expect(rep.drives[0]?.freeBytes).toBe(42 * GB);
    expect(rep.drives[0]?.for).toEqual(expect.arrayContaining(['project', 'ae-disk-cache']));
    expect(rep.project.out.byVersion['v002']).toBe(1500);
    expect(rep.project.out.orphans['v009']).toBe(40);
    expect(rep.project.cache.segments).toBeGreaterThanOrEqual(600);
    expect(rep.project.cache.renders).toBe(600);
    expect(rep.keptVersions).toEqual(['v003']);
  });
});
