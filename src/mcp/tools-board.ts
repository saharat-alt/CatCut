/**
 * Board (storyboard / brief) tools — DESIGN §13.2 row 1. The board is the highest authority for the
 * edit (§13.2.1): these tools read it, check it against itself, the footage folder and the cut, and
 * propose duration fixes. Nothing stylistic is decided here.
 *
 * The current board lives in p.board and in <project>/board.json (with the source file hash); every
 * replacement first copies the previous board.json to history/board-<stamp>-<n>.json.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execa } from 'execa';
import { z } from 'zod';
import { framesToTc, splitDissolve } from '../core/timecode.js';
import type { Board, Frames, Project, ReviewShot, Timeline, Version } from '../core/types.js';
import {
  BoardInputSchema, checkBoard, compareBoardToCut, htmlHref, importBoardFile, inferSlot, matchFootage, normalizeBoard,
  parseBoardTime, proposeFit, renderBoardVsCutHtml, type BoardWarning, type ReportImages, type ShotLike,
} from '../io/board.js';
import { versionPlan } from '../review/session.js';
import { requireFfmpeg, requireProject, type AppState, type JobContext } from './state.js';
import { tool, ToolError, type ToolDef } from './tooldef.js';

// ---------- board storage ----------

interface BoardFile {
  schema: 1;
  savedAt: string;
  reason: string;
  sourceSha256?: string;
  sourceModified?: string;
  board: Board;
}

const BOARD_FILE = 'board.json';

async function readBoardFile(p: Project): Promise<BoardFile | undefined> {
  const file = join(p.dir, BOARD_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const d = JSON.parse(await readFile(file, 'utf8')) as Partial<BoardFile>;
    return d.board && Array.isArray(d.board.slots) ? (d as BoardFile) : undefined;
  } catch {
    return undefined;
  }
}

/** p.board, else <project>/board.json (kept in sync by storeBoard). */
async function loadBoard(p: Project): Promise<Board | undefined> {
  if (p.board) return p.board;
  const f = await readBoardFile(p);
  if (f) p.board = f.board;
  return p.board;
}

async function requireBoard(p: Project): Promise<Board> {
  const b = await loadBoard(p);
  if (!b) throw new ToolError('ยังไม่มีบอร์ดในโปรเจกต์ — เรียก board_import หรือ board_set ก่อน / no board: call board_import or board_set first');
  return b;
}

/** Exclusive create of <dir>/<prefix>-<stamp>-<n>.json; never overwrites. */
async function writeHistory(p: Project, prefix: string, body: unknown): Promise<string> {
  const dir = join(p.dir, 'history');
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const text = `${JSON.stringify(body, null, 2)}\n`;
  for (let n = 1; ; n++) {
    const file = join(dir, `${prefix}-${stamp}-${n}.json`);
    try {
      await writeFile(file, text, { encoding: 'utf8', flag: 'wx' });
      return file;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

/** Same file format as tools.ts backupTimeline, so timeline_restore lists these backups too. */
function backupTimeline(p: Project, reason: string): Promise<string> {
  return writeHistory(p, 'timeline', { savedAt: new Date().toISOString(), reason, timeline: p.timeline });
}

async function storeBoard(state: AppState, p: Project, board: Board, reason: string, src?: { sha256?: string; modified?: string }): Promise<{ boardFile: string; previous?: string }> {
  const prev = await readBoardFile(p);
  const previous = prev ? await writeHistory(p, 'board', prev) : undefined;
  const body: BoardFile = { schema: 1, savedAt: new Date().toISOString(), reason, board };
  if (src?.sha256) body.sourceSha256 = src.sha256;
  if (src?.modified) body.sourceModified = src.modified;
  const file = join(p.dir, BOARD_FILE);
  const tmp = join(p.dir, `.${BOARD_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  try {
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  p.board = board;
  await state.api.project.saveProject(p);
  return { boardFile: file, ...(previous ? { previous } : {}) };
}

function warningText(w: BoardWarning[]): string[] {
  const icon = { error: '✖', warn: '⚠', info: 'ℹ' } as const;
  return w.map((x) => `${icon[x.severity]} ${x.message}`);
}

function boardSummary(b: Board, fps: number) {
  return {
    source: b.source,
    importedAt: b.importedAt,
    slots: b.slots.length,
    chapters: b.chapters?.map((c) => c.name) ?? [],
    target: b.targetFrames !== undefined ? { frames: b.targetFrames, tc: framesToTc(b.targetFrames, fps) } : null,
  };
}

const samePath = (a: string, b: string) => (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

const MAX_LINES_PER_PAGE = 400;

// ---------- slot resolution for a version ----------

function resolveShots(p: Project, board: Board, shots: Array<ReviewShot & { slot?: string }>): { shots: ShotLike[]; how: Record<string, number> } {
  const how: Record<string, number> = { clip: 0, timeline: 0, marker: 0, source: 0, none: 0 };
  const live = new Map(p.timeline.video.map((c) => [c.id, c]));
  const out = shots.map((s) => {
    const sh: ShotLike = { id: s.id, src: s.src, start: s.start, dur: s.dur };
    if (s.marker) sh.marker = s.marker;
    if (s.slot) { sh.slot = s.slot; how['clip']!++; return sh; }
    const c = live.get(s.id);
    if (c?.slot && c.src === s.src) { sh.slot = c.slot; how['timeline']!++; return sh; }
    const r = inferSlot(sh, board, p.assets[s.src]);
    if (r.slot) { sh.slot = r.slot; how[r.how!]!++; } else how['none']!++;
    return sh;
  });
  return { shots: out, how };
}

// ---------- frame grabs ----------

async function grabFrame(state: AppState, master: string, frame: Frames, fps: number, out: string, signal: AbortSignal): Promise<boolean> {
  const sec = Math.max(0, (frame - 0.25) / fps).toFixed(4);
  const r = await execa(state.env.tools.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', sec, '-i', master, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', '-n', out,
  ], { windowsHide: true, timeout: 60_000, forceKillAfterDelay: 3000, reject: false, stdin: 'ignore', cancelSignal: signal });
  return r.exitCode === 0 && existsSync(out);
}

async function uniqueDir(base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const d = n === 1 ? base : `${base}_${n}`;
    if (existsSync(d)) continue;
    try {
      await mkdir(d);
      return d;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

async function writeUnique(base: string, text: string): Promise<string> {
  const ext = extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let n = 1; ; n++) {
    const file = n === 1 ? base : `${stem}_${n}${ext}`;
    try {
      await writeFile(file, text, { encoding: 'utf8', flag: 'wx' });
      return file;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

const WAIT_MS = 25_000;

async function runJob(state: AppState, name: string, fn: (ctx: JobContext) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const job = state.jobs.start(name, fn);
  let timer: NodeJS.Timeout | undefined;
  const info = await Promise.race([
    state.jobs.wait(job.id),
    new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), WAIT_MS); }),
  ]);
  clearTimeout(timer);
  if (!info) return { ok: true, pending: true, jobId: job.id, hint: 'ยังทำไม่เสร็จ — ดูผลด้วย job_status {id} / still running: poll job_status' };
  if (info.status === 'done') return { ...(info.result as Record<string, unknown>), jobId: job.id };
  throw new ToolError(info.error ?? `${name} ${info.status}`, { jobId: job.id, status: info.status });
}

// ---------- tools ----------

const timeArg = z.union([z.number().int().positive(), z.string()]);

function targetFrom(v: number | string | undefined, fps: number): Frames | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'number') return v;
  const f = parseBoardTime(v, fps);
  if (f === undefined || f <= 0) throw new ToolError(`อ่านเวลาเป้าหมาย "${v}" ไม่ได้ / unreadable target`);
  return f;
}

export const BOARD_TOOLS: ToolDef[] = [
  tool({
    name: 'board_import',
    description: 'อ่านบอร์ด/บรีฟ (PDF, CSV, JSON): คืนร่างบอร์ด + ข้อความดิบรายหน้า (PDF) + metadata (ชื่อเรื่อง, วันที่แก้, จำนวนหน้า) + sha256 + ไฟล์บอร์ดอื่นในโฟลเดอร์เดียวกัน เพื่อยืนยัน "ฉบับไหน"; ค่าเริ่มต้น dry run, apply: true เพื่อบันทึก. PDF เป็น heuristic — Claude ต้องดู PDF ด้วยตาแล้วแก้ด้วย board_set · Import a storyboard (PDF/CSV/JSON): draft board + raw page text + metadata + hash; dry-run by default',
    input: {
      path: z.string().describe('board file: .pdf, .csv (header = BoardSlot field names) or .json'),
      apply: z.boolean().optional().describe('store as the project board (default false = dry run)'),
      target: timeArg.optional().describe('override total target: frames or "3:00"'),
      fps: z.number().positive().optional().describe('fps for time strings when no project is open (default: project fps or 25)'),
      includePages: z.boolean().optional().describe('include raw page text for PDFs (default true)'),
    },
    mutating: true,
    writesProject: true,
    handler: async (a, state) => {
      const p = state.project;
      const fps = p?.meta.fps ?? a.fps ?? 25;
      const r = await importBoardFile(a.path, fps, a.target !== undefined ? { target: a.target } : {});
      const check = r.board ? checkBoard(r.board, fps) : [];
      const stored = p ? await readBoardFile(p) : undefined;
      const current = p && (p.board ?? stored?.board);
      let compare: Record<string, unknown> | null = null;
      if (current) {
        const sameFile = samePath(current.source, r.file.path);
        compare = {
          source: current.source, importedAt: current.importedAt, slots: current.slots.length, sameFile,
          sameContent: stored?.sourceSha256 ? stored.sourceSha256 === r.file.sha256 : null,
          note: sameFile && stored?.sourceSha256 && stored.sourceSha256 !== r.file.sha256
            ? 'ไฟล์เดิมแต่เนื้อหาเปลี่ยนตั้งแต่ import ครั้งก่อน — บอร์ดถูกแก้ / same file, content changed since last import'
            : !sameFile ? 'คนละไฟล์กับบอร์ดปัจจุบัน — ยืนยันกับผู้ใช้ว่าฉบับไหนล่าสุด / different file from the current board' : undefined,
        };
      }
      const pages = a.includePages === false ? undefined : r.pages?.map((pg) => ({
        page: pg.page, size: `${pg.width}x${pg.height}`,
        lines: pg.lines.slice(0, MAX_LINES_PER_PAGE), ...(pg.lines.length > MAX_LINES_PER_PAGE ? { truncated: pg.lines.length - MAX_LINES_PER_PAGE } : {}),
      }));
      const report = {
        format: r.format, file: r.file, pdf: r.pdf, versionHints: r.versionHints, siblings: r.siblings, current: compare,
        errors: r.errors, warnings: r.warnings, check: warningText(check), checkDetail: check,
        board: r.board, detections: r.detections, pages,
        confirm: `ยืนยันกับผู้ใช้: "${r.file.name}"${r.pdf?.title ? ` (title: ${r.pdf.title})` : ''} แก้ไขล่าสุด ${r.pdf?.modified ?? r.file.modified}${r.pdf ? ` · ${r.pdf.pages} หน้า` : ''} · sha256 ${r.file.sha256.slice(0, 12)} — เป็นฉบับล่าสุดใช่ไหม?`,
      };
      if (!a.apply) {
        return {
          ok: r.errors.length === 0, dryRun: true, applied: false, ...report,
          hint: r.format === 'pdf'
            ? 'ดู PDF ด้วยตา เทียบกับ board/pages แล้วส่งบอร์ดที่แก้แล้วด้วย board_set (หรือ apply: true ถ้าร่างถูกต้อง) / verify visually, then board_set'
            : 'ตรวจแล้วเรียกซ้ำด้วย apply: true เพื่อบันทึก / review, then call again with apply: true',
        };
      }
      const proj = requireProject(state);
      if (r.errors.length || !r.board) throw new ToolError('บอร์ดมีข้อผิดพลาด ไม่ได้บันทึก / board has errors, not stored', { errors: r.errors, warnings: r.warnings });
      const board: Board = { ...r.board, ...(r.warnings.length || check.length ? { warnings: [...r.warnings, ...warningText(check)] } : {}) };
      const saved = await storeBoard(state, proj, board, `board_import ${r.file.name}`, { sha256: r.file.sha256, modified: r.pdf?.modified ?? r.file.modified });
      return { ok: true, applied: true, ...saved, ...report, pages: undefined, stored: boardSummary(board, fps) };
    },
  }),

  tool({
    name: 'board_set',
    description: 'บันทึกบอร์ดที่ Claude แก้แล้ว (หลังอ่าน PDF ด้วยตา): slot {id, order?, chapter?, boardStartFrame|boardStart, boardDurFrames|boardDur, sourceHint, sourceTc, onScreenText, notes, thumb, status} + chapters + targetFrames|target · Store the corrected board (zod-validated); previous board kept in history/',
    input: {
      board: BoardInputSchema,
      sourceSha256: z.string().optional().describe('sha256 of the board file this was read from (from board_import)'),
    },
    mutating: true,
    writesProject: true,
    handler: async (a, state) => {
      const p = requireProject(state);
      const prev = await loadBoard(p);
      const source = a.board.source ?? prev?.source ?? 'board_set';
      const n = normalizeBoard(a.board, p.meta.fps, source);
      if (!n.board) throw new ToolError('บอร์ดไม่ถูกต้อง ไม่ได้บันทึก / invalid board, not stored', { errors: n.errors });
      const check = checkBoard(n.board, p.meta.fps);
      if (check.length) n.board.warnings = [...(n.board.warnings ?? []), ...warningText(check)];
      const prevFile = await readBoardFile(p);
      const sha = a.sourceSha256 ?? (prevFile && samePath(prevFile.board.source, source) ? prevFile.sourceSha256 : undefined);
      const saved = await storeBoard(state, p, n.board, 'board_set', sha ? { sha256: sha } : undefined);
      return { ok: true, ...saved, board: boardSummary(n.board, p.meta.fps), check: warningText(check), checkDetail: check };
    },
  }),

  tool({
    name: 'board_check',
    description: 'ตรวจความขัดแย้งในบอร์ด (ความยาว chapter vs slot vs เป้า, slot ซ้ำ/เลขข้าม, เวลาซ้อน/ช่องว่าง, ข้อความที่สะกดต่างกัน) + ถ้าให้ footageDir: ตรวจว่ามีไฟล์/โฟลเดอร์ขึ้นต้นด้วยเลข slot ครบ และรายงานไฟล์ที่ไม่ตรง slot ใด · Board self-consistency + footage folder vs slots',
    input: {
      footageDir: z.string().optional().describe('folder whose files/subfolders are named by slot id (e.g. "01_city", "28r_logo.mov")'),
    },
    handler: async (a, state) => {
      const p = requireProject(state);
      const board = await requireBoard(p);
      const fps = p.meta.fps;
      const all = checkBoard(board, fps);
      let footage: Record<string, unknown> | undefined;
      if (a.footageDir) {
        const m = await matchFootage(board, a.footageDir);
        all.push(...m.warnings);
        footage = { dir: m.dir, missing: m.missing, orphans: m.orphans, slots: m.slots };
      }
      const clipsWithoutSlot = p.timeline.video.filter((c) => !c.slot).map((c) => c.id);
      const unknownSlots = p.timeline.video.filter((c) => c.slot && !board.slots.some((s) => s.id === c.slot)).map((c) => `${c.id}→${c.slot}`);
      const stored = await readBoardFile(p);
      return {
        ok: !all.some((w) => w.severity === 'error'),
        board: boardSummary(board, fps),
        sourceSha256: stored?.sourceSha256,
        counts: { error: all.filter((w) => w.severity === 'error').length, warn: all.filter((w) => w.severity === 'warn').length, info: all.filter((w) => w.severity === 'info').length },
        warnings: warningText(all),
        detail: all,
        footage,
        timeline: { clipsWithoutSlot, unknownSlots, hint: clipsWithoutSlot.length ? 'ผูกคลิปกับ slot ด้วย board_link / link clips with board_link' : undefined },
      };
    },
  }),

  tool({
    name: 'board_link',
    description: 'ผูกคลิปในไทม์ไลน์กับ slot ของบอร์ด (Clip.slot): map {clipId: slotId|null} และ/หรือ auto (เดาจาก marker หรือชื่อไฟล์/โฟลเดอร์ต้นทางที่ขึ้นต้นด้วยเลข slot); dry run เป็นค่าเริ่มต้น · Link timeline clips to board slots; dry-run by default',
    input: {
      map: z.record(z.string().nullable()).optional().describe('clip id → slot id (null removes the link)'),
      auto: z.boolean().optional().describe('infer slots for clips without one (default true)'),
      apply: z.boolean().optional(),
    },
    mutating: true,
    writesProject: true,
    handler: async (a, state) => {
      const p = requireProject(state);
      const board = await requireBoard(p);
      const ids = new Set(board.slots.map((s) => s.id));
      const next: Timeline = structuredClone(p.timeline);
      const changes: Array<{ clipId: string; from?: string; to?: string | null; how: string }> = [];
      const errors: string[] = [];
      for (const [clipId, slot] of Object.entries(a.map ?? {})) {
        const c = next.video.find((x) => x.id === clipId);
        if (!c) { errors.push(`ไม่พบคลิป / unknown clip: ${clipId}`); continue; }
        if (slot !== null && !ids.has(slot)) { errors.push(`ไม่มี slot "${slot}" ในบอร์ด / unknown slot`); continue; }
        if ((c.slot ?? null) === slot) continue;
        changes.push({ clipId, ...(c.slot ? { from: c.slot } : {}), to: slot, how: 'map' });
        if (slot === null) delete c.slot; else c.slot = slot;
      }
      if (a.auto ?? true) {
        let pos = 0;
        for (const c of next.video) {
          const start = pos; pos += c.dur;
          if (c.slot || (a.map && c.id in a.map)) continue;
          const r = inferSlot({ id: c.id, src: c.src, start, dur: c.dur, ...(c.marker ? { marker: c.marker } : {}) }, board, p.assets[c.src]);
          if (r.slot) { c.slot = r.slot; changes.push({ clipId: c.id, to: r.slot, how: r.how! }); }
        }
      }
      const unlinked = next.video.filter((c) => !c.slot).map((c) => c.id);
      const result = { changes, errors, unlinked, missingSlots: board.slots.filter((s) => !next.video.some((c) => c.slot === s.id)).map((s) => s.id) };
      if (!a.apply) return { ok: errors.length === 0, dryRun: true, applied: false, ...result, hint: 'ตรวจแล้วเรียกซ้ำด้วย apply: true / review, then apply: true' };
      if (errors.length) throw new ToolError('มีข้อผิดพลาด ไม่ได้บันทึก / errors, not applied', result);
      if (!changes.length) return { ok: true, applied: false, ...result, note: 'ไม่มีอะไรเปลี่ยน / nothing to change' };
      const backup = await backupTimeline(p, 'before board_link');
      state.api.project.setTimeline(p, next);
      await state.api.project.saveProject(p);
      return { ok: true, applied: true, backup, ...result };
    },
  }),

  tool({
    name: 'board_vs_cut',
    description: 'เทียบเวอร์ชันที่ build แล้วกับบอร์ด: slot ที่หาย, คลิปนอกบอร์ด, ลำดับผิด, เวลาเริ่มเลื่อนราย slot และราย chapter (เฟรม + timecode), ความยาวต่าง, ความยาวรวม vs เป้า; สร้างรายงาน HTML ภาพคู่ (ภาพบอร์ด | เฟรมจาก master) ใน out/<version>/ (ไม่เขียนทับ) + QcIssue kind board · Board vs cut report (HTML side-by-side + drift table)',
    input: {
      version: z.string().optional().describe('version id (default: latest)'),
      toleranceFrames: z.number().int().min(0).optional().describe('drift allowed before it is flagged (default: 1 second of frames, boards are usually written in seconds)'),
      frames: z.boolean().optional().describe('extract cut frames from the master for the HTML (default true)'),
    },
    writesProject: true,
    handler: async (a, state) => {
      const p = requireProject(state);
      const board = await requireBoard(p);
      const v: Version | undefined = a.version ? p.versions.find((x) => x.id === a.version) : p.versions[p.versions.length - 1];
      if (!v) throw new ToolError('ไม่พบเวอร์ชัน ต้อง build ก่อน / unknown version: build first', { versions: p.versions.map((x) => x.id) });
      let plan;
      try { plan = versionPlan(p, v); } catch (e) { throw new ToolError(e instanceof Error ? e.message : String(e)); }
      const fps = plan.fps;
      const tol = a.toleranceFrames ?? Math.round(fps);
      const { shots, how } = resolveShots(p, board, plan.shots as Array<ReviewShot & { slot?: string }>);
      const cmp = compareBoardToCut(board, shots, plan.frames, fps, tol);
      const wantFrames = a.frames ?? true;
      if (wantFrames) requireFfmpeg(state);
      return runJob(state, 'board_vs_cut', async (ctx) => {
        const outDir = join(state.api.project.projectPaths(p).out, v.id);
        await mkdir(outDir, { recursive: true });
        const notes: string[] = [];
        if (how['marker'] || how['source']) notes.push(`slot ของ ${how['marker']! + how['source']!} คลิปเดาจาก marker/ชื่อไฟล์ — ยืนยันด้วย board_link / ${how['marker']! + how['source']!} slot(s) inferred`);
        if (how['timeline']) notes.push(`slot ของ ${how['timeline']} คลิปมาจากไทม์ไลน์ปัจจุบัน (เวอร์ชันนี้ build ก่อนผูก slot) / taken from the live timeline`);
        const images = new Map<string, ReportImages>();
        const master = v.master;
        const masterOk = !!master && existsSync(master);
        let imgDir: string | undefined;
        if (wantFrames && !masterOk) notes.push(`ไม่พบไฟล์ master ${master ?? ''} — ไม่มีเฟรมจากคัท / master not found`);
        const cutAfter = new Map((plan.cuts ?? []).filter((c) => c.dissolve > 0).map((c) => [c.after, c.dissolve]));
        const realised = cmp.slots.filter((s) => s.cutStart !== undefined);
        if (wantFrames && masterOk && realised.length) imgDir = await uniqueDir(join(outDir, 'board_vs_cut_frames'));
        let done = 0;
        for (const s of cmp.slots) {
          const img: ReportImages = {};
          if (s.thumb && existsSync(s.thumb)) img.board = htmlHref(s.thumb, outDir);
          if (imgDir && s.cutStart !== undefined) {
            // a few frames in, past the incoming dissolve, so the grab shows this slot and not the blend
            const idx = plan.shots.findIndex((x) => x.id === s.clips[0]);
            const prevId = idx > 0 ? plan.shots[idx - 1]!.id : undefined;
            const inB = prevId && cutAfter.has(prevId) ? splitDissolve(cutAfter.get(prevId)!).b : 0;
            const frame = s.cutStart + Math.min(Math.max(0, (s.cutDur ?? 1) - 1), inB + 2);
            const file = join(imgDir, `${String(done + 1).padStart(3, '0')}_${s.slot.replace(/[^A-Za-z0-9_-]/g, '_')}.jpg`);
            if (await grabFrame(state, master, frame, fps, file, ctx.signal)) { img.cut = htmlHref(file, outDir); img.cutFrame = frame; }
            else ctx.log(`frame grab failed for slot ${s.slot} @ ${frame}`);
            done++;
            ctx.progress({ stage: 'frames', done, total: realised.length });
          }
          images.set(s.slot, img);
        }
        const html = renderBoardVsCutHtml(cmp, { title: `${p.meta.name} · ${basename(board.source)}`, version: v.id, ...(masterOk ? { master } : {}), images, notes });
        const report = await writeUnique(join(outDir, 'board_vs_cut.html'), html);
        return {
          ok: !cmp.issues.some((i) => i.severity === 'error'),
          version: v.id, report, framesDir: imgDir, slotSource: how, notes,
          summary: cmp.summary, total: cmp.total, missing: cmp.missing, extra: cmp.extra, moved: cmp.moved,
          chapters: cmp.chapters, slots: cmp.slots.map(({ thumb: _t, onScreenText: _o, ...rest }) => rest), issues: cmp.issues,
        };
      });
    },
  }),

  tool({
    name: 'fit_duration',
    description: 'เสนอความยาวคลิปใหม่ให้ไทม์ไลน์ยาวตามเป้า (ค่าเริ่มต้น = targetFrames ของบอร์ด) โดยกระจาย slack ภายใน handle ต้นทางและ dissolve: proportional (ทุกคลิปตามสัดส่วน), tail (จากท้าย), cards (คลิป card/logo/ภาพนิ่ง/comp ก่อน); ตรวจด้วย validateTimeline; dry run เป็นค่าเริ่มต้น, apply สำรองไทม์ไลน์ใน history/ ก่อน · Fit the timeline to a target duration',
    input: {
      targetFrames: z.number().int().positive().optional(),
      target: z.string().optional().describe('alternative to targetFrames: "3:00"'),
      strategy: z.enum(['proportional', 'tail', 'cards']).optional().describe('default proportional'),
      flexible: z.array(z.string()).optional().describe('clip or slot ids that may absorb the change first (strategy cards); default: guessed'),
      lock: z.array(z.string()).optional().describe('clip or slot ids never changed'),
      shiftAudio: z.boolean().optional().describe('move vo/sfx clips placed after a changed clip by the same amount (default false)'),
      apply: z.boolean().optional(),
    },
    mutating: true,
    writesProject: true,
    handler: async (a, state) => {
      const p = requireProject(state);
      const fps = p.meta.fps;
      const board = await loadBoard(p);
      const target = a.targetFrames ?? targetFrom(a.target, fps) ?? board?.targetFrames;
      if (target === undefined) throw new ToolError('ไม่มีความยาวเป้าหมาย — ส่ง targetFrames/target หรือใส่ target ในบอร์ด / no target: pass targetFrames or set board target');
      if (!p.timeline.video.length) throw new ToolError('ไทม์ไลน์ว่าง / timeline is empty');
      const prop = proposeFit(p, {
        targetFrames: target, strategy: a.strategy ?? 'proportional',
        ...(board ? { board } : {}), ...(a.flexible ? { flexible: a.flexible } : {}), ...(a.lock ? { lock: a.lock } : {}), ...(a.shiftAudio ? { shiftAudio: true } : {}),
      });
      const summary = {
        strategy: prop.strategy,
        current: { frames: prop.currentFrames, tc: framesToTc(prop.currentFrames, fps) },
        target: { frames: prop.targetFrames, tc: framesToTc(prop.targetFrames, fps) },
        proposed: { frames: prop.achievedFrames, tc: framesToTc(prop.achievedFrames, fps) },
        delta: prop.delta, remaining: prop.remaining, flexible: prop.flexible,
        changes: prop.changes, notes: prop.notes, errors: prop.errors,
      };
      const reached = prop.remaining === 0;
      if (!a.apply) {
        return {
          ok: prop.errors.length === 0, dryRun: true, applied: false, reached, ...summary,
          hint: prop.errors.length ? 'ข้อเสนอไม่ผ่าน validateTimeline (ดู errors) / proposal invalid' : 'ตรวจแล้วเรียกซ้ำด้วย apply: true / review, then apply: true',
        };
      }
      if (prop.errors.length) throw new ToolError('ข้อเสนอไม่ผ่านการตรวจสอบ ไม่ได้บันทึก / proposal invalid, not applied', summary);
      if (!prop.changes.length) return { ok: true, applied: false, reached, ...summary, note: 'ไม่มีอะไรเปลี่ยน / nothing to change' };
      const backup = await backupTimeline(p, `before fit_duration ${prop.strategy} → ${target}`);
      state.api.project.setTimeline(p, prop.timeline);
      await state.api.project.saveProject(p);
      return { ok: true, applied: true, reached, backup, ...summary, hint: 'ย้อนกลับได้ด้วย timeline_restore / undo with timeline_restore' };
    },
  }),
];
