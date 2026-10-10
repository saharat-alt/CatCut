/**
 * Storyboard / brief ("บอร์ด") import, self-consistency check, board-vs-cut comparison and
 * fit-to-duration proposals. The board is the highest authority for an edit (DESIGN §13.2.1):
 * nothing here invents style rules; it only reads what the board says and measures deviations.
 * All times are frames at the project fps.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { z } from 'zod';
import { validateTimeline } from '../core/project.js';
import { framesToTc, splitDissolve, tcToFrames } from '../core/timecode.js';
import type { Asset, Board, BoardSlot, Clip, Frames, Project, QcIssue, Timeline } from '../core/types.js';

// ---------- time strings ----------

/**
 * Board time → frames. Accepts "HH:MM:SS:FF", "MM:SS:FF", "M:SS" (minutes:seconds), "M.SS" with two
 * digits after the dot ("0.03" = 3 s, the usual way boards write source TC), "12s" / "12 วิ" / "1.5 sec",
 * "40f", and a bare number = seconds. Returns undefined when it cannot be read.
 */
export function parseBoardTime(input: string | number, fps: number): Frames | undefined {
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * fps) : undefined;
  const s = input.trim().replace(/\s+/g, ' ');
  if (!s) return undefined;
  let m: RegExpExecArray | null;
  if ((m = /^(\d+)\s*(?:f|fr|frames?|เฟรม)$/i.exec(s))) return parseInt(m[1]!, 10);
  if ((m = /^(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?|วิ|วินาที)\.?$/i.exec(s))) return Math.round(parseFloat(m[1]!) * fps);
  if (/^\d{1,2}[:;]\d{2}[:;]\d{2}[:;]\d{2}$/.test(s) || /^\d{1,2}:\d{2}[:;]\d{2}$/.test(s)) {
    try { return tcToFrames(s, fps); } catch { return undefined; }
  }
  if ((m = /^(\d{1,3}):(\d{2})(?:\.(\d+))?$/.exec(s))) {
    const sec = parseInt(m[2]!, 10);
    if (sec >= 60) return undefined;
    const frac = m[3] ? parseFloat(`0.${m[3]}`) : 0;
    return Math.round((parseInt(m[1]!, 10) * 60 + sec + frac) * fps);
  }
  if ((m = /^(\d{1,3})\.(\d{2})$/.exec(s)) && parseInt(m[2]!, 10) < 60) return Math.round((parseInt(m[1]!, 10) * 60 + parseInt(m[2]!, 10)) * fps);
  if (/^\d+(?:\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * fps);
  return undefined;
}

// ---------- schema (shared by JSON/CSV import and board_set) ----------

const int = z.number().int();
const SlotStatus = z.enum(['ok', 'mockup', 'substitute', 'missing']);

export const BoardSlotInputSchema = z.object({
  id: z.string().trim().min(1).describe('slot id as written on the board: "01", "28r" ...'),
  order: int.optional().describe('position on the board (default: list order, 1-based)'),
  chapter: z.string().optional(),
  boardStartFrame: int.min(0).optional().describe('where the board places this slot (frames)'),
  boardDurFrames: int.min(1).optional().describe('board duration (frames)'),
  boardStart: z.string().optional().describe('alternative to boardStartFrame: "0:12", "00:00:12:00", "12s"'),
  boardDur: z.string().optional().describe('alternative to boardDurFrames: "5s", "0:05"'),
  sourceHint: z.string().optional().describe('file / folder named on the board'),
  sourceTc: z.string().optional().describe('source timecode written on the board, verbatim (e.g. "0.03")'),
  onScreenText: z.string().optional().describe('exact on-screen text'),
  notes: z.string().optional(),
  thumb: z.string().optional().describe('path to the board thumbnail image for this slot'),
  status: SlotStatus.optional(),
}).strict();

const ChapterInputSchema = z.object({
  name: z.string().trim().min(1),
  startFrame: int.min(0).optional(),
  durFrames: int.min(1).optional(),
  start: z.string().optional(),
  dur: z.string().optional(),
}).strict();

export const BoardInputSchema = z.object({
  source: z.string().optional().describe('board file path (default: keeps the current board source)'),
  importedAt: z.string().optional(),
  targetFrames: int.min(1).optional().describe('total target duration (frames)'),
  target: z.string().optional().describe('alternative to targetFrames: "3:00"'),
  chapters: z.array(ChapterInputSchema).optional(),
  slots: z.array(BoardSlotInputSchema).min(1),
  warnings: z.array(z.string()).optional(),
}).strict();

export type BoardInput = z.infer<typeof BoardInputSchema>;
type SlotInput = z.infer<typeof BoardSlotInputSchema>;

/** Validated input → Board (time strings converted to frames). Errors are human-readable (Thai + English). */
export function normalizeBoard(input: BoardInput, fps: number, source: string): { board?: Board; errors: string[] } {
  const errors: string[] = [];
  const pick = (frames: number | undefined, str: string | undefined, what: string): Frames | undefined => {
    if (str === undefined || str.trim() === '') return frames;
    const f = parseBoardTime(str, fps);
    if (f === undefined) { errors.push(`${what}: อ่านเวลา "${str}" ไม่ได้ / unreadable time`); return frames; }
    if (frames !== undefined && frames !== f) errors.push(`${what}: ค่าเฟรม ${frames} ขัดกับ "${str}" (= ${f}) / frames and time string disagree`);
    return f;
  };
  const slots: BoardSlot[] = input.slots.map((s: SlotInput, i) => {
    const out: BoardSlot = { id: s.id.trim(), order: s.order ?? i + 1 };
    const start = pick(s.boardStartFrame, s.boardStart, `slot ${s.id} start`);
    const dur = pick(s.boardDurFrames, s.boardDur, `slot ${s.id} dur`);
    if (dur !== undefined && dur <= 0) errors.push(`slot ${s.id}: ความยาวต้อง > 0 / dur must be > 0`);
    if (s.chapter?.trim()) out.chapter = s.chapter.trim();
    if (start !== undefined) out.boardStartFrame = start;
    if (dur !== undefined) out.boardDurFrames = dur;
    for (const k of ['sourceHint', 'sourceTc', 'onScreenText', 'notes', 'thumb'] as const) {
      const v = s[k];
      if (v !== undefined && v.trim() !== '') out[k] = k === 'onScreenText' ? v : v.trim();
    }
    if (s.status) out.status = s.status;
    return out;
  });
  const board: Board = { source: input.source ?? source, importedAt: input.importedAt ?? new Date().toISOString(), slots };
  const target = pick(input.targetFrames, input.target, 'target');
  if (target !== undefined) board.targetFrames = target;
  if (input.chapters?.length) {
    board.chapters = input.chapters.map((c) => {
      const ch: NonNullable<Board['chapters']>[number] = { name: c.name.trim() };
      const st = pick(c.startFrame, c.start, `chapter ${c.name} start`);
      const du = pick(c.durFrames, c.dur, `chapter ${c.name} dur`);
      if (st !== undefined) ch.startFrame = st;
      if (du !== undefined) ch.durFrames = du;
      return ch;
    });
  } else {
    const names = [...new Set(slots.map((s) => s.chapter).filter((c): c is string => !!c))];
    if (names.length) board.chapters = names.map((name) => ({ name }));
  }
  if (input.warnings?.length) board.warnings = [...input.warnings];
  return errors.length ? { errors } : { board, errors };
}

function zodIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
}

// ---------- CSV ----------

/** RFC 4180-ish: quotes, doubled quotes, CR/LF; delimiter auto-detected from the first line (, ; tab). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const first = src.split(/\r?\n/, 1)[0] ?? '';
  const count = (ch: string) => first.split(ch).length - 1;
  const delim = [',', ';', '\t'].reduce((best, d) => (count(d) > count(best) ? d : best), ',');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const CSV_COLUMNS = ['id', 'order', 'chapter', 'boardStartFrame', 'boardDurFrames', 'boardStart', 'boardDur', 'sourceHint', 'sourceTc', 'onScreenText', 'notes', 'thumb', 'status'] as const;

/**
 * CSV board. Header row = BoardSlot field names (case-insensitive, strict: unknown columns are errors).
 * Directive rows: `#target,3:00` and `#chapter,<name>,<start>,<dur>`; other rows starting with # are comments.
 */
export function boardInputFromCsv(text: string): { input?: BoardInput; errors: string[] } {
  const rows = parseCsv(text);
  const errors: string[] = [];
  const directives = rows.filter((r) => r[0]!.trim().startsWith('#'));
  const data = rows.filter((r) => !r[0]!.trim().startsWith('#'));
  const header = data.shift();
  if (!header) return { errors: ['CSV ว่าง ไม่มีแถวหัวตาราง / empty CSV: no header row'] };
  const lookup = new Map<string, (typeof CSV_COLUMNS)[number]>(CSV_COLUMNS.map((c) => [c.toLowerCase(), c]));
  const cols = header.map((h) => lookup.get(h.trim().toLowerCase()));
  header.forEach((h, i) => { if (!cols[i] && h.trim()) errors.push(`คอลัมน์ไม่รู้จัก "${h.trim()}" / unknown column (allowed: ${CSV_COLUMNS.join(', ')})`); });
  if (!cols.includes('id')) errors.push('ต้องมีคอลัมน์ id / missing required column: id');
  if (errors.length) return { errors };
  const input: BoardInput = { slots: [] };
  const chapters: NonNullable<BoardInput['chapters']> = [];
  for (const d of directives) {
    const key = d[0]!.trim().toLowerCase();
    if (key === '#target' && d[1]?.trim()) input.target = d[1].trim();
    else if (key === '#chapter' && d[1]?.trim()) {
      const ch: (typeof chapters)[number] = { name: d[1].trim() };
      if (d[2]?.trim()) ch.start = d[2].trim();
      if (d[3]?.trim()) ch.dur = d[3].trim();
      chapters.push(ch);
    }
  }
  if (chapters.length) input.chapters = chapters;
  data.forEach((r, ri) => {
    const slot: Record<string, unknown> = {};
    cols.forEach((c, i) => {
      const v = (r[i] ?? '').trim() === '' ? undefined : r[i]!;
      if (!c || v === undefined) return;
      if (c === 'order' || c === 'boardStartFrame' || c === 'boardDurFrames') {
        if (!/^-?\d+$/.test(v.trim())) errors.push(`แถว ${ri + 2} ${c}: ต้องเป็นจำนวนเต็ม "${v}" / must be an integer`);
        else slot[c] = parseInt(v.trim(), 10);
      } else slot[c] = c === 'onScreenText' ? v : v.trim();
    });
    if (r.length > header.length && r.slice(header.length).some((x) => x.trim())) errors.push(`แถว ${ri + 2}: มีคอลัมน์เกินหัวตาราง / more cells than header columns`);
    input.slots.push(slot as SlotInput);
  });
  if (errors.length) return { errors };
  const parsed = BoardInputSchema.safeParse(input);
  return parsed.success ? { input: parsed.data, errors: [] } : { errors: zodIssues(parsed.error) };
}

/** JSON board: a Board-like object ({slots, targetFrames?, chapters?}) or a bare array of slots. */
export function boardInputFromJson(text: string): { input?: BoardInput; errors: string[] } {
  let data: unknown;
  try { data = JSON.parse(text.replace(/^﻿/, '')); } catch (e) {
    return { errors: [`JSON ไม่ถูกต้อง / invalid JSON: ${(e as Error).message}`] };
  }
  if (Array.isArray(data)) data = { slots: data };
  const parsed = BoardInputSchema.safeParse(data);
  return parsed.success ? { input: parsed.data, errors: [] } : { errors: zodIssues(parsed.error) };
}

// ---------- PDF ----------

export interface PdfMeta {
  pages: number;
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  created?: string; // ISO
  modified?: string; // ISO
}

export interface PdfPageText {
  page: number;
  width: number;
  height: number;
  /** reading-order lines; cells separated by " | " where the gap is wide (table columns) */
  lines: string[];
}

export interface PdfDetection {
  page: number;
  line: string;
  kind: 'slot' | 'chapter' | 'target';
  value: string;
  confidence: 'high' | 'low';
}

/** "D:20261010120000+07'00'" → ISO string (undefined when unreadable). */
export function pdfDateToIso(s: unknown): string | undefined {
  if (typeof s !== 'string') return undefined;
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?)?/.exec(s.trim());
  if (!m) return undefined;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00', tz] = m;
  let zone = 'Z';
  if (tz && tz !== 'Z') zone = `${tz.slice(0, 3)}:${tz.replace(/'/g, '').slice(3, 5) || '00'}`;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}${zone}`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

interface TextItemLike { str: string; transform: number[]; width: number; height: number }

/** Group positioned text items into lines (top → bottom, left → right). */
function itemsToLines(items: TextItemLike[]): string[] {
  const cells = items
    .filter((it) => it.str.trim() !== '')
    .map((it) => ({ x: it.transform[4] ?? 0, y: it.transform[5] ?? 0, w: it.width, h: Math.abs(it.height || it.transform[3] || 10), s: it.str }));
  cells.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Array<{ y: number; h: number; cells: typeof cells }> = [];
  for (const c of cells) {
    const line = lines.find((l) => Math.abs(l.y - c.y) <= Math.max(2, 0.4 * Math.min(l.h, c.h)));
    if (line) line.cells.push(c); else lines.push({ y: c.y, h: c.h, cells: [c] });
  }
  lines.sort((a, b) => b.y - a.y);
  return lines.map((l) => {
    l.cells.sort((a, b) => a.x - b.x);
    let out = '';
    let end: number | undefined;
    for (const c of l.cells) {
      if (end !== undefined) {
        const gap = c.x - end;
        out += gap > 1.5 * c.h ? ' | ' : gap > 0.15 * c.h && !out.endsWith(' ') && !c.s.startsWith(' ') ? ' ' : '';
      }
      out += c.s;
      end = c.x + c.w;
    }
    return out.replace(/\s+/g, ' ').trim();
  }).filter(Boolean);
}

async function pdfjsAssets(): Promise<{ cMapUrl?: string; standardFontDataUrl?: string }> {
  try {
    const require = createRequire(import.meta.url);
    const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
    return { cMapUrl: `${path.join(root, 'cmaps')}${path.sep}`, standardFontDataUrl: `${path.join(root, 'standard_fonts')}${path.sep}` };
  } catch {
    return {};
  }
}

/** Text per page (with positions folded into reading-order lines) + document metadata. */
export async function readPdfText(data: Uint8Array): Promise<{ meta: PdfMeta; pages: PdfPageText[] }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0, ...(await pdfjsAssets()),
  }).promise;
  try {
    const md = await doc.getMetadata().catch(() => undefined);
    const info = (md?.info ?? {}) as Record<string, unknown>;
    const str = (k: string): string | undefined => (typeof info[k] === 'string' && (info[k] as string).trim() ? (info[k] as string).trim() : undefined);
    const xmp = md?.metadata;
    const xmpGet = (k: string): string | undefined => {
      try { const v = xmp?.get(k); return typeof v === 'string' && v.trim() ? v.trim() : undefined; } catch { return undefined; }
    };
    const meta: PdfMeta = { pages: doc.numPages };
    const set = <K extends keyof PdfMeta>(k: K, v: PdfMeta[K] | undefined) => { if (v !== undefined) meta[k] = v; };
    set('title', str('Title') ?? xmpGet('dc:title'));
    set('author', str('Author') ?? xmpGet('dc:creator'));
    set('subject', str('Subject'));
    set('keywords', str('Keywords'));
    set('creator', str('Creator') ?? xmpGet('xmp:creatortool'));
    set('producer', str('Producer'));
    set('created', pdfDateToIso(info['CreationDate']) ?? xmpGet('xmp:createdate'));
    set('modified', pdfDateToIso(info['ModDate']) ?? xmpGet('xmp:modifydate'));
    const pages: PdfPageText[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items = tc.items.filter((it): it is TextItemLike & typeof it => 'str' in it) as unknown as TextItemLike[];
      pages.push({ page: n, width: Math.round(vp.width), height: Math.round(vp.height), lines: itemsToLines(items) });
      page.cleanup();
    }
    return { meta, pages };
  } finally {
    await doc.destroy();
  }
}

const SLOT_LINE_RE = /^(?:(?:shot|sc(?:ene)?|cut|ช็อต|ช็อท|ช๊อต|ฉาก|คัท)\s*[#.:]?\s*)?(\d{1,3}[a-z]{0,2})(?=$|\s|[|)\]](?!\d)|[.:\-–](?!\d))/i;
const CHAPTER_RE = /^(?:chapter|ch\.|part|บทที่|ตอนที่|ช่วงที่|ชาปเตอร์|แชปเตอร์|ชัพเตอร์)\s*[:#.]?\s*\S/i;
const TARGET_RE = /(?:total|duration|length|ความยาว(?:รวม)?|รวม(?:ทั้งหมด)?|ยาว)\s*[:：=]?\s*(\d{1,2}:\d{2}(?:[:;]\d{2}){0,2}|\d+(?:\.\d+)?\s*(?:s|sec|วิ|วินาที|min|นาที))/i;
const TIME_TOKEN = String.raw`\d{1,2}:\d{2}(?:[:;]\d{2}){0,2}`;
const RANGE_RE = new RegExp(String.raw`(${TIME_TOKEN})\s*(?:-|–|—|~|to|ถึง)\s*(${TIME_TOKEN})`, 'i');
const TIME_RE = new RegExp(String.raw`(?<![\d.:])(${TIME_TOKEN})(?![\d:])`);
const DOT_TC_RE = /(?<![\d.:])(\d{1,2}\.\d{2})(?![\d.:]|\s*(?:s|sec|วิ))/;
const DUR_RE = /(?<![\d.:])(\d+(?:\.\d+)?)\s*(?:s|sec|secs|วิ|วินาที)(?![a-z])/i;
const QUOTE_RE = /[“"«‘]([^”"»’]{1,400})[”"»’]/g;
const FILE_RE = /[\p{L}\p{M}\p{N}_\-.()]+\.(?:mp4|mov|mxf|m4v|avi|mts|r3d|braw|png|jpe?g|tiff?|psd|ai|aep|wav|mp3|gif|webp)\b/iu;

function minutesTime(s: string, fps: number): Frames | undefined {
  return parseBoardTime(s, fps);
}

/** Pull slot fields out of one slot's text (row + continuation lines). Exported for tests. */
export function parseSlotText(text: string, fps: number): Partial<BoardSlot> {
  const out: Partial<BoardSlot> = {};
  let rest = text;
  const quotes = [...rest.matchAll(QUOTE_RE)].map((m) => m[1]!.trim()).filter(Boolean);
  if (quotes.length) out.onScreenText = quotes.join(' / ');
  rest = rest.replace(QUOTE_RE, ' ');
  const file = FILE_RE.exec(rest);
  if (file) { out.sourceHint = file[0]; rest = rest.replace(file[0], ' '); }
  const range = RANGE_RE.exec(rest);
  if (range) {
    const a = minutesTime(range[1]!, fps);
    const b = minutesTime(range[2]!, fps);
    if (a !== undefined) out.boardStartFrame = a;
    if (a !== undefined && b !== undefined && b > a) out.boardDurFrames = b - a;
    rest = rest.replace(range[0], ' ');
  } else {
    const t = TIME_RE.exec(rest);
    if (t) {
      const a = minutesTime(t[1]!, fps);
      if (a !== undefined) out.boardStartFrame = a;
      rest = rest.replace(t[0], ' ');
    }
  }
  const dur = DUR_RE.exec(rest);
  if (dur) {
    if (out.boardDurFrames === undefined) out.boardDurFrames = Math.round(parseFloat(dur[1]!) * fps);
    rest = rest.replace(dur[0], ' ');
  }
  const dot = DOT_TC_RE.exec(rest);
  if (dot) { out.sourceTc = dot[1]!; rest = rest.replace(dot[0], ' '); }
  if (/mock-?up|ม็อค|ม็อก|มอคอัพ/i.test(text)) out.status = 'mockup';
  const notes = rest.replace(/\s*\|\s*/g, ' | ').replace(/(?:\s*\|\s*)+$/, '').replace(/^(?:\s*\|\s*)+/, '').replace(/\s+/g, ' ').trim();
  if (notes && notes !== '|') out.notes = notes;
  return out;
}

/** Heuristic draft board from PDF text. The agent (reading the PDF visually) corrects it with board_set. */
export function draftBoardFromPdfText(pages: PdfPageText[], fps: number, source: string): { board: Board; detections: PdfDetection[]; warnings: string[] } {
  const detections: PdfDetection[] = [];
  const warnings: string[] = [];
  const slots: BoardSlot[] = [];
  const chapters: NonNullable<Board['chapters']> = [];
  let target: Frames | undefined;
  let chapter: string | undefined;
  let current: { slot: BoardSlot; text: string[]; page: number } | undefined;
  const flush = () => {
    if (!current) return;
    const { slot, text } = current;
    const body = text.join(' | ').replace(SLOT_LINE_RE, '').trim();
    Object.assign(slot, parseSlotText(body, fps));
    slots.push(slot);
    current = undefined;
  };
  for (const pg of pages) {
    for (const line of pg.lines) {
      const tm = TARGET_RE.exec(line);
      if (tm && target === undefined && !SLOT_LINE_RE.test(line)) {
        const f = /min|นาที/i.test(tm[1]!) ? Math.round(parseFloat(tm[1]!) * 60 * fps) : parseBoardTime(tm[1]!, fps);
        if (f !== undefined) { target = f; detections.push({ page: pg.page, line, kind: 'target', value: framesToTc(f, fps), confidence: 'high' }); continue; }
      }
      if (CHAPTER_RE.test(line)) {
        flush();
        const range = RANGE_RE.exec(line);
        const name = line.replace(RANGE_RE, '').replace(/\s*\|\s*/g, ' ').replace(/\s+/g, ' ').trim();
        const ch: (typeof chapters)[number] = { name };
        if (range) {
          const a = parseBoardTime(range[1]!, fps);
          const b = parseBoardTime(range[2]!, fps);
          if (a !== undefined) ch.startFrame = a;
          if (a !== undefined && b !== undefined && b > a) ch.durFrames = b - a;
        }
        chapters.push(ch);
        chapter = name;
        detections.push({ page: pg.page, line, kind: 'chapter', value: name, confidence: 'high' });
        continue;
      }
      const sm = SLOT_LINE_RE.exec(line);
      if (sm) {
        flush();
        const id = sm[1]!;
        const lone = line.trim() === sm[0].trim();
        const slot: BoardSlot = { id, order: slots.length + 1 };
        if (chapter) slot.chapter = chapter;
        current = { slot, text: [line], page: pg.page };
        detections.push({ page: pg.page, line, kind: 'slot', value: id, confidence: lone && id.length < 2 ? 'low' : 'high' });
        continue;
      }
      if (current && current.page === pg.page) current.text.push(line);
    }
    flush();
  }
  // durations from the next slot's start, the last one from the target
  slots.forEach((s, i) => {
    if (s.boardDurFrames !== undefined || s.boardStartFrame === undefined) return;
    const next = slots.slice(i + 1).find((n) => n.boardStartFrame !== undefined);
    const end = next?.boardStartFrame ?? (i === slots.length - 1 ? target : undefined);
    if (end !== undefined && end > s.boardStartFrame) {
      s.boardDurFrames = end - s.boardStartFrame;
      warnings.push(`slot ${s.id}: ความยาวคำนวณจากเวลาเริ่มของช็อตถัดไป (${s.boardDurFrames} เฟรม) — ตรวจกับบอร์ด / duration derived from the next start`);
    }
  });
  if (!slots.length) warnings.push('ไม่พบแถว slot ในข้อความ PDF — ให้ Claude ดู PDF ด้วยตา แล้วส่งบอร์ดที่ถูกต้องด้วย board_set / no slot rows detected');
  else warnings.push(`ร่างจากข้อความ PDF แบบ heuristic (${slots.length} slot) — Claude ต้องเทียบกับภาพ PDF แล้วแก้ด้วย board_set / heuristic draft: verify against the PDF visually`);
  const board: Board = { source, importedAt: new Date().toISOString(), slots };
  if (target !== undefined) board.targetFrames = target;
  if (chapters.length) board.chapters = chapters;
  return { board, detections, warnings };
}

// ---------- import (any format) ----------

export interface BoardFileInfo {
  path: string;
  name: string;
  size: number;
  modified: string; // file mtime, ISO
  sha256: string;
}

export interface BoardSibling { name: string; modified: string; size: number; newer: boolean }

export interface BoardImportResult {
  format: 'pdf' | 'csv' | 'json';
  file: BoardFileInfo;
  pdf?: PdfMeta;
  pages?: PdfPageText[];
  detections?: PdfDetection[];
  board?: Board;
  errors: string[];
  warnings: string[];
  /** version-ish strings found in the file name / title / first page ("v3", "rev2", "final", "ฉบับที่ 2", dates) */
  versionHints: string[];
  /** other board-like files in the same folder; `newer` ones may be the real latest board */
  siblings: BoardSibling[];
}

const VERSION_RES: RegExp[] = [
  /\b(?:v|ver\.?|version)\s?\d+(?:\.\d+)*\b/gi,
  /\brev(?:ision)?\.?\s?\d+\b/gi,
  /\b(?:final\w*|draft|approved|latest)\b/gi,
  /(?:ฉบับ(?:ที่)?|แก้ไข(?:ครั้งที่)?|แก้(?:ครั้งที่)?|เวอร์ชั่?น)\s?\d+/g,
  /(?:ฉบับ)?(?:สมบูรณ์|ล่าสุด|แก้ไข|อนุมัติ)/g,
  /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g,
  /(?<!\d)(?:2[4-9]|3\d)(?:0[1-9]|1[0-2])(?:[0-2]\d|3[01])(?!\d)/g, // YYMMDD in file names (e.g. 261010)
];

export function versionHints(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const re of VERSION_RES) for (const m of t.matchAll(re)) out.add(m[0].trim());
  return [...out];
}

async function siblingsOf(file: string, mtimeMs: number): Promise<BoardSibling[]> {
  const dir = path.dirname(file);
  const ext = path.extname(file).toLowerCase();
  const stem = path.basename(file, path.extname(file)).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const prefix = stem.slice(0, 4);
  let names: string[] = [];
  try { names = await readdir(dir); } catch { return []; }
  const out: BoardSibling[] = [];
  for (const n of names) {
    if (n === path.basename(file)) continue;
    const e = path.extname(n).toLowerCase();
    if (!['.pdf', '.csv', '.json'].includes(e)) continue;
    const s = path.basename(n, path.extname(n)).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const related = (e === ext && prefix.length >= 3 && s.startsWith(prefix)) || /board|บอร์ด|story|สตอรี่/i.test(n);
    if (!related) continue;
    const st = await stat(path.join(dir, n)).catch(() => undefined);
    if (!st?.isFile()) continue;
    out.push({ name: n, modified: st.mtime.toISOString(), size: st.size, newer: st.mtimeMs > mtimeMs + 1000 });
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, 20);
}

/** Read a board file (PDF/CSV/JSON). Never writes anything. */
export async function importBoardFile(file: string, fps: number, opts: { target?: string | number } = {}): Promise<BoardImportResult> {
  const abs = path.resolve(file);
  const st = await stat(abs).catch(() => undefined);
  if (!st?.isFile()) throw new Error(`ไม่พบไฟล์ / file not found: ${abs}`);
  const buf = await readFile(abs);
  const info: BoardFileInfo = {
    path: abs, name: path.basename(abs), size: st.size, modified: st.mtime.toISOString(),
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
  const ext = path.extname(abs).toLowerCase();
  const isPdf = buf.subarray(0, 5).toString('latin1') === '%PDF-';
  const format: BoardImportResult['format'] = isPdf || ext === '.pdf' ? 'pdf' : ext === '.csv' || ext === '.tsv' || ext === '.txt' ? 'csv' : ext === '.json' ? 'json' : 'csv';
  const result: BoardImportResult = { format, file: info, errors: [], warnings: [], versionHints: [], siblings: await siblingsOf(abs, st.mtimeMs) };
  const hintTexts = [info.name];
  if (format === 'pdf') {
    const { meta, pages } = await readPdfText(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    result.pdf = meta;
    result.pages = pages;
    if (meta.title) hintTexts.push(meta.title);
    hintTexts.push(...(pages[0]?.lines.slice(0, 8) ?? []));
    const draft = draftBoardFromPdfText(pages, fps, abs);
    result.board = draft.board;
    result.detections = draft.detections;
    result.warnings.push(...draft.warnings);
    if (!pages.some((p) => p.lines.length)) result.warnings.push('PDF ไม่มีชั้นข้อความ (อาจเป็นภาพสแกน) — ต้องอ่านด้วยตาแล้วใช้ board_set / PDF has no text layer');
  } else {
    const text = buf.toString('utf8');
    const parsed = format === 'json' ? boardInputFromJson(text) : boardInputFromCsv(text);
    result.errors.push(...parsed.errors);
    if (parsed.input) {
      const n = normalizeBoard(parsed.input, fps, abs);
      result.errors.push(...n.errors);
      if (n.board) result.board = n.board;
    }
  }
  if (result.board && opts.target !== undefined) {
    const t = typeof opts.target === 'number' ? opts.target : parseBoardTime(opts.target, fps);
    if (t === undefined || t <= 0) result.errors.push(`target "${opts.target}" อ่านไม่ได้ / unreadable target`);
    else result.board.targetFrames = t;
  }
  result.versionHints = versionHints(hintTexts);
  const newer = result.siblings.filter((s) => s.newer);
  if (newer.length) result.warnings.push(`มีไฟล์บอร์ดที่ใหม่กว่าในโฟลเดอร์เดียวกัน: ${newer.map((s) => s.name).join(', ')} — ยืนยันกับผู้ใช้ว่าใช้ฉบับไหน / newer board-like files exist in the same folder`);
  return result;
}

// ---------- board self-consistency ----------

export interface BoardWarning {
  code: 'duplicate-id' | 'duplicate-order' | 'sequence-gap' | 'chapter-vs-slots' | 'chapter-start' | 'chapters-vs-target' | 'slots-vs-target'
    | 'slot-overlap' | 'slot-gap' | 'start-order' | 'text-mismatch' | 'status' | 'unknown-chapter' | 'footage-missing' | 'footage-orphan' | 'source-missing' | 'no-timing';
  severity: 'error' | 'warn' | 'info';
  message: string;
  slot?: string;
  chapter?: string;
}

const idKey = (id: string): { num?: number; suffix: string; key: string } => {
  const m = /^(\d+)([a-z]*)$/i.exec(id.trim());
  if (!m) return { suffix: '', key: id.trim().toLowerCase() };
  const num = parseInt(m[1]!, 10);
  return { num, suffix: m[2]!.toLowerCase(), key: `${num}${m[2]!.toLowerCase()}` };
};

function normText(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const n = a.length; const m = b.length;
  if (!n || !m) return 0;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[m]! / Math.max(n, m);
}

/** Contradictions inside the board. `fps` only formats timecodes in messages. */
export function checkBoard(board: Board, fps: number): BoardWarning[] {
  const w: BoardWarning[] = [];
  const tc = (f: number) => framesToTc(f, fps);
  const slots = [...board.slots].sort((a, b) => a.order - b.order);

  // duplicate ids (and conflicting repeated mentions)
  const byKey = new Map<string, BoardSlot[]>();
  for (const s of slots) { const k = idKey(s.id).key; byKey.set(k, [...(byKey.get(k) ?? []), s]); }
  for (const [, group] of byKey) {
    if (group.length < 2) continue;
    const texts = new Set(group.map((s) => s.onScreenText ?? '').filter(Boolean));
    const durs = new Set(group.map((s) => s.boardDurFrames).filter((d) => d !== undefined));
    const extra = [texts.size > 1 ? 'ข้อความต่างกัน' : '', durs.size > 1 ? 'ความยาวต่างกัน' : ''].filter(Boolean).join(', ');
    w.push({ code: 'duplicate-id', severity: 'error', slot: group[0]!.id, message: `slot ${group.map((s) => s.id).join(' / ')} ซ้ำกัน ${group.length} ครั้ง${extra ? ` (${extra})` : ''} / duplicate slot id` });
  }
  const orders = new Map<number, string[]>();
  for (const s of slots) orders.set(s.order, [...(orders.get(s.order) ?? []), s.id]);
  for (const [o, ids] of orders) if (ids.length > 1) w.push({ code: 'duplicate-order', severity: 'warn', message: `ลำดับ ${o} ใช้ซ้ำโดย slot ${ids.join(', ')} / duplicate order` });

  // numbering gaps (01, 02, 04 → 03 missing); "28r" counts as 28
  const nums = [...new Set(slots.map((s) => idKey(s.id).num).filter((n): n is number => n !== undefined))].sort((a, b) => a - b);
  for (let i = 1; i < nums.length; i++) {
    const gap = nums[i]! - nums[i - 1]!;
    if (gap > 1 && gap <= 20) {
      const missing = Array.from({ length: gap - 1 }, (_, k) => nums[i - 1]! + k + 1);
      const width = Math.max(2, slots[0]?.id.match(/^\d+/)?.[0].length ?? 2);
      w.push({ code: 'sequence-gap', severity: 'warn', message: `เลข slot ข้าม: ไม่มี ${missing.map((n) => String(n).padStart(width, '0')).join(', ')} (ระหว่าง ${nums[i - 1]} กับ ${nums[i]}) — ช็อตหลุดจากบอร์ดหรือตั้งใจตัด? / numbering gap` });
    }
  }

  // timing along the board
  const timed = slots.filter((s) => s.boardStartFrame !== undefined);
  for (let i = 1; i < timed.length; i++) {
    const a = timed[i - 1]!; const b = timed[i]!;
    if (b.boardStartFrame! < a.boardStartFrame!) {
      w.push({ code: 'start-order', severity: 'error', slot: b.id, message: `slot ${b.id} เริ่ม ${tc(b.boardStartFrame!)} ก่อน slot ${a.id} (${tc(a.boardStartFrame!)}) ทั้งที่อยู่ลำดับหลัง / start times go backwards` });
      continue;
    }
    if (a.boardDurFrames === undefined) continue;
    const end = a.boardStartFrame! + a.boardDurFrames;
    if (end > b.boardStartFrame!) w.push({ code: 'slot-overlap', severity: 'warn', slot: a.id, message: `slot ${a.id} จบ ${tc(end)} แต่ slot ${b.id} เริ่ม ${tc(b.boardStartFrame!)} (ซ้อน ${end - b.boardStartFrame!} เฟรม) / slots overlap` });
    else if (end < b.boardStartFrame!) w.push({ code: 'slot-gap', severity: 'warn', slot: a.id, message: `slot ${a.id} จบ ${tc(end)} แต่ slot ${b.id} เริ่ม ${tc(b.boardStartFrame!)} (ช่องว่าง ${b.boardStartFrame! - end} เฟรม) / gap between slots` });
  }

  // chapters
  const chapterNames = new Set((board.chapters ?? []).map((c) => c.name));
  for (const s of slots) if (s.chapter && board.chapters?.length && !chapterNames.has(s.chapter)) w.push({ code: 'unknown-chapter', severity: 'warn', slot: s.id, message: `slot ${s.id} อยู่ใน chapter "${s.chapter}" ที่ไม่มีในรายการ chapter / unknown chapter` });
  for (const ch of board.chapters ?? []) {
    const mine = slots.filter((s) => s.chapter === ch.name);
    if (!mine.length) continue;
    if (ch.durFrames !== undefined && mine.every((s) => s.boardDurFrames !== undefined)) {
      const sum = mine.reduce((t, s) => t + s.boardDurFrames!, 0);
      if (sum !== ch.durFrames) w.push({ code: 'chapter-vs-slots', severity: 'warn', chapter: ch.name, message: `chapter "${ch.name}" ยาว ${tc(ch.durFrames)} แต่รวมความยาว slot ได้ ${tc(sum)} (ต่าง ${sum - ch.durFrames} เฟรม) / chapter duration vs slot durations` });
    }
    const first = mine.find((s) => s.boardStartFrame !== undefined);
    if (ch.startFrame !== undefined && first && first === mine[0] && first.boardStartFrame !== ch.startFrame) {
      w.push({ code: 'chapter-start', severity: 'warn', chapter: ch.name, message: `chapter "${ch.name}" เริ่ม ${tc(ch.startFrame)} แต่ slot แรก (${first.id}) เริ่ม ${tc(first.boardStartFrame!)} (ต่าง ${first.boardStartFrame! - ch.startFrame} เฟรม) / chapter start vs first slot` });
    }
  }
  if (board.targetFrames !== undefined) {
    const chs = board.chapters ?? [];
    if (chs.length && chs.every((c) => c.durFrames !== undefined)) {
      const sum = chs.reduce((t, c) => t + c.durFrames!, 0);
      if (sum !== board.targetFrames) w.push({ code: 'chapters-vs-target', severity: 'warn', message: `รวมความยาว chapter = ${tc(sum)} แต่เป้าหมาย = ${tc(board.targetFrames)} (ต่าง ${sum - board.targetFrames} เฟรม) / chapters vs target` });
    }
    if (slots.length && slots.every((s) => s.boardDurFrames !== undefined)) {
      const sum = slots.reduce((t, s) => t + s.boardDurFrames!, 0);
      if (sum !== board.targetFrames) w.push({ code: 'slots-vs-target', severity: 'warn', message: `รวมความยาว slot = ${tc(sum)} แต่เป้าหมาย = ${tc(board.targetFrames)} (ต่าง ${sum - board.targetFrames} เฟรม) / slot durations vs target` });
    }
    const last = timed[timed.length - 1];
    if (last?.boardDurFrames !== undefined && last.boardStartFrame! + last.boardDurFrames !== board.targetFrames && !w.some((x) => x.code === 'slots-vs-target')) {
      w.push({ code: 'slots-vs-target', severity: 'warn', message: `slot สุดท้าย (${last.id}) จบ ${tc(last.boardStartFrame! + last.boardDurFrames)} แต่เป้าหมาย = ${tc(board.targetFrames)} / board end vs target` });
    }
  }
  if (!slots.some((s) => s.boardStartFrame !== undefined || s.boardDurFrames !== undefined)) {
    w.push({ code: 'no-timing', severity: 'info', message: 'บอร์ดไม่มีเวลาของ slot — เทียบ drift กับคัทไม่ได้ (เทียบได้แค่ลำดับ/ช็อตหาย) / board has no slot timing' });
  }

  // near-identical texts in different slots: likely a typo in one of the mentions
  const texts = slots.filter((s) => s.onScreenText && normText(s.onScreenText).length >= 4);
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i]!; const b = texts[j]!;
      if (idKey(a.id).key === idKey(b.id).key) continue;
      const na = normText(a.onScreenText!); const nb = normText(b.onScreenText!);
      if (na === nb || na.length > 300 || nb.length > 300) continue;
      const sim = similarity(na, nb);
      if (sim >= 0.8) w.push({ code: 'text-mismatch', severity: 'warn', slot: b.id, message: `ข้อความ slot ${a.id} "${a.onScreenText}" กับ slot ${b.id} "${b.onScreenText}" คล้ายกันแต่ไม่ตรงกัน (${Math.round(sim * 100)}%) — สะกดต่างกันหรือไม่? / near-identical on-screen texts differ` });
    }
  }
  for (const s of slots) {
    if (s.status && s.status !== 'ok') w.push({ code: 'status', severity: 'info', slot: s.id, message: `slot ${s.id} สถานะ ${s.status}${s.status === 'missing' ? ' (ยังไม่มีฟุตเทจ)' : s.status === 'mockup' ? ' (ภาพ mockup ต้องเปลี่ยนเป็นของจริง)' : ' (ใช้ภาพแทน)'} / slot status` });
  }
  return w;
}

// ---------- footage folder ↔ slots ----------

interface ScanEntry { rel: string; name: string; dir: boolean; depth: number; parent?: string }

async function scanDir(root: string, maxDepth: number, maxEntries = 5000): Promise<ScanEntry[]> {
  const out: ScanEntry[] = [];
  const walk = async (dir: string, depth: number, parentRel?: string): Promise<void> => {
    if (out.length >= maxEntries) return;
    let entries: import('node:fs').Dirent[];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= maxEntries) return;
      if (e.name.startsWith('.')) continue;
      const rel = parentRel ? `${parentRel}/${e.name}` : e.name;
      const entry: ScanEntry = { rel, name: e.name, dir: e.isDirectory(), depth };
      if (parentRel) entry.parent = parentRel;
      out.push(entry);
      if (e.isDirectory() && depth < maxDepth) await walk(path.join(dir, e.name), depth + 1, rel);
    }
  };
  await walk(root, 1);
  return out;
}

/** Leading slot id of a file/folder name ("01_city.mov" → 1, "28r-logo" → 28r). */
function leadingId(name: string): string | undefined {
  const m = /^(\d{1,4})([a-z]{0,2})(?=$|[^a-z0-9])/i.exec(name);
  return m ? `${parseInt(m[1]!, 10)}${m[2]!.toLowerCase()}` : undefined;
}

function nameClaims(name: string, slotId: string): boolean {
  const k = idKey(slotId);
  if (k.num !== undefined) return leadingId(name) === k.key;
  const n = name.toLowerCase(); const id = slotId.toLowerCase();
  return n.startsWith(id) && (n.length === id.length || /[^\p{L}\p{N}]/u.test(n[id.length]!));
}

export interface FootageMatch {
  dir: string;
  slots: Array<{ slot: string; matches: string[] }>;
  missing: string[];
  orphans: string[];
  warnings: BoardWarning[];
}

/** For every slot: files/folders (depth ≤ 2) whose name starts with the slot id; orphans = numbered entries no slot claims. */
export async function matchFootage(board: Board, dir: string): Promise<FootageMatch> {
  const root = path.resolve(dir);
  const st = await stat(root).catch(() => undefined);
  if (!st?.isDirectory()) throw new Error(`ไม่พบโฟลเดอร์ฟุตเทจ / footage folder not found: ${root}`);
  const entries = await scanDir(root, 2);
  const deep = board.slots.some((s) => s.sourceHint) ? await scanDir(root, 5) : entries;
  const claimed = new Set<string>();
  const slots = board.slots.map((s) => {
    const matches = entries.filter((e) => nameClaims(e.name, s.id)).map((e) => e.rel);
    for (const m of matches) claimed.add(m);
    return { slot: s.id, matches: matches.slice(0, 10) };
  });
  const missing = slots.filter((s) => !s.matches.length).map((s) => s.slot);
  const insideClaimed = (e: ScanEntry) => !!e.parent && [...claimed].some((c) => e.parent === c || e.parent!.startsWith(`${c}/`));
  const orphans = entries.filter((e) => leadingId(e.name) !== undefined && !claimed.has(e.rel) && !insideClaimed(e)).map((e) => e.rel);
  const warnings: BoardWarning[] = [];
  for (const id of missing) {
    const s = board.slots.find((x) => x.id === id)!;
    warnings.push({ code: 'footage-missing', severity: s.status === 'missing' || s.status === 'mockup' ? 'info' : 'warn', slot: id, message: `ไม่พบไฟล์/โฟลเดอร์ที่ขึ้นต้นด้วย "${id}" ใน ${root}${s.status ? ` (สถานะในบอร์ด: ${s.status})` : ''} / no footage named after the slot` });
  }
  for (const o of orphans) warnings.push({ code: 'footage-orphan', severity: 'warn', message: `"${o}" มีเลขนำหน้าแต่ไม่ตรงกับ slot ใดในบอร์ด — element นอกบอร์ด หรือบอร์ดผิดฉบับ? / numbered footage that no slot claims` });
  const deepNames = new Set(deep.map((e) => e.name.toLowerCase()));
  for (const s of board.slots) {
    const hint = s.sourceHint ? FILE_RE.exec(s.sourceHint)?.[0] : undefined;
    if (hint && !deepNames.has(path.basename(hint).toLowerCase())) {
      warnings.push({ code: 'source-missing', severity: 'warn', slot: s.id, message: `บอร์ดระบุไฟล์ "${hint}" ให้ slot ${s.id} แต่ไม่พบใน ${root} / file named on the board not found` });
    }
  }
  return { dir: root, slots, missing, orphans, warnings };
}

// ---------- slot assignment for clips ----------

export interface ShotLike { id: string; src: string; start: Frames; dur: Frames; marker?: string; slot?: string }

/** Slot id a clip realises: explicit `slot`, else a marker equal to a slot id, else the source file/comp name prefix. */
export function inferSlot(shot: ShotLike, board: Board, asset: Asset | undefined): { slot?: string; how?: 'clip' | 'marker' | 'source' } {
  const ids = board.slots.map((s) => s.id);
  if (shot.slot) return { slot: shot.slot, how: 'clip' };
  if (shot.marker) {
    const hit = ids.find((id) => id.toLowerCase() === shot.marker!.trim().toLowerCase()) ?? ids.find((id) => nameClaims(shot.marker!.trim(), id));
    if (hit) return { slot: hit, how: 'marker' };
  }
  const name = asset ? (asset.kind === 'aecomp' ? asset.comp : path.basename(asset.path)) : undefined;
  if (name) {
    const hits = ids.filter((id) => nameClaims(name, id));
    if (hits.length === 1) return { slot: hits[0], how: 'source' };
    if (asset && asset.kind !== 'aecomp') {
      const folder = path.basename(path.dirname(asset.path));
      const fh = ids.filter((id) => nameClaims(folder, id));
      if (fh.length === 1) return { slot: fh[0], how: 'source' };
    }
  }
  return {};
}

// ---------- board vs cut ----------

export interface SlotRow {
  slot: string;
  order: number;
  chapter?: string;
  clips: string[];
  boardStart?: Frames;
  boardDur?: Frames;
  cutStart?: Frames;
  cutDur?: Frames;
  startDrift?: Frames; // cut - board
  durDiff?: Frames; // cut - board
  boardStartTc?: string;
  cutStartTc?: string;
  startDriftTc?: string;
  status: 'ok' | 'drift' | 'missing' | 'moved' | 'split';
  boardStatus?: BoardSlot['status'];
  onScreenText?: string;
  thumb?: string;
}

export interface ChapterRow {
  name: string;
  boardStart?: Frames;
  boardDur?: Frames;
  cutStart?: Frames;
  cutDur?: Frames;
  startDrift?: Frames;
  durDiff?: Frames;
  startDriftTc?: string;
  durDiffTc?: string;
}

export interface BoardVsCut {
  fps: number;
  toleranceFrames: Frames;
  slots: SlotRow[];
  chapters: ChapterRow[];
  missing: string[];
  extra: Array<{ clipId: string; start: Frames; dur: Frames; slot?: string; reason: 'no-slot' | 'unknown-slot' }>;
  moved: string[];
  total: { cut: Frames; cutTc: string; target?: Frames; targetTc?: string; diff?: Frames; diffTc?: string };
  issues: QcIssue[];
  summary: string[];
}

function signedTc(f: Frames, fps: number): string {
  return `${f > 0 ? '+' : ''}${framesToTc(f, fps)}`;
}

/** Longest increasing subsequence (indices) — slots outside it are the ones that moved. */
function lisIndices(seq: number[]): Set<number> {
  const tails: number[] = []; const prev: number[] = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0; let hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (seq[tails[mid]!]! < seq[i]!) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const keep = new Set<number>();
  let k = tails.length ? tails[tails.length - 1]! : -1;
  while (k >= 0) { keep.add(k); k = prev[k]!; }
  return keep;
}

/** Compare a cut (shots with resolved slot ids, in timeline order) with the board. Pure. */
export function compareBoardToCut(board: Board, shots: ShotLike[], totalFrames: Frames, fps: number, toleranceFrames: Frames): BoardVsCut {
  const tc = (f: number) => framesToTc(f, fps);
  const known = new Map(board.slots.map((s) => [s.id, s]));
  const issues: QcIssue[] = [];
  const extra: BoardVsCut['extra'] = [];
  const bySlot = new Map<string, ShotLike[]>();
  const firstSeen: string[] = [];
  for (const sh of shots) {
    if (!sh.slot) { extra.push({ clipId: sh.id, start: sh.start, dur: sh.dur, reason: 'no-slot' }); continue; }
    if (!known.has(sh.slot)) { extra.push({ clipId: sh.id, start: sh.start, dur: sh.dur, slot: sh.slot, reason: 'unknown-slot' }); continue; }
    if (!bySlot.has(sh.slot)) { bySlot.set(sh.slot, []); firstSeen.push(sh.slot); }
    bySlot.get(sh.slot)!.push(sh);
  }
  const ordered = [...board.slots].sort((a, b) => a.order - b.order);
  const rank = new Map(ordered.map((s, i) => [s.id, i]));
  const keep = lisIndices(firstSeen.map((id) => rank.get(id)!));
  const moved = firstSeen.filter((_, i) => !keep.has(i));

  const rows: SlotRow[] = ordered.map((s) => {
    const clips = bySlot.get(s.id) ?? [];
    const row: SlotRow = { slot: s.id, order: s.order, clips: clips.map((c) => c.id), status: 'ok' };
    if (s.chapter) row.chapter = s.chapter;
    if (s.status) row.boardStatus = s.status;
    if (s.onScreenText) row.onScreenText = s.onScreenText;
    if (s.thumb) row.thumb = s.thumb;
    if (s.boardStartFrame !== undefined) { row.boardStart = s.boardStartFrame; row.boardStartTc = tc(s.boardStartFrame); }
    if (s.boardDurFrames !== undefined) row.boardDur = s.boardDurFrames;
    if (!clips.length) { row.status = 'missing'; return row; }
    row.cutStart = clips[0]!.start;
    row.cutStartTc = tc(row.cutStart);
    row.cutDur = clips.reduce((t, c) => t + c.dur, 0);
    const contiguous = clips.every((c, i) => i === 0 || c.start === clips[i - 1]!.start + clips[i - 1]!.dur);
    if (row.boardStart !== undefined) { row.startDrift = row.cutStart - row.boardStart; row.startDriftTc = signedTc(row.startDrift, fps); }
    if (row.boardDur !== undefined) row.durDiff = row.cutDur - row.boardDur;
    if (moved.includes(s.id)) row.status = 'moved';
    else if (!contiguous) row.status = 'split';
    else if (Math.abs(row.startDrift ?? 0) > toleranceFrames || Math.abs(row.durDiff ?? 0) > toleranceFrames) row.status = 'drift';
    return row;
  });

  const missing = rows.filter((r) => r.status === 'missing').map((r) => r.slot);
  for (const r of rows) {
    const range = r.cutStart !== undefined ? { startFrame: r.cutStart, endFrame: r.cutStart + (r.cutDur ?? 0) } : {};
    const clipId = r.clips[0];
    const base = { kind: 'board' as const, ...range, ...(clipId ? { clipId } : {}) };
    if (r.status === 'missing') {
      issues.push({ kind: 'board', severity: r.boardStatus === 'missing' ? 'warn' : 'error', ...(r.boardStart !== undefined ? { startFrame: r.boardStart } : {}), message: `slot ${r.slot} ไม่อยู่ในคัท${r.boardStatus ? ` (บอร์ด: ${r.boardStatus})` : ''} / board slot missing from the cut` });
      continue;
    }
    if (r.status === 'moved') issues.push({ ...base, severity: 'warn', message: `slot ${r.slot} อยู่ผิดลำดับเมื่อเทียบกับบอร์ด / slot out of board order` });
    if (r.status === 'split') issues.push({ ...base, severity: 'warn', message: `slot ${r.slot} ถูกแยกเป็นหลายช่วงที่ไม่ติดกัน (${r.clips.join(', ')}) / slot split across the cut` });
    if (r.startDrift !== undefined && Math.abs(r.startDrift) > toleranceFrames) issues.push({ ...base, severity: 'warn', message: `slot ${r.slot} เริ่ม ${r.cutStartTc} บอร์ด ${r.boardStartTc} (เลื่อน ${r.startDriftTc}, ${r.startDrift} เฟรม) / start drift` });
    if (r.durDiff !== undefined && Math.abs(r.durDiff) > toleranceFrames) issues.push({ ...base, severity: 'warn', message: `slot ${r.slot} ยาว ${r.cutDur} เฟรม บอร์ด ${r.boardDur} เฟรม (ต่าง ${r.durDiff > 0 ? '+' : ''}${r.durDiff}) / duration differs from board` });
  }
  for (const e of extra) {
    issues.push({
      kind: 'board', severity: e.reason === 'unknown-slot' ? 'error' : 'warn', startFrame: e.start, endFrame: e.start + e.dur, clipId: e.clipId,
      message: e.reason === 'unknown-slot'
        ? `คลิป ${e.clipId} ผูก slot "${e.slot}" ที่ไม่มีในบอร์ด — element นอกบอร์ด? / clip realises a slot the board does not have`
        : `คลิป ${e.clipId} ไม่ได้ผูกกับ slot ใดในบอร์ด (ใช้ board_link) — element นอกบอร์ด? / clip has no board slot`,
    });
  }

  // chapters: board start = declared or first slot's start; cut start = first realised slot
  const chapterNames = board.chapters?.map((c) => c.name) ?? [...new Set(ordered.map((s) => s.chapter).filter((c): c is string => !!c))];
  const chapters: ChapterRow[] = chapterNames.map((name) => {
    const decl = board.chapters?.find((c) => c.name === name);
    const mine = rows.filter((r) => r.chapter === name);
    const row: ChapterRow = { name };
    const bStart = decl?.startFrame ?? mine.find((r) => r.boardStart !== undefined)?.boardStart;
    const bDur = decl?.durFrames ?? (mine.length && mine.every((r) => r.boardDur !== undefined) ? mine.reduce((t, r) => t + r.boardDur!, 0) : undefined);
    const realised = mine.filter((r) => r.cutStart !== undefined);
    if (bStart !== undefined) row.boardStart = bStart;
    if (bDur !== undefined) row.boardDur = bDur;
    if (realised.length) {
      row.cutStart = Math.min(...realised.map((r) => r.cutStart!));
      row.cutDur = realised.reduce((t, r) => t + (r.cutDur ?? 0), 0);
    }
    if (row.cutStart !== undefined && row.boardStart !== undefined) { row.startDrift = row.cutStart - row.boardStart; row.startDriftTc = signedTc(row.startDrift, fps); }
    if (row.cutDur !== undefined && row.boardDur !== undefined) { row.durDiff = row.cutDur - row.boardDur; row.durDiffTc = signedTc(row.durDiff, fps); }
    if (row.startDrift !== undefined && Math.abs(row.startDrift) > toleranceFrames) {
      issues.push({ kind: 'board', severity: 'warn', startFrame: row.cutStart!, message: `chapter "${name}" เริ่มเลื่อนจากบอร์ด ${row.startDriftTc} (${row.startDrift} เฟรม) / chapter start drift` });
    }
    if (row.durDiff !== undefined && Math.abs(row.durDiff) > toleranceFrames) {
      issues.push({ kind: 'board', severity: 'warn', ...(row.cutStart !== undefined ? { startFrame: row.cutStart } : {}), message: `chapter "${name}" ยาวต่างจากบอร์ด ${row.durDiffTc} (${row.durDiff} เฟรม) / chapter duration differs` });
    }
    return row;
  });

  const total: BoardVsCut['total'] = { cut: totalFrames, cutTc: tc(totalFrames) };
  if (board.targetFrames !== undefined) {
    total.target = board.targetFrames; total.targetTc = tc(board.targetFrames);
    total.diff = totalFrames - board.targetFrames; total.diffTc = signedTc(total.diff, fps);
    if (Math.abs(total.diff) > toleranceFrames) issues.push({ kind: 'board', severity: 'error', message: `ความยาวรวม ${total.cutTc} ไม่ตรงเป้า ${total.targetTc} (ต่าง ${total.diffTc}, ${total.diff} เฟรม) — ใช้ fit_duration / total length differs from target` });
  }
  const drifted = rows.filter((r) => r.status === 'drift').length;
  const worstChapter = chapters.filter((c) => c.startDrift !== undefined).sort((a, b) => Math.abs(b.startDrift!) - Math.abs(a.startDrift!))[0];
  const summary = [
    `บอร์ด ${board.slots.length} slot · ในคัท ${rows.length - missing.length} · หาย ${missing.length}${missing.length ? ` (${missing.join(', ')})` : ''}`,
    `คลิปนอกบอร์ด ${extra.length}${extra.length ? ` (${extra.map((e) => e.clipId).join(', ')})` : ''} · ผิดลำดับ ${moved.length}${moved.length ? ` (${moved.join(', ')})` : ''} · เวลาเลื่อนเกิน ${toleranceFrames} เฟรม ${drifted} slot`,
    total.target !== undefined ? `ความยาวรวม ${total.cutTc} / เป้า ${total.targetTc} (${total.diffTc})` : `ความยาวรวม ${total.cutTc} (บอร์ดไม่ระบุเป้าหมาย)`,
    ...(worstChapter?.startDrift ? [`chapter ที่เลื่อนมากสุด: "${worstChapter.name}" ${worstChapter.startDriftTc}`] : []),
  ];
  return { fps, toleranceFrames, slots: rows, chapters, missing, extra, moved, total, issues, summary };
}

// ---------- HTML report ----------

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Path usable from an HTML file in `fromDir`: relative when possible, else file:/// URL. */
export function htmlHref(target: string, fromDir: string): string {
  const rel = path.relative(fromDir, target);
  if (rel && !path.isAbsolute(rel) && path.parse(path.resolve(target)).root === path.parse(path.resolve(fromDir)).root) {
    return rel.split(path.sep).map(encodeURIComponent).join('/');
  }
  return `file:///${path.resolve(target).split(path.sep).map((p, i) => (i === 0 && /^[A-Za-z]:$/.test(p) ? p : encodeURIComponent(p))).join('/')}`;
}

export interface ReportImages { board?: string; cut?: string; cutFrame?: Frames }

export function renderBoardVsCutHtml(r: BoardVsCut, opts: { title: string; version: string; master?: string; images: Map<string, ReportImages>; notes?: string[] }): string {
  const fps = r.fps;
  const tc = (f: number | undefined) => (f === undefined ? '—' : framesToTc(f, fps));
  const num = (f: number | undefined) => (f === undefined ? '—' : `${f > 0 ? '+' : ''}${f}`);
  const cls = (f: number | undefined) => (f === undefined ? '' : Math.abs(f) > r.toleranceFrames ? ' class="bad"' : f !== 0 ? ' class="soft"' : '');
  const cards = r.slots.map((s) => {
    const img = opts.images.get(s.slot) ?? {};
    const boardImg = img.board ? `<img src="${esc(img.board)}" alt="board ${esc(s.slot)}" loading="lazy">` : '<div class="ph">ไม่มีภาพบอร์ด</div>';
    const cutImg = img.cut ? `<img src="${esc(img.cut)}" alt="cut ${esc(s.slot)}" loading="lazy">` : `<div class="ph">${s.status === 'missing' ? 'ไม่อยู่ในคัท' : 'ไม่มีเฟรม'}</div>`;
    return `<section class="card st-${s.status}">
  <header><b>${esc(s.slot)}</b>${s.chapter ? ` <span class="ch">${esc(s.chapter)}</span>` : ''} <span class="badge">${esc(s.status)}</span></header>
  <div class="pair"><figure>${boardImg}<figcaption>บอร์ด ${tc(s.boardStart)}${s.boardDur !== undefined ? ` · ${s.boardDur}f` : ''}</figcaption></figure>
  <figure>${cutImg}<figcaption>คัท ${tc(s.cutStart)}${s.cutDur !== undefined ? ` · ${s.cutDur}f` : ''}${img.cutFrame !== undefined ? ` · เฟรม ${tc(img.cutFrame)}` : ''}</figcaption></figure></div>
  ${s.onScreenText ? `<p class="txt">“${esc(s.onScreenText)}”</p>` : ''}
  <p class="meta">เลื่อน <span${cls(s.startDrift)}>${num(s.startDrift)}</span>f · ความยาวต่าง <span${cls(s.durDiff)}>${num(s.durDiff)}</span>f${s.clips.length ? ` · ${esc(s.clips.join(', '))}` : ''}</p>
</section>`;
  }).join('\n');
  const slotRows = r.slots.map((s) => `<tr class="st-${s.status}"><td>${esc(s.slot)}</td><td>${esc(s.chapter ?? '')}</td><td>${tc(s.boardStart)}</td><td>${tc(s.cutStart)}</td><td${cls(s.startDrift)}>${num(s.startDrift)}</td><td>${s.boardDur ?? '—'}</td><td>${s.cutDur ?? '—'}</td><td${cls(s.durDiff)}>${num(s.durDiff)}</td><td>${esc(s.status)}</td><td>${esc(s.clips.join(', '))}</td></tr>`).join('\n');
  const chRows = r.chapters.map((c) => `<tr><td>${esc(c.name)}</td><td>${tc(c.boardStart)}</td><td>${tc(c.cutStart)}</td><td${cls(c.startDrift)}>${num(c.startDrift)} ${c.startDriftTc ? `(${esc(c.startDriftTc)})` : ''}</td><td>${tc(c.boardDur)}</td><td>${tc(c.cutDur)}</td><td${cls(c.durDiff)}>${num(c.durDiff)}</td></tr>`).join('\n');
  const extra = r.extra.map((e) => `<li>${esc(e.clipId)} @ ${tc(e.start)} (${e.dur}f) — ${e.reason === 'unknown-slot' ? `slot "${esc(e.slot)}" ไม่มีในบอร์ด` : 'ไม่ได้ผูก slot'}</li>`).join('');
  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<style>
:root{--bg:#121110;--panel:#1c1a18;--line:#34302b;--fg:#ece6dc;--dim:#a39a8c;--amber:#e3a43a;--bad:#ff7a59;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 "Noto Sans Thai","Leelawadee UI",Tahoma,sans-serif;padding:16px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 8px;color:var(--amber)}.dim{color:var(--dim)}
ul.sum{margin:8px 0;padding-left:18px}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:13px}
th,td{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left;white-space:nowrap}th{color:var(--dim);font-weight:600}
.wrap{overflow-x:auto}.bad{color:var(--bad);font-weight:700}.soft{color:var(--amber)}tr.st-missing td{color:var(--bad)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px}.card.st-missing{border-color:var(--bad)}.card.st-drift,.card.st-moved,.card.st-split{border-color:var(--amber)}
.card header{display:flex;gap:8px;align-items:center}.ch{color:var(--dim)}.badge{margin-left:auto;font-size:11px;border:1px solid var(--line);border-radius:10px;padding:0 8px;color:var(--dim)}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px}figure{margin:0}img,.ph{width:100%;aspect-ratio:16/9;object-fit:contain;background:#000;border-radius:4px;display:flex;align-items:center;justify-content:center;color:var(--dim);font-size:12px}
figcaption{font-size:12px;color:var(--dim)}.txt{margin:6px 0 0}.meta{margin:4px 0 0;font-size:12px;color:var(--dim)}
</style></head><body>
<h1>บอร์ด vs คัท — ${esc(opts.version)}</h1>
<div class="dim">${esc(opts.title)} · ${fps} fps · ค่าคลาดเคลื่อนที่ยอมรับ ${r.toleranceFrames} เฟรม${opts.master ? ` · master: ${esc(path.basename(opts.master))}` : ''}</div>
<ul class="sum">${r.summary.map((s) => `<li>${esc(s)}</li>`).join('')}${(opts.notes ?? []).map((s) => `<li class="dim">${esc(s)}</li>`).join('')}</ul>
${r.chapters.length ? `<h2>Chapter</h2><div class="wrap"><table><thead><tr><th>chapter</th><th>บอร์ดเริ่ม</th><th>คัทเริ่ม</th><th>เลื่อน (f)</th><th>บอร์ดยาว</th><th>คัทยาว</th><th>ต่าง (f)</th></tr></thead><tbody>${chRows}</tbody></table></div>` : ''}
<h2>Slot</h2><div class="wrap"><table><thead><tr><th>slot</th><th>chapter</th><th>บอร์ดเริ่ม</th><th>คัทเริ่ม</th><th>เลื่อน (f)</th><th>บอร์ดยาว (f)</th><th>คัทยาว (f)</th><th>ต่าง (f)</th><th>สถานะ</th><th>คลิป</th></tr></thead><tbody>${slotRows}</tbody></table></div>
${extra ? `<h2>คลิปนอกบอร์ด</h2><ul>${extra}</ul>` : ''}
<h2>ภาพคู่ บอร์ด | คัท</h2><div class="grid">${cards}</div>
</body></html>
`;
}

// ---------- fit to duration ----------

export type FitStrategy = 'proportional' | 'tail' | 'cards';

export interface FitChange { clipId: string; slot?: string; from: Frames; to: Frames; delta: Frames; min: Frames; max: Frames | null }

export interface FitProposal {
  strategy: FitStrategy;
  currentFrames: Frames;
  targetFrames: Frames;
  delta: Frames;
  achievedFrames: Frames;
  remaining: Frames; // frames that could not be placed within source handles / dissolve limits
  flexible: string[];
  changes: FitChange[];
  timeline: Timeline;
  errors: string[]; // validateTimeline on the proposal
  notes: string[];
}

const FLEX_RE = /card|logo|title|endcard|end card|super|lower ?third|การ์ด|โลโก้|ไตเติ้ล|ไตเติล|ยืดได้|flex/i;

function sourceLen(a: Asset | undefined): number | undefined {
  if (!a) return undefined;
  if (a.kind === 'still') return Number.POSITIVE_INFINITY;
  if (a.kind === 'aecomp') return a.probe?.durationFrames ?? a.render?.frames;
  return a.probe?.durationFrames;
}

/** Split `total` (>0) across items proportionally to weight, never exceeding cap; integer frames. */
export function distribute(total: number, items: Array<{ w: number; cap: number }>): number[] {
  const alloc = items.map(() => 0);
  let remaining = total;
  let active = items.map((_, i) => i).filter((i) => items[i]!.cap > 0 && items[i]!.w > 0);
  while (remaining > 0 && active.length) {
    const sumW = active.reduce((t, i) => t + items[i]!.w, 0);
    const capped = active.filter((i) => (remaining * items[i]!.w) / sumW >= items[i]!.cap - alloc[i]!);
    if (capped.length) {
      for (const i of capped) { const give = Math.min(remaining, items[i]!.cap - alloc[i]!); alloc[i]! += give; remaining -= give; }
      active = active.filter((i) => !capped.includes(i));
      continue;
    }
    const shares = active.map((i) => ({ i, s: (remaining * items[i]!.w) / sumW }));
    let given = 0;
    for (const { i, s } of shares) { const f = Math.floor(s); alloc[i]! += f; given += f; }
    let left = remaining - given;
    shares.sort((a, b) => (b.s - Math.floor(b.s)) - (a.s - Math.floor(a.s)) || a.i - b.i);
    for (const { i } of shares) { if (left <= 0) break; if (alloc[i]! < items[i]!.cap) { alloc[i]! += 1; left--; } }
    remaining = left;
    if (left > 0 && shares.every(({ i }) => alloc[i]! >= items[i]!.cap)) break;
  }
  return alloc;
}

/**
 * Propose clip durations that make the timeline `targetFrames` long. In-points never move; growth is
 * limited by the source length minus the handle the following dissolve needs, shrink by the frames the
 * dissolves on both sides consume (+1 body frame). The proposal is verified with validateTimeline.
 */
export function proposeFit(p: Project, opts: {
  targetFrames: Frames;
  strategy: FitStrategy;
  board?: Board;
  flexible?: string[]; // clip or slot ids (overrides the heuristic)
  lock?: string[]; // clip or slot ids never touched
  shiftAudio?: boolean; // move vo/sfx clips that start after a changed clip by the cumulative delta
}): FitProposal {
  const t = p.timeline;
  const video = t.video;
  const current = video.reduce((s, c) => s + c.dur, 0);
  const delta = opts.targetFrames - current;
  const notes: string[] = [];
  const cutAfter = new Map(t.cuts.filter((c) => c.dissolve > 0).map((c) => [c.after, c.dissolve]));
  const lock = new Set(opts.lock ?? []);
  const slotOf = (c: Clip) => c.slot;
  const inSet = (set: Set<string>, c: Clip) => set.has(c.id) || (!!c.slot && set.has(c.slot));
  const bounds = video.map((c, i) => {
    const before = i > 0 ? cutAfter.get(video[i - 1]!.id) : undefined;
    const after = cutAfter.get(c.id);
    const reserved = (before ? splitDissolve(before).b : 0) + (after ? splitDissolve(after).a : 0);
    const min = reserved + 1;
    const len = sourceLen(p.assets[c.src]);
    const handleAfter = after ? splitDissolve(after).b : 0;
    let max: number;
    if (len === undefined) { max = c.dur; notes.push(`คลิป ${c.id}: ไม่รู้ความยาวต้นทาง (ยังไม่ probe) — ไม่ยืดให้ / source length unknown, not lengthened`); }
    else if (!Number.isFinite(len)) max = Number.POSITIVE_INFINITY;
    else {
      const room = len - c.in - handleAfter;
      const rate = c.speed?.rate && c.speed.rate > 0 ? c.speed.rate : 1;
      max = Math.max(c.dur, Math.min(room, Math.floor(room / rate)));
    }
    return { min: Math.min(min, c.dur), max };
  });

  let flexible: Set<string>;
  if (opts.flexible?.length) flexible = new Set(video.filter((c) => inSet(new Set(opts.flexible), c)).map((c) => c.id));
  else {
    flexible = new Set(video.filter((c) => {
      const a = p.assets[c.src];
      if (a?.kind === 'still' || a?.kind === 'aecomp' || a?.kind === 'graphic') return true;
      const s = c.slot ? opts.board?.slots.find((x) => x.id === c.slot) : undefined;
      return !!s && FLEX_RE.test([s.notes, s.sourceHint, s.chapter].filter(Boolean).join(' '));
    }).map((c) => c.id));
    if (opts.strategy === 'cards') notes.push('คลิปที่ยืด/หดได้เดาจากชนิด asset (still/aecomp/graphic) และโน้ตในบอร์ด (card/logo/การ์ด/โลโก้) — ส่ง flexible เพื่อระบุเอง / flexible clips guessed; pass `flexible` to override');
  }
  const eligible = video.map((c, i) => i).filter((i) => !inSet(lock, video[i]!));
  const cap = (i: number) => {
    const c = video[i]!; const b = bounds[i]!;
    return delta >= 0 ? (Number.isFinite(b.max) ? b.max - c.dur : 1e12) : c.dur - b.min;
  };
  const alloc = new Map<number, number>();
  const give = (idx: number[], amount: number, how: 'proportional' | 'tail'): number => {
    if (amount <= 0 || !idx.length) return amount;
    if (how === 'tail') {
      let left = amount;
      for (const i of [...idx].reverse()) {
        const room = cap(i) - (alloc.get(i) ?? 0);
        const g = Math.min(left, Math.max(0, room));
        if (g) { alloc.set(i, (alloc.get(i) ?? 0) + g); left -= g; }
        if (!left) break;
      }
      return left;
    }
    const parts = distribute(amount, idx.map((i) => ({ w: video[i]!.dur, cap: Math.max(0, cap(i) - (alloc.get(i) ?? 0)) })));
    parts.forEach((g, k) => { if (g) alloc.set(idx[k]!, (alloc.get(idx[k]!) ?? 0) + g); });
    return amount - parts.reduce((s, g) => s + g, 0);
  };
  let left = Math.abs(delta);
  if (opts.strategy === 'tail') left = give(eligible, left, 'tail');
  else if (opts.strategy === 'cards') {
    const flex = eligible.filter((i) => flexible.has(video[i]!.id));
    if (!flex.length) notes.push('ไม่พบคลิปที่ยืด/หดได้ — ใช้แบบ proportional กับทุกคลิป / no flexible clips: fell back to proportional');
    left = give(flex, left, 'proportional');
    if (left > 0 && flex.length) {
      notes.push(`คลิป card/logo รับได้ไม่พอ เหลือ ${left} เฟรม → กระจายให้คลิปอื่นตามสัดส่วน / flexible clips could not absorb everything`);
    }
    if (left > 0) left = give(eligible.filter((i) => !flexible.has(video[i]!.id)), left, 'proportional');
  } else left = give(eligible, left, 'proportional');

  const sign = delta >= 0 ? 1 : -1;
  const next = structuredClone(t);
  const changes: FitChange[] = [];
  for (const [i, g] of [...alloc.entries()].sort((a, b) => a[0] - b[0])) {
    const c = next.video[i]!;
    const from = c.dur;
    c.dur = from + sign * g;
    const ch: FitChange = { clipId: c.id, from, to: c.dur, delta: c.dur - from, min: bounds[i]!.min, max: Number.isFinite(bounds[i]!.max) ? bounds[i]!.max : null };
    const s = slotOf(c);
    if (s) ch.slot = s;
    changes.push(ch);
  }
  // audio placed at absolute frames does not follow picture changes
  const shiftAt: Array<{ at: Frames; d: Frames }> = [];
  let pos = 0;
  t.video.forEach((c, i) => { pos += c.dur; const d = next.video[i]!.dur - c.dur; if (d) shiftAt.push({ at: pos, d }); });
  const affected = [...t.audio.vo, ...t.audio.sfx].filter((a) => shiftAt.some((s) => a.at >= s.at));
  if (affected.length) {
    if (opts.shiftAudio) {
      for (const a of [...next.audio.vo, ...next.audio.sfx]) a.at += shiftAt.filter((s) => a.at >= s.at).reduce((x, s) => x + s.d, 0);
      notes.push(`ย้าย VO/SFX ${affected.length} คลิปตามภาพแล้ว (เพลงไม่ย้าย) / shifted vo/sfx clips with the picture (music untouched)`);
    } else {
      notes.push(`VO/SFX ${affected.length} คลิป (${affected.map((a) => a.id).join(', ')}) วางที่เฟรมคงที่และจะไม่ตรงภาพหลังเปลี่ยน — ใช้ shiftAudio: true เพื่อย้ายตาม / audio at absolute frames will drift: pass shiftAudio: true`);
    }
  }
  const achieved = next.video.reduce((s, c) => s + c.dur, 0);
  if (left > 0) notes.push(`ไปได้ไม่ถึงเป้า ขาดอีก ${sign * left} เฟรม เพราะ handle ต้นทาง/ dissolve จำกัด — ต้องเพิ่ม/ตัดช็อตหรือยอมให้ยืดคลิปที่ล็อกไว้ / target not reachable within handles`);
  const errors = validateTimeline({ ...p, timeline: next });
  return {
    strategy: opts.strategy, currentFrames: current, targetFrames: opts.targetFrames, delta, achievedFrames: achieved, remaining: sign * left,
    flexible: [...flexible], changes, timeline: next, errors, notes,
  };
}
