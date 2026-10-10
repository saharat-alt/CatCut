import { execa } from 'execa';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProject, loadProject, saveProject } from '../../src/core/project.js';
import {
  addConstraint, checkRules, costNotice, evidenceFrames, extractEvidence, listConstraints, removeConstraint,
  RuleConflictError, rulesForAgent, setStyleRules, type StyleRulesRecord,
} from '../../src/core/rules.js';
import { findFfmpeg } from '../../src/core/tools.js';
import type { Board, Clip, Project, Version } from '../../src/core/types.js';

const TMP_ROOT = path.join(process.cwd(), 'tmp', 'rules-test');
let root: string;
beforeAll(async () => {
  mkdirSync(TMP_ROOT, { recursive: true });
  root = await mkdtemp(path.join(TMP_ROOT, 'r-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function memProject(clips: Clip[] = [], extra: Partial<Project> = {}): Project {
  return {
    meta: { name: 't', fps: 25, width: 1920, height: 1080, createdAt: '2026-01-01T00:00:00Z', schema: 1 },
    dir: path.join(root, 'mem'),
    assets: {
      cam: { id: 'cam', kind: 'camera', path: 'D:/x/cam.mov' },
      cam2: { id: 'cam2', kind: 'camera', path: 'D:/x/cam2.mov' },
      title: { id: 'title', kind: 'aecomp', aep: 'D:/x/gfx.aep', comp: 'Title_Card' },
      titleDup: { id: 'titleDup', kind: 'aecomp', aep: 'D:/x/gfx.aep', comp: 'Title_Card' },
      endlogo: { id: 'endlogo', kind: 'aecomp', aep: 'D:/x/gfx.aep', comp: 'End_Logo' },
      plate: { id: 'plate', kind: 'still', path: 'D:/x/plate.png' },
    },
    timeline: { video: clips, cuts: [], audio: { vo: [], music: [], sfx: [] } },
    delivery: { targets: [] },
    versions: [],
    ...extra,
  };
}

const board: Board = {
  source: 'D:/x/board.pdf',
  importedAt: '2026-01-01T00:00:00Z',
  slots: [{ id: '01', order: 1 }, { id: '02', order: 2 }, { id: '03', order: 3, notes: 'โลโก้ปิดท้าย' }],
};

describe('constraints', () => {
  it('adds, lists, removes and persists through saveProject/loadProject', async () => {
    const p = await createProject(path.join(root, 'persist'), { name: 'persist' });
    const a = addConstraint(p, { text: 'ใช้เฉพาะ element ในบอร์ด', source: 'brief', quote: 'ใช้เฉพาะ element ในบอร์ดเท่านั้น', check: 'board-only' });
    const b = addConstraint(p, { text: 'โลโก้นิ่ง', source: 'user', quote: 'โลโก้ไม่ต้องขยับ', check: 'logo-static', scope: 'endlogo' });
    expect(a.constraint.id).toBe('c1');
    expect(b.constraint.id).toBe('c2');
    expect(a.constraint.source).toBe('brief');
    expect(a.constraint.quote).toContain('บอร์ด');
    expect(listConstraints(p)).toHaveLength(2);
    await saveProject(p);

    const re = await loadProject(p.dir);
    expect(listConstraints(re).map((c) => [c.id, c.text, c.source, c.quote, c.check])).toEqual([
      ['c1', 'ใช้เฉพาะ element ในบอร์ด', 'brief', 'ใช้เฉพาะ element ในบอร์ดเท่านั้น', 'board-only'],
      ['c2', 'โลโก้นิ่ง', 'user', 'โลโก้ไม่ต้องขยับ', 'logo-static'],
    ]);
    removeConstraint(re, 'c2');
    setStyleRules(re, { cornerRadiusPct: 4 }, { source: 'brief', quote: 'มุมมน 4%' });
    await saveProject(re);
    const again = await loadProject(p.dir);
    expect(listConstraints(again).map((c) => c.id)).toEqual(['c1']);
    expect(again.styleRules?.cornerRadiusPct).toBe(4);
  });

  it('requires a source quote and rejects duplicate ids', () => {
    const p = memProject();
    expect(() => addConstraint(p, { text: 'x', source: 'user', quote: '  ' })).toThrow();
    addConstraint(p, { text: 'x', source: 'user', quote: 'q', id: 'k' });
    expect(() => addConstraint(p, { text: 'y', source: 'user', quote: 'q', id: 'k' })).toThrow(/exists/);
  });

  it('a brief rule cannot be removed without the user, and a competing user rule warns', () => {
    const p = memProject();
    addConstraint(p, { text: 'ใช้เฉพาะในบอร์ด', source: 'brief', quote: 'บอร์ด', check: 'board-only', id: 'b1' });
    const w = addConstraint(p, { text: 'ใส่ช็อตนอกบอร์ดได้', source: 'user', quote: 'เพิ่มได้', check: 'board-only' });
    expect(w.warnings.join(' ')).toMatch(/b1/);
    expect(() => removeConstraint(p, 'b1')).toThrow(RuleConflictError);
    expect(removeConstraint(p, 'b1', { userConfirmed: true }).id).toBe('b1');
  });
});

describe('style rules', () => {
  it('validates and merges, recording the source of every field', () => {
    const p = memProject();
    setStyleRules(p, { cornerRadiusPct: 3, palette: ['#00aaff', '#FFF'], joins: [{ from: 'card', to: 'footage', dissolve: 10 }], thai: { minWeight: 600 } }, { source: 'brief', quote: 'บรีฟหน้า 2' });
    const r = setStyleRules(p, { safeMarginPct: 5, joins: [{ from: 'card', to: 'footage', dissolve: 10 }, { from: 'footage', to: 'footage', dissolve: 0 }], thai: { animateBy: 'line' } }, { source: 'user', quote: 'ขอบ 5%' });
    expect(r.changed.sort()).toEqual(['joins:footage>footage', 'safeMarginPct', 'thai.animateBy']);
    const s = p.styleRules as StyleRulesRecord;
    expect(s.cornerRadiusPct).toBe(3);
    expect(s.palette).toEqual(['#00AAFF', '#FFF']);
    expect(s.joins).toHaveLength(2);
    expect(s.thai).toEqual({ minWeight: 600, animateBy: 'line' });
    expect(s.sources?.['cornerRadiusPct']?.source).toBe('brief');
    expect(s.sources?.['safeMarginPct']?.quote).toBe('ขอบ 5%');

    // null removes (brief source, so no conflict)
    setStyleRules(p, { palette: null }, { source: 'brief', quote: 'ไม่กำหนดสี' });
    expect(p.styleRules?.palette).toBeUndefined();
    expect((p.styleRules as StyleRulesRecord).sources?.['palette']).toBeUndefined();
  });

  it('rejects bad values and unknown keys', () => {
    const p = memProject();
    const meta = { source: 'user' as const, quote: 'q' };
    expect(() => setStyleRules(p, { palette: ['blue'] }, meta)).toThrow();
    expect(() => setStyleRules(p, { cornerRadius: 3 }, meta)).toThrow();
    expect(() => setStyleRules(p, { safeMarginPct: -1 }, meta)).toThrow();
    expect(() => setStyleRules(p, { joins: [{ from: 'a', to: 'b', dissolve: 2.5 }] }, meta)).toThrow();
    expect(p.styleRules).toBeUndefined();
  });

  it('a user change to a brief value needs overrideBrief', () => {
    const p = memProject();
    setStyleRules(p, { cornerRadiusPct: 3 }, { source: 'brief', quote: 'บรีฟ' });
    expect(() => setStyleRules(p, { cornerRadiusPct: 6 }, { source: 'user', quote: 'มนกว่านี้' })).toThrow(RuleConflictError);
    expect(p.styleRules?.cornerRadiusPct).toBe(3);
    setStyleRules(p, { cornerRadiusPct: 6 }, { source: 'user', quote: 'มนกว่านี้', overrideBrief: true });
    expect(p.styleRules?.cornerRadiusPct).toBe(6);
    expect((p.styleRules as StyleRulesRecord).sources?.['cornerRadiusPct']?.source).toBe('user');
  });
});

describe('machine checks', () => {
  it('board-only: flags clips without a slot and slots missing from the board', () => {
    const p = memProject([
      { id: 'a', src: 'cam', in: 0, dur: 50, slot: '01' },
      { id: 'b', src: 'cam', in: 50, dur: 50 },
      { id: 'c', src: 'cam2', in: 0, dur: 25, slot: '99' },
    ], { board });
    addConstraint(p, { text: 'ใช้เฉพาะ element ในบอร์ด', source: 'brief', quote: 'q', check: 'board-only' });
    const r = checkRules(p);
    expect(r.issues.map((i) => [i.clipId, i.severity, i.kind])).toEqual([['b', 'warn', 'style'], ['c', 'error', 'style']]);
    expect(r.issues[1]?.startFrame).toBe(100);
    expect(r.issues[1]?.endFrame).toBe(125);

    const noBoard = memProject(p.timeline.video);
    noBoard.constraints = p.constraints;
    const s = checkRules(noBoard);
    expect(s.issues).toEqual([]);
    expect(s.skipped.join(' ')).toMatch(/board/);
  });

  it('logo-static: logo clips (by scope or by name/slot notes) must not move', () => {
    const clips: Clip[] = [
      { id: 'a', src: 'cam', in: 0, dur: 50, speed: { rate: 0.5 } },
      { id: 'b', src: 'endlogo', in: 0, dur: 50, pushIn: 8 },
      { id: 'c', src: 'plate', in: 0, dur: 50, slot: '03', speed: { rate: 1, rampFrom: 0.5, rampFrames: 10 } },
      { id: 'd', src: 'title', in: 0, dur: 50, pushIn: 5 },
    ];
    const p = memProject(clips, { board });
    addConstraint(p, { text: 'โลโก้นิ่ง', source: 'user', quote: 'โลโก้ต้องนิ่ง', check: 'logo-static' });
    const r = checkRules(p);
    expect(r.issues.map((i) => i.clipId)).toEqual(['b', 'c']); // name "End_Logo" and slot note "โลโก้"
    expect(r.issues.every((i) => i.severity === 'error')).toBe(true);

    const q = memProject(clips, { board });
    addConstraint(q, { text: 'title นิ่ง', source: 'user', quote: 'q', check: 'logo-static', scope: 'title' });
    expect(checkRules(q).issues.map((i) => i.clipId)).toEqual(['d']);
  });

  it('no-repeat-gimmick: same comp back to back, or the same effect when effect data is given', () => {
    const clips: Clip[] = [
      { id: 'a', src: 'title', in: 0, dur: 25 },
      { id: 'b', src: 'titleDup', in: 0, dur: 25 },
      { id: 'c', src: 'cam', in: 0, dur: 25 },
      { id: 'd', src: 'endlogo', in: 0, dur: 25 },
    ];
    const p = memProject(clips);
    addConstraint(p, { text: 'ไม่ใช้ลูกเล่นซ้ำ', source: 'user', quote: 'q', check: 'no-repeat-gimmick' });
    const r = checkRules(p);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]?.message).toMatch(/a, b/);
    expect(r.issues[0]?.endFrame).toBe(50);

    const fx = checkRules(p, { effects: { title: ['ADBE Glo2'], titleDup: ['ADBE Gaussian Blur 2'], endlogo: ['ADBE Glo2'] } });
    expect(fx.issues).toEqual([]); // glow is not on consecutive clips
    const fx2 = checkRules(p, { effects: { title: ['ADBE Glo2'], titleDup: ['ADBE Glo2'], endlogo: ['ADBE Glo2'] } });
    expect(fx2.issues.map((i) => i.clipId)).toEqual(['a']);

    const camOnly = memProject([{ id: 'x', src: 'cam', in: 0, dur: 25 }, { id: 'y', src: 'cam', in: 25, dur: 25 }]);
    camOnly.constraints = p.constraints;
    const s = checkRules(camOnly);
    expect(s.issues).toEqual([]);
    expect(s.skipped.join(' ')).toMatch(/skipped/);
  });

  it('visual rules come back as checklist items, not pass/fail', () => {
    const p = memProject([{ id: 'a', src: 'cam', in: 0, dur: 25 }]);
    addConstraint(p, { text: 'ห้ามบังภาพ', source: 'brief', quote: 'อย่าบังรูป', check: 'no-cover-photo' });
    addConstraint(p, { text: 'minimal', source: 'user', quote: 'เรียบๆ' });
    const r = checkRules(p);
    expect(r.issues).toEqual([]);
    expect(r.checklist.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(r.checklist[0]?.source).toBe('brief: «อย่าบังรูป»');
  });
});

describe('agent checklist + cost', () => {
  it('lists priority, constraints with sources, style and process items', () => {
    const p = memProject([], { board });
    addConstraint(p, { text: 'ใช้เฉพาะ element ในบอร์ด', source: 'brief', quote: 'บอร์ดเท่านั้น', check: 'board-only' });
    setStyleRules(p, { cornerRadiusPct: 4, joins: [{ from: 'card', to: 'footage', dissolve: 10 }] }, { source: 'user', quote: 'มนก็มนให้หมด' });
    const { text, items } = rulesForAgent(p);
    expect(items[0]?.kind).toBe('priority');
    expect(text).toContain('[auto] ใช้เฉพาะ element ในบอร์ด');
    expect(text).toContain('brief: «บอร์ดเท่านั้น»');
    expect(text).toContain('มนก็มนให้หมด');
    expect(items.map((i) => i.id)).toEqual(expect.arrayContaining(['board', 'style.cornerRadiusPct', 'style.joins:card>footage', 'evidence', 'cost']));
    expect(costNotice('Runway')).toMatch(/Runway.*ค่าใช้จ่าย.*cost money/);
  });
});

describe('evidence frames', () => {
  const clips: Clip[] = [
    { id: 's1', src: 'title', in: 0, dur: 40 },
    { id: 's2', src: 'cam', in: 100, dur: 30 },
    { id: 's3', src: 'titleDup', in: 10, dur: 40 },
  ];

  function withVersion(p: Project, reviewPlan = true): Version {
    const v: Version = {
      id: 'v001', createdAt: '2026-01-01T00:00:00Z', planHash: 'x', master: path.join(root, 'none.mov'), deliverables: {},
      stats: { segmentsTotal: 0, segmentsRendered: 0, segmentsReused: 0, dissolvesRendered: 0, compsRendered: 0, compsReused: 0, timingsMs: {} },
      ...(reviewPlan ? {
        reviewPlan: {
          fps: 25, width: 1920, height: 1080, frames: 110,
          cuts: [{ after: 's1', dissolve: 10 }, { after: 's2', dissolve: 6 }],
          shots: [
            { id: 's1', src: 'title', start: 0, in: 0, dur: 40, comp: 'Title_Card' },
            { id: 's2', src: 'cam', start: 40, in: 100, dur: 30 },
            { id: 's3', src: 'titleDup', start: 70, in: 10, dur: 40, comp: 'Title_Card' },
          ],
        },
      } : {}),
    };
    p.versions.push(v);
    return v;
  }

  it('returns one frame per instance of a comp used twice, clear of dissolves', () => {
    const p = memProject(clips);
    withVersion(p);
    const plan = evidenceFrames(p, undefined, { assetId: 'title' });
    expect(plan.from).toBe('reviewPlan');
    expect(plan.instances.map((i) => i.clipId)).toEqual(['s1', 's3']);
    // s1: [0,40), out-dissolve a=5 → clean [0,35) → frame 17; s3: [70,110), in-dissolve b=3 → clean [73,110) → 73+18 = 91
    expect(plan.instances.map((i) => i.frame)).toEqual([17, 91]);
    expect(plan.instances[1]?.tc).toBe('00:00:03:16');
    expect(plan.instances[1]?.sourceFrame).toBe(10 + 21);
    for (const i of plan.instances) {
      expect(i.frame).toBeGreaterThanOrEqual(i.start);
      expect(i.frame).toBeLessThan(i.start + i.dur);
    }
    expect(evidenceFrames(p, 'v001', { clipIds: ['s2', 'zz'] }).warnings.join(' ')).toMatch(/zz/);
    expect(evidenceFrames(p, 'v001', { assetId: 'title', offset: 5 }).instances.map((i) => i.frame)).toEqual([5, 75]);
  });

  it('falls back to the current timeline (with a warning when it changed)', () => {
    const p = memProject(clips);
    withVersion(p, false);
    const plan = evidenceFrames(p, 'v001', { assetId: 'titleDup' });
    expect(plan.from).toBe('timeline');
    expect(plan.instances.map((i) => i.clipId)).toEqual(['s1', 's3']);
    expect(plan.warnings.join(' ')).toMatch(/reviewPlan/);
  });

  const ff = findFfmpeg();
  it.skipIf(!ff)('extracts exact frames from a synthetic master and tiles a contact sheet, never overwriting', async () => {
    const tools = ff!;
    const p = await createProject(path.join(root, 'evidence'), { name: 'ev', width: 64, height: 48 });
    p.assets = memProject().assets;
    p.timeline.video = clips;
    // each frame's grey level encodes its frame number (N*2), lossless PNG-in-MOV
    const master = path.join(p.dir, 'out', 'v001', 'ev_v001.mov');
    mkdirSync(path.dirname(master), { recursive: true });
    const synth = await execa(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', "color=c=black:s=64x48:r=25:d=4.4,format=gray,geq=lum='N*2'", '-c:v', 'png', master], { reject: false });
    expect(synth.exitCode).toBe(0);
    const v = withVersion(p);
    v.master = master;
    const plan = evidenceFrames(p, 'v001', { assetId: 'title' });
    const r = await extractEvidence(tools, p, plan);
    expect(r.warnings).toEqual([]);
    expect(r.dir).toBe(path.join(p.dir, 'review', 'evidence', 'v001'));
    expect(r.frames).toHaveLength(2);
    for (const f of r.frames) {
      const px = await execa(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', f.path, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer' });
      expect(Math.abs((px.stdout as Uint8Array)[0]! - f.frame * 2)).toBeLessThanOrEqual(1);
    }
    expect(r.contactSheet && existsSync(r.contactSheet)).toBe(true);
    const r2 = await extractEvidence(tools, p, plan);
    const all = await readdir(r.dir);
    expect(all).toHaveLength(6); // 2×(2 frames + sheet): nothing overwritten
    expect(new Set([...r.frames, ...r2.frames].map((f) => f.path)).size).toBe(4);
  });
});

describe('rules tools (handlers)', () => {
  it('add / set_style conflict / check / get through RULES_TOOLS', async () => {
    const { RULES_TOOLS } = await import('../../src/mcp/tools-rules.js');
    const { ToolError } = await import('../../src/mcp/tooldef.js');
    const p = memProject([{ id: 'a', src: 'endlogo', in: 0, dur: 25, pushIn: 5 }]);
    let saves = 0;
    const state = { project: p, api: { project: { saveProject: async () => { saves++; } } } } as never;
    const run = (name: string, args: unknown) => (RULES_TOOLS.find((t) => t.name === name)!.handler as (a: unknown, s: never) => Promise<Record<string, unknown>>)(args, state);
    expect(RULES_TOOLS.map((t) => t.name)).toEqual(['rules_get', 'rules_add_constraint', 'rules_remove_constraint', 'rules_set_style', 'rules_check', 'rules_evidence', 'disk_report', 'cache_gc_plan', 'cache_gc_apply', 'version_keep']);
    await run('rules_add_constraint', { text: 'โลโก้นิ่ง', source: 'brief', quote: 'โลโก้ต้องนิ่ง', check: 'logo-static' });
    await run('rules_set_style', { style: { safeMarginPct: 5 }, source: 'brief', quote: 'ขอบ 5%' });
    const err = await run('rules_set_style', { style: { safeMarginPct: 3 }, source: 'user', quote: 'ขอบ 3%' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as InstanceType<typeof ToolError>).data['needsUserConfirmation']).toBe(true);
    const check = await run('rules_check', {});
    expect(check['ok']).toBe(false);
    const got = await run('rules_get', {});
    expect(String(got['text'])).toContain('โลโก้นิ่ง');
    expect(saves).toBe(2);
  });
});
