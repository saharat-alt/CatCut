/**
 * Board import / check / board-vs-cut / fit-duration. Synthetic inputs only: CSV/JSON strings, a
 * hand-written PDF, and a tiny ffmpeg testsrc master. Adobe is never launched.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as projectApi from '../../src/core/project.js';
import { JobManager } from '../../src/core/jobs.js';
import type { Board, Project, Version } from '../../src/core/types.js';
import {
  boardInputFromCsv, checkBoard, compareBoardToCut, distribute, importBoardFile, matchFootage, normalizeBoard, parseBoardTime,
  parseSlotText, pdfDateToIso, proposeFit,
} from '../../src/io/board.js';
import { safeEnvironment, type AppState } from '../../src/mcp/state.js';
import { callTool, toolResultData } from '../../src/mcp/tools.js';

const ROOT = join(process.cwd(), 'tmp', 'board-test');
let dir: string;

beforeAll(async () => {
  await mkdir(ROOT, { recursive: true });
  dir = await mkdtemp(join(ROOT, 'run-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------- a minimal hand-written PDF (Helvetica text objects, correct xref) ----------

function pdfEscape(t: string): string {
  return t.replace(/[()\\]/g, (m) => `\\${m}`);
}

function makePdf(pages: Array<Array<[number, number, string]>>, title: string): Buffer {
  const objs: string[] = [];
  const add = (s: string) => { objs.push(s); return objs.length; };
  const catalog = add('');
  const pagesId = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids: number[] = [];
  for (const lines of pages) {
    let content = 'BT /F1 10 Tf\n';
    for (const [x, y, t] of lines) content += `1 0 0 1 ${x} ${y} Tm (${pdfEscape(t)}) Tj\n`;
    content += 'ET';
    const c = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title (${pdfEscape(title)}) /ModDate (D:20261010120000+07'00') /CreationDate (D:20261001090000Z) >>`);
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ---------- pure parsing ----------

describe('time strings', () => {
  it('reads board time notations as frames', () => {
    expect(parseBoardTime('0:12', 25)).toBe(300);
    expect(parseBoardTime('00:00:12:05', 25)).toBe(305);
    expect(parseBoardTime('0.03', 25)).toBe(75); // board source TC: min.sec
    expect(parseBoardTime('1.30', 25)).toBe(90 * 25);
    expect(parseBoardTime('5s', 25)).toBe(125);
    expect(parseBoardTime('2.5 วิ', 25)).toBe(63);
    expect(parseBoardTime('40f', 25)).toBe(40);
    expect(parseBoardTime('3:00', 25)).toBe(4500);
    expect(parseBoardTime('abc', 25)).toBeUndefined();
    expect(parseBoardTime('0:75', 25)).toBeUndefined();
  });

  it('parses PDF dates', () => {
    expect(pdfDateToIso("D:20261010120000+07'00'")).toBe('2026-10-10T05:00:00.000Z');
    expect(pdfDateToIso('D:20261001090000Z')).toBe('2026-10-01T09:00:00.000Z');
    expect(pdfDateToIso(undefined)).toBeUndefined();
  });

  it('pulls slot fields out of a row', () => {
    const s = parseSlotText('0:05-0:09 | A002_city.mov 0.03 | "Hello world" | wide shot', 25);
    expect(s).toMatchObject({ boardStartFrame: 125, boardDurFrames: 100, sourceHint: 'A002_city.mov', sourceTc: '0.03', onScreenText: 'Hello world' });
    expect(s.notes).toContain('wide shot');
  });

  it('distributes integer frames proportionally within caps', () => {
    expect(distribute(10, [{ w: 1, cap: 100 }, { w: 1, cap: 100 }])).toEqual([5, 5]);
    expect(distribute(10, [{ w: 1, cap: 2 }, { w: 1, cap: 100 }])).toEqual([2, 8]);
    expect(distribute(7, [{ w: 3, cap: 100 }, { w: 1, cap: 100 }])).toEqual([5, 2]);
    expect(distribute(10, [{ w: 1, cap: 3 }, { w: 1, cap: 3 }]).reduce((a, b) => a + b, 0)).toBe(6);
  });
});

describe('CSV / JSON import', () => {
  it('maps a CSV with directives to a Board', async () => {
    const csv = [
      '#target,0:20',
      '#chapter,Opening,0:00,0:10',
      'id,order,chapter,boardStart,boardDur,sourceHint,sourceTc,onScreenText,status',
      '01,1,Opening,0:00,5s,A001.mov,0.03,"สวัสดี, โลก",ok',
      '02,2,Opening,0:05,5s,A002.mov,,,',
      '03,3,End,0:10,10s,,,"ขอบคุณ",mockup',
    ].join('\r\n');
    const file = join(dir, 'board v2.csv');
    await writeFile(file, `﻿${csv}`, 'utf8');
    const r = await importBoardFile(file, 25);
    expect(r.errors).toEqual([]);
    expect(r.format).toBe('csv');
    expect(r.file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.versionHints).toContain('v2');
    const b = r.board!;
    expect(b.targetFrames).toBe(500);
    expect(b.chapters).toEqual([{ name: 'Opening', startFrame: 0, durFrames: 250 }]);
    expect(b.slots).toHaveLength(3);
    expect(b.slots[0]).toMatchObject({ id: '01', boardStartFrame: 0, boardDurFrames: 125, sourceHint: 'A001.mov', sourceTc: '0.03', onScreenText: 'สวัสดี, โลก', status: 'ok' });
    expect(b.slots[2]).toMatchObject({ id: '03', chapter: 'End', boardStartFrame: 250, boardDurFrames: 250, status: 'mockup' });
  });

  it('rejects unknown CSV columns and bad integers (strict)', () => {
    expect(boardInputFromCsv('id,foo\n01,x').errors.join(' ')).toMatch(/unknown column/);
    expect(boardInputFromCsv('slot,dur\n01,5').errors.join(' ')).toMatch(/id/);
    expect(boardInputFromCsv('id,boardStartFrame\n01,1.5').errors.join(' ')).toMatch(/integer/);
  });

  it('reads JSON boards (object or bare slot array) and reports schema errors', async () => {
    const f1 = join(dir, 'b1.json');
    await writeFile(f1, JSON.stringify({ target: '0:10', slots: [{ id: '01', boardDurFrames: 125 }, { id: '02', boardDur: '5s' }] }), 'utf8');
    const r1 = await importBoardFile(f1, 25);
    expect(r1.errors).toEqual([]);
    expect(r1.board!.targetFrames).toBe(250);
    expect(r1.board!.slots.map((s) => [s.id, s.order, s.boardDurFrames])).toEqual([['01', 1, 125], ['02', 2, 125]]);
    const f2 = join(dir, 'b2.json');
    await writeFile(f2, JSON.stringify([{ id: '01', wat: 1 }]), 'utf8');
    expect((await importBoardFile(f2, 25)).errors.join(' ')).toMatch(/wat|Unrecognized/);
    const n = normalizeBoard({ slots: [{ id: '01', boardStartFrame: 10, boardStart: '0:01' }] }, 25, 'x');
    expect(n.errors.join(' ')).toMatch(/disagree/);
  });
});

describe('PDF import', () => {
  it('extracts metadata, page text and a draft board', async () => {
    const pdf = makePdf([
      [
        [40, 570, 'STB Storyboard v3'],
        [40, 555, 'Total 0:20'],
        [40, 530, 'CHAPTER 1 Opening 0:00-0:10'],
        [40, 510, '01'], [80, 510, '0:00-0:05'], [200, 510, 'A001_city.mov 0.03'], [360, 510, '"Hello world"'],
        [40, 490, '02'], [80, 490, '0:05'], [200, 490, 'A002.mov'], [360, 490, '"Second card"'],
        [40, 470, 'CHAPTER 2 End 0:10-0:20'],
        [40, 450, '28r'], [80, 450, '0:10-0:20'], [200, 450, 'logo mockup'],
      ],
      [[40, 560, '3']],
    ], 'Board v3 (final)');
    const file = join(dir, 'storyboard_v3.pdf');
    await writeFile(file, pdf);
    const r = await importBoardFile(file, 25);
    expect(r.format).toBe('pdf');
    expect(r.pdf).toMatchObject({ pages: 2, title: 'Board v3 (final)', modified: '2026-10-10T05:00:00.000Z' });
    expect(r.pages![0]!.lines.some((l) => l.includes('A001_city.mov'))).toBe(true);
    expect(r.versionHints).toEqual(expect.arrayContaining(['v3', 'final']));
    const b = r.board!;
    expect(b.targetFrames).toBe(500);
    expect(b.chapters?.map((c) => [c.name, c.startFrame, c.durFrames])).toEqual([['CHAPTER 1 Opening', 0, 250], ['CHAPTER 2 End', 250, 250]]);
    const ids = b.slots.map((s) => s.id);
    expect(ids.slice(0, 3)).toEqual(['01', '02', '28r']);
    expect(b.slots[0]).toMatchObject({ boardStartFrame: 0, boardDurFrames: 125, sourceHint: 'A001_city.mov', sourceTc: '0.03', onScreenText: 'Hello world', chapter: 'CHAPTER 1 Opening' });
    expect(b.slots[1]).toMatchObject({ boardStartFrame: 125, boardDurFrames: 125, onScreenText: 'Second card' }); // dur derived from the next start
    expect(b.slots[2]).toMatchObject({ boardStartFrame: 250, boardDurFrames: 250, status: 'mockup', chapter: 'CHAPTER 2 End' });
    // the lone page number "3" is flagged low-confidence for the agent to drop
    expect(r.detections!.find((d) => d.value === '3')?.confidence).toBe('low');
  });
});

// ---------- board self-consistency ----------

describe('checkBoard', () => {
  it('finds contradictions inside the board', () => {
    const board: Board = {
      source: 'x', importedAt: '', targetFrames: 1000,
      chapters: [{ name: 'A', startFrame: 0, durFrames: 300 }, { name: 'B', durFrames: 600 }],
      slots: [
        { id: '01', order: 1, chapter: 'A', boardStartFrame: 0, boardDurFrames: 100, onScreenText: 'มูลนิธิเพื่อชุมชน' },
        { id: '02', order: 2, chapter: 'A', boardStartFrame: 100, boardDurFrames: 150 },
        { id: '04', order: 3, chapter: 'B', boardStartFrame: 260, boardDurFrames: 100, onScreenText: 'มูลนิธิเพื่อชุมขน' },
        { id: '04', order: 4, chapter: 'B', boardStartFrame: 350, boardDurFrames: 100 },
      ],
    };
    const w = checkBoard(board, 25);
    const codes = w.map((x) => x.code);
    expect(codes).toContain('duplicate-id');
    expect(codes).toContain('sequence-gap');
    expect(w.find((x) => x.code === 'sequence-gap')!.message).toContain('03');
    expect(codes).toContain('chapter-vs-slots'); // A: 300 vs 250
    expect(codes).toContain('chapters-vs-target'); // 900 vs 1000
    expect(codes).toContain('slot-gap'); // 02 ends 250, 04 starts 260
    expect(codes).toContain('slot-overlap'); // 04 ends 360, next 04 at 350
    expect(codes).toContain('text-mismatch');
  });

  it('matches footage folders to slots and reports orphans', async () => {
    const fd = join(dir, 'footage');
    await mkdir(join(fd, '01_city'), { recursive: true });
    await writeFile(join(fd, '01_city', 'A001.mov'), '');
    await writeFile(join(fd, '1_alt.mov'), '');
    await writeFile(join(fd, '28r-logo.mov'), '');
    await writeFile(join(fd, '05_extra.mov'), '');
    await writeFile(join(fd, 'notes.txt'), '');
    const board: Board = {
      source: 'x', importedAt: '',
      slots: [{ id: '01', order: 1, sourceHint: 'A001.mov' }, { id: '03', order: 2 }, { id: '28r', order: 3, sourceHint: 'B999.mov' }, { id: '28', order: 4 }],
    };
    const m = await matchFootage(board, fd);
    expect(m.slots.find((s) => s.slot === '01')!.matches).toEqual(expect.arrayContaining(['01_city', '1_alt.mov']));
    expect(m.slots.find((s) => s.slot === '28r')!.matches).toEqual(['28r-logo.mov']);
    expect(m.missing).toEqual(['03', '28']);
    expect(m.orphans).toEqual(['05_extra.mov']);
    expect(m.warnings.some((w) => w.code === 'source-missing' && w.slot === '28r')).toBe(true);
    expect(m.warnings.some((w) => w.code === 'source-missing' && w.slot === '01')).toBe(false);
  });
});

// ---------- board vs cut ----------

const BOARD: Board = {
  source: 'board.csv', importedAt: '', targetFrames: 150,
  chapters: [{ name: 'A' }, { name: 'B' }],
  slots: [
    { id: '01', order: 1, chapter: 'A', boardStartFrame: 0, boardDurFrames: 50 },
    { id: '02', order: 2, chapter: 'A', boardStartFrame: 50, boardDurFrames: 50 },
    { id: '03', order: 3, chapter: 'B', boardStartFrame: 100, boardDurFrames: 25 },
    { id: '04', order: 4, chapter: 'B', boardStartFrame: 125, boardDurFrames: 25 },
  ],
};

describe('compareBoardToCut', () => {
  it('computes missing/extra/order and per-slot and per-chapter drift', () => {
    const shots = [
      { id: 'c1', src: 'a', start: 0, dur: 60, slot: '01' },
      { id: 'c2', src: 'a', start: 60, dur: 40, slot: '03' },
      { id: 'c3', src: 'a', start: 100, dur: 30, slot: '02' },
      { id: 'c4', src: 'a', start: 130, dur: 10 },
      { id: 'c5', src: 'a', start: 140, dur: 20, slot: '99' },
    ];
    const r = compareBoardToCut(BOARD, shots, 160, 25, 5);
    expect(r.missing).toEqual(['04']);
    expect(r.extra.map((e) => [e.clipId, e.reason])).toEqual([['c4', 'no-slot'], ['c5', 'unknown-slot']]);
    expect(r.moved).toEqual(['03']);
    const s1 = r.slots.find((s) => s.slot === '01')!;
    expect(s1).toMatchObject({ cutStart: 0, startDrift: 0, durDiff: 10, status: 'drift' });
    const s2 = r.slots.find((s) => s.slot === '02')!;
    expect(s2).toMatchObject({ cutStart: 100, startDrift: 50, startDriftTc: '+00:00:02:00', durDiff: -20 });
    const chB = r.chapters.find((c) => c.name === 'B')!;
    expect(chB).toMatchObject({ boardStart: 100, cutStart: 60, startDrift: -40, boardDur: 50, cutDur: 40, durDiff: -10 });
    expect(r.total).toMatchObject({ cut: 160, target: 150, diff: 10 });
    expect(r.issues.every((i) => i.kind === 'board')).toBe(true);
    expect(r.issues.some((i) => i.severity === 'error' && i.message.includes('04'))).toBe(true);
    expect(r.issues.some((i) => i.message.includes('ความยาวรวม'))).toBe(true);
  });
});

// ---------- fit_duration (pure) ----------

function fitProject(): Project {
  const probe = (n: number) => ({ durationFrames: n, hasVideo: true, hasAudio: true, width: 320, height: 180, fps: 25 });
  return {
    meta: { name: 'fit', fps: 25, width: 320, height: 180, createdAt: '', schema: 1 },
    dir,
    assets: {
      cam1: { id: 'cam1', kind: 'camera', path: join(dir, 'cam1.mov'), probe: probe(100) },
      cam2: { id: 'cam2', kind: 'camera', path: join(dir, 'cam2.mov'), probe: probe(60) },
      card: { id: 'card', kind: 'still', path: join(dir, 'card.png') },
    },
    timeline: {
      video: [
        { id: 'a', src: 'cam1', in: 10, dur: 50, slot: '01' },
        { id: 'b', src: 'cam2', in: 5, dur: 40, slot: '02' },
        { id: 'c', src: 'card', in: 0, dur: 30, slot: '03' },
      ],
      cuts: [{ after: 'a', dissolve: 10 }],
      audio: { vo: [{ id: 'vo1', src: 'cam1', at: 100 }], music: [], sfx: [] },
    },
    delivery: { targets: [] },
    versions: [],
  };
}

describe('proposeFit', () => {
  it('proportional growth respects source handles and dissolve handles, and validates', () => {
    const p = fitProject();
    const r = proposeFit(p, { targetFrames: 160, strategy: 'proportional' });
    expect(r.delta).toBe(40);
    expect(r.achievedFrames).toBe(160);
    expect(r.errors).toEqual([]);
    const a = r.changes.find((c) => c.clipId === 'a');
    // a: source 100, in 10, dissolve 10 needs 5 handle after → max dur 85
    expect(a?.max).toBe(85);
    const b = r.changes.find((c) => c.clipId === 'b')!;
    expect(b.to).toBeLessThanOrEqual(55); // cam2 60 - in 5
    expect(r.notes.join(' ')).toMatch(/vo1/);
  });

  it('cards strategy puts the change on stills first; tail trims from the end; reports unreachable targets', () => {
    const p = fitProject();
    const cards = proposeFit(p, { targetFrames: 140, strategy: 'cards' });
    expect(cards.flexible).toEqual(['c']);
    expect(cards.changes).toEqual([expect.objectContaining({ clipId: 'c', from: 30, to: 50 })]);
    const tail = proposeFit(p, { targetFrames: 100, strategy: 'tail' });
    expect(tail.achievedFrames).toBe(100);
    expect(tail.changes.map((c) => c.clipId)).toEqual(['c']);
    expect(tail.errors).toEqual([]);
    const locked = proposeFit(p, { targetFrames: 400, strategy: 'proportional', lock: ['03'] });
    expect(locked.remaining).toBeGreaterThan(0);
    expect(locked.changes.find((c) => c.clipId === 'c')).toBeUndefined();
    const shrink = proposeFit(p, { targetFrames: 20, strategy: 'proportional' });
    expect(shrink.errors).toEqual([]);
    expect(shrink.timeline.video.find((c) => c.id === 'a')!.dur).toBeGreaterThanOrEqual(6); // 5 frames go to the dissolve + 1 body frame
  });
});

// ---------- tools end to end ----------

async function makeState(): Promise<{ state: AppState; hasFfmpeg: boolean }> {
  const { env, problems } = await safeEnvironment();
  const state: AppState = {
    env, ae: { kind: 'mock' } as AppState['ae'], jobs: new JobManager(), problems,
    api: {
      project: projectApi,
      xmeml: { writeXmeml: () => '', readXmeml: () => { throw new Error('unused'); } },
      probe: async () => ({ durationFrames: 0, hasVideo: true, hasAudio: false }),
    },
    assembler: {
      build: async () => { throw new Error('unused'); },
      deliver: async () => ({}),
      reviewProxy: async () => '',
    },
  };
  return { state, hasFfmpeg: !!env.tools.ffmpeg && problems.length === 0 };
}

describe('board tools', () => {
  let state: AppState;
  let hasFfmpeg = false;
  let p: Project;

  beforeAll(async () => {
    ({ state, hasFfmpeg } = await makeState());
    p = await projectApi.createProject(join(dir, 'proj'), { name: 'board', fps: 25, width: 320, height: 180 });
    state.project = p;
  });

  it('board_import dry-run then apply stores board.json and detects the same content later', async () => {
    const file = join(dir, 'tool-board.csv');
    await writeFile(file, 'id,boardStartFrame,boardDurFrames,onScreenText\n01,0,50,Hello\n02,50,50,\n03,100,25,\n04,125,25,\n', 'utf8');
    const dry = toolResultData(await callTool(state, 'board_import', { path: file, target: 150 }));
    expect(dry).toMatchObject({ ok: true, dryRun: true, applied: false });
    expect(existsSync(join(p.dir, 'board.json'))).toBe(false);
    const ap = toolResultData(await callTool(state, 'board_import', { path: file, target: 150, apply: true }));
    expect(ap).toMatchObject({ ok: true, applied: true });
    expect(p.board?.slots).toHaveLength(4);
    const stored = JSON.parse(await readFile(join(p.dir, 'board.json'), 'utf8')) as { sourceSha256: string; board: Board };
    expect(stored.board.targetFrames).toBe(150);
    const again = toolResultData(await callTool(state, 'board_import', { path: file }));
    expect(again['current']).toMatchObject({ sameFile: true, sameContent: true });
  });

  it('board_set validates, keeps the previous board in history, board_check reports', async () => {
    const bad = toolResultData(await callTool(state, 'board_set', { board: { slots: [{ id: '01', boardStart: 'nope' }] } }));
    expect(bad['ok']).toBe(false);
    const res = toolResultData(await callTool(state, 'board_set', { board: { ...BOARD, source: 'board.csv' } }));
    expect(res['ok']).toBe(true);
    expect(String(res['previous'])).toMatch(/history[\\/]board-.*\.json$/);
    const chk = toolResultData(await callTool(state, 'board_check', {}));
    expect(chk['ok']).toBe(true);
    expect(chk['board']).toMatchObject({ slots: 4 });
  });

  it('fit_duration dry-run, then apply with a timeline backup', async () => {
    const src = join(dir, 'still.png');
    await writeFile(src, 'x');
    p.assets['card'] = { id: 'card', kind: 'still', path: src };
    p.assets['cam'] = { id: 'cam', kind: 'camera', path: src, probe: { durationFrames: 200, hasVideo: true, hasAudio: false } };
    projectApi.setTimeline(p, {
      video: [{ id: 'x1', src: 'cam', in: 0, dur: 100, slot: '01' }, { id: 'x2', src: 'card', in: 0, dur: 20, slot: '04' }],
      cuts: [], audio: { vo: [], music: [], sfx: [] },
    });
    const dry = toolResultData(await callTool(state, 'fit_duration', { strategy: 'cards' }));
    expect(dry).toMatchObject({ ok: true, dryRun: true, reached: true, proposed: { frames: 150 } });
    expect(p.timeline.video[1]!.dur).toBe(20);
    const ap = toolResultData(await callTool(state, 'fit_duration', { strategy: 'cards', apply: true }));
    expect(ap).toMatchObject({ ok: true, applied: true });
    expect(p.timeline.video[1]!.dur).toBe(50);
    expect(existsSync(String(ap['backup']))).toBe(true);
    const list = toolResultData(await callTool(state, 'timeline_restore', {}));
    expect((list['backups'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('board_vs_cut writes a side-by-side HTML report (never overwriting) with frames from the master', async (ctx) => {
    if (!hasFfmpeg) ctx.skip();
    const outDir = join(p.dir, 'out', 'v001');
    await mkdir(outDir, { recursive: true });
    const master = join(outDir, 'board_v001.mp4');
    await execa(state.env.tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-frames:v', '160', '-c:v', 'mpeg4', '-q:v', '5', master], { timeout: 60_000 });
    const thumb = join(dir, 'thumb01.png');
    await execa(state.env.tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90', '-frames:v', '1', thumb], { timeout: 60_000 });
    await callTool(state, 'board_set', { board: { ...BOARD, slots: BOARD.slots.map((s) => (s.id === '01' ? { ...s, thumb } : s)) } });
    const v: Version = {
      id: 'v001', createdAt: new Date().toISOString(), planHash: 'x', master, deliverables: {},
      stats: { segmentsTotal: 0, segmentsRendered: 0, segmentsReused: 0, dissolvesRendered: 0, compsRendered: 0, compsReused: 0, timingsMs: {} },
      reviewPlan: {
        fps: 25, width: 320, height: 180, frames: 160,
        cuts: [{ after: 'c1', dissolve: 4 }],
        shots: [
          { id: 'c1', src: 'cam', start: 0, in: 0, dur: 60, slot: '01' } as never,
          { id: 'c2', src: 'cam', start: 60, in: 0, dur: 40, slot: '02' } as never,
          { id: 'c3', src: 'cam', start: 100, in: 0, dur: 30, slot: '03' } as never,
          { id: 'c4', src: 'cam', start: 130, in: 0, dur: 30 },
        ],
      },
    };
    p.versions.push(v);
    const r = toolResultData(await callTool(state, 'board_vs_cut', { version: 'v001', toleranceFrames: 2 }));
    expect(r['pending']).toBeUndefined();
    expect(String(r['report'])).toMatch(/board_vs_cut\.html$/);
    const html = await readFile(String(r['report']), 'utf8');
    expect(html).toContain('บอร์ด vs คัท');
    expect(html).toContain('thumb01.png');
    expect(r['missing']).toEqual(['04']);
    expect((r['extra'] as Array<{ clipId: string }>).map((e) => e.clipId)).toEqual(['c4']);
    const frames = await readdir(String(r['framesDir']));
    expect(frames.filter((f) => f.endsWith('.jpg'))).toHaveLength(3);
    const issues = r['issues'] as Array<{ kind: string }>;
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.kind === 'board')).toBe(true);
    const r2 = toolResultData(await callTool(state, 'board_vs_cut', { version: 'v001', frames: false }));
    expect(String(r2['report'])).toMatch(/board_vs_cut_2\.html$/);
    expect(existsSync(String(r['report']))).toBe(true);
  });
});
