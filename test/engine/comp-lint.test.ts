import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { JobManager } from '../../src/core/jobs.js';
import type { Project, StyleRules } from '../../src/core/types.js';
import { MockAeBackend, type MockComp } from '../../src/engine/ae.js';
import { auditFonts, compLintToQcIssues, compTargets, lintComps, listInstalledFonts, normalizeFontName, parseRegFonts } from '../../src/engine/comp-lint.js';
import type { AppState } from '../../src/mcp/state.js';
import { AE_TOOLS } from '../../src/mcp/tools-ae.js';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

const AEP = 'D:\\templates\\card.aep';

/** Card comp (250 f): Thai title animated by words stops at frame 30; full-frame BG ends at 200. */
function cardComp(text = 'สวัสดีครับ ทุกท่าน'): MockComp {
  return {
    name: 'Card', width: 1920, height: 1080, fps: 25, durationFrames: 250,
    layers: [
      { name: 'Title', kind: 'text', text, font: 'Kanit-Bold', fontSize: 40, lastKeyFrame: 30, animators: [{ name: 'Pop', basedOn: 'words' }] },
      { name: 'Photo', kind: 'footage', source: 'photo.mov', continuous: true },
      { name: 'BG', kind: 'solid', outFrame: 200, bounds: { x: 0, y: 0, w: 1, h: 1 } },
    ],
  };
}

function project(styleRules?: StyleRules, clipIn = 0, clipDur = 250): Project {
  return {
    meta: { name: 't', fps: 25, width: 1920, height: 1080, createdAt: '', schema: 1 },
    dir: 'D:\\proj',
    assets: { card: { id: 'card', kind: 'aecomp', aep: AEP, comp: 'Card' }, cam: { id: 'cam', kind: 'camera', path: 'D:\\a.mov' } },
    timeline: { video: [{ id: 'c0', src: 'cam', in: 0, dur: 100 }, { id: 'c1', src: 'card', in: clipIn, dur: clipDur }], cuts: [], audio: { vo: [], music: [], sfx: [] } },
    delivery: { targets: [] },
    versions: [],
    ...(styleRules ? { styleRules } : {}),
  };
}

describe('comp lint (MockAeBackend fixtures)', () => {
  it('reports stopped animation, early background and a Thai word animator, mapped to the clip', async () => {
    const ae = new MockAeBackend({ comps: [cardComp()] });
    const p = project();
    const report = await lintComps(ae, compTargets(p), p);
    expect(report.failed).toEqual([]);
    const byKind = Object.fromEntries(report.issues.map((i) => [i.kind + ':' + (i.message.match(/"([^"]+)"/)?.[1] ?? ''), i]));
    expect(byKind['comp:Title']).toMatchObject({ severity: 'warn', clipId: 'c1', startFrame: 130, endFrame: 350 });
    expect(byKind['comp:BG']).toMatchObject({ clipId: 'c1', startFrame: 300 });
    expect(byKind['thai:Title']).toMatchObject({ severity: 'warn', clipId: 'c1', startFrame: 100 });
    expect(report.issues.every((i) => i.message.startsWith('[Card]'))).toBe(true);
    expect(report.notes.join(' ')).toMatch(/thai-size skipped/);
  });
  it('English text with a word animator gets no Thai issue', async () => {
    const ae = new MockAeBackend({ comps: [cardComp('Hello everyone')] });
    const report = await lintComps(ae, [{ aep: AEP, comp: 'Card' }], project());
    expect(report.issues.map((i) => i.kind)).not.toContain('thai');
  });
  it('project rules decide: thai-size only with a threshold, animateBy from the brief, severity error only when asked', async () => {
    const ae = new MockAeBackend({ comps: [cardComp()] });
    // 40 px / 1080 = 3.7 % < 5 %
    const strict = project({ thai: { minCapHeightPct: 5, animateBy: 'word' }, severity: { 'background-ends-early': 'error' } } as StyleRules);
    const r = await lintComps(ae, [{ aep: AEP, comp: 'Card' }], strict);
    const thai = r.issues.filter((i) => i.kind === 'thai');
    expect(thai).toHaveLength(1);
    expect(thai[0]!.message).toMatch(/size/); // the word animator is what the brief asked for
    expect(r.issues.find((i) => i.message.includes('"BG"'))!.severity).toBe('error');
    expect(r.issues.find((i) => i.message.includes('stays visible'))!.severity).toBe('warn');
    const byLine = await lintComps(ae, [{ aep: AEP, comp: 'Card' }], project({ thai: { animateBy: 'line' } }));
    expect(byLine.issues.find((i) => i.kind === 'thai')!.message).toMatch(/project rule: animate by line/);
  });
  it('drops issues outside the part of the comp a clip shows, keeps comp-level issues when unused', () => {
    const lint = { comp: 'Card', issues: [
      { kind: 'background-ends-early' as const, layer: 'BG', frame: 200, message: '"BG" ends' },
      { kind: 'animation-ends-early' as const, layer: 'Title', frame: 30, message: '"Title" stops' },
    ] };
    // Clip shows comp frames 0..49: BG ends later (irrelevant); Title frozen 30..49 is < 1 s (irrelevant).
    expect(compLintToQcIssues(lint, AEP, project(undefined, 0, 50))).toEqual([]);
    expect(compLintToQcIssues(lint, AEP, project(undefined, 0, 120)).map((i) => i.message)).toEqual(['[Card] "Title" stops']);
    const unused = compLintToQcIssues(lint, 'D:\\other.aep', project());
    expect(unused.map((i) => i.clipId)).toEqual([undefined, undefined]);
    expect(unused[0]!.message).toMatch(/comp frame 200/);
  });
  it('collects per-comp failures instead of throwing', async () => {
    const report = await lintComps(new MockAeBackend({ comps: [] }), [{ aep: AEP, comp: 'Missing' }]);
    expect(report.failed).toEqual([{ aep: AEP, comp: 'Missing', error: 'comp not found: Missing' }]);
  });
});

describe('font audit (injected registry and folders)', () => {
  const REG = [
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
    '    Arial (TrueType)    REG_SZ    arial.ttf',
    '    Arial Bold (TrueType)    REG_SZ    arialbd.ttf',
    '    Cambria & Cambria Math (TrueType)    REG_SZ    cambria.ttc',
    '',
  ].join('\r\n');
  const USER = '    Kanit Regular (TrueType)    REG_SZ    C:\\Users\\me\\AppData\\Local\\Microsoft\\Windows\\Fonts\\Kanit-Regular.ttf\r\n';
  const sources = {
    regQuery: async (key: string) => (key.startsWith('HKLM') ? REG : USER),
    readDir: async (dir: string) => (dir.toLowerCase().includes('adobe') ? ['MinionPro-Regular.otf', 'readme.txt'] : []),
    env: { WINDIR: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', CommonProgramFiles: 'C:\\Program Files\\Common Files' },
  };
  it('parses reg query output', () => {
    expect(parseRegFonts(REG)).toEqual([{ name: 'Arial (TrueType)', file: 'arial.ttf' }, { name: 'Arial Bold (TrueType)', file: 'arialbd.ttf' }, { name: 'Cambria & Cambria Math (TrueType)', file: 'cambria.ttc' }]);
    expect(normalizeFontName('Kanit Bold (TrueType)')).toBe('kanitbold');
  });
  it('matches PostScript names loosely and lists missing fonts', async () => {
    const installed = await listInstalledFonts(sources);
    expect(installed.sources.join('\n')).toMatch(/HKLM.*\(3\)[\s\S]*HKCU.*\(1\)[\s\S]*Adobe.*\(1\)/);
    const audit = auditFonts({ fonts: ['ArialMT', 'Arial-BoldMT', 'CambriaMath', 'Kanit-Regular', 'Kanit-Bold', 'MinionPro-Regular', 'Sarabun-Light'], aeMissing: null }, installed);
    expect(audit.missing).toEqual(['Sarabun-Light']);
    expect(audit.familyOnly).toEqual([{ font: 'Kanit-Bold', family: 'Kanit' }]);
    const withAe = auditFonts({ fonts: ['ArialMT'], aeMissing: ['ThaiSansNeue-Bold'] }, installed);
    expect(withAe.missing).toEqual(['ThaiSansNeue-Bold']);
  });
});

describe('AE analysis tools (MockAeBackend, real job manager)', () => {
  async function state() {
    const dir = await mkdtemp(join(os.tmpdir(), 'editmcp-tools-ae-'));
    dirs.push(dir);
    const aep = join(dir, 'เทมเพลต.aep');
    await writeFile(aep, 'template');
    const p = { ...project(), dir };
    p.assets.card = { id: 'card', kind: 'aecomp', aep, comp: 'Card' };
    const ae = new MockAeBackend({ comps: [cardComp(), { name: 'Unused', durationFrames: 0, layers: [] }] });
    const s = { ae, jobs: new JobManager(), project: p, problems: [] } as unknown as AppState;
    return { dir, aep, ae, s };
  }
  const call = (name: string, args: Record<string, unknown>, s: AppState) =>
    (AE_TOOLS.find((t) => t.name === name)!.handler as unknown as (a: unknown, st: AppState) => Promise<Record<string, unknown>>)(args, s);

  it('registers the four tools', () => {
    expect(AE_TOOLS.map((t) => t.name)).toEqual(['template_scan', 'comp_lint', 'font_audit', 'ae_purge_cache']);
  });
  it('template_scan renders strips into review/templates/<slug>/ without overwriting', async () => {
    const { dir, aep, s, ae } = await state();
    const first = await call('template_scan', { aep, renderStrips: true, framesPerComp: 2 }, s);
    const strips = first.strips as Array<{ comp: string; paths: string[]; frames: number[] }>;
    expect(strips).toHaveLength(1);
    expect(strips[0]).toMatchObject({ comp: 'Card', frames: [62, 187] });
    expect(strips[0]!.paths.every((x) => x.startsWith(join(dir, 'review', 'templates')) && existsSync(x))).toBe(true);
    const second = await call('template_scan', { aep, renderStrips: true, framesPerComp: 2 }, s);
    const again = (second.strips as typeof strips)[0]!.paths;
    expect(again.some((x) => strips[0]!.paths.includes(x))).toBe(false);
    expect(first.advisory).toMatch(/brief/);
    expect(ae.calls.filter((c) => c.startsWith('previewFrame'))).toHaveLength(4);
  });
  it('comp_lint lints timeline comps or a single aep+comp', async () => {
    const { aep, s } = await state();
    const all = await call('comp_lint', {}, s);
    expect((all.issues as unknown[]).length).toBe(3);
    expect(all.ok).toBe(true);
    const one = await call('comp_lint', { aep, comp: 'Card' }, s);
    expect((one.comps as Array<{ comp: string }>)[0]!.comp).toBe('Card');
    await expect(call('comp_lint', { aep }, s)).rejects.toThrow(/both aep and comp/);
  });
  it('ae_purge_cache purges when asked and respects ifBelowGb', async () => {
    const { s, ae } = await state();
    expect(await call('ae_purge_cache', { ifBelowGb: 1e-9 }, s)).toMatchObject({ purged: false });
    expect(ae.purged).toBe(0);
    expect(await call('ae_purge_cache', {}, s)).toMatchObject({ purged: true, ok: true });
    expect(ae.purged).toBe(1);
  });
});
