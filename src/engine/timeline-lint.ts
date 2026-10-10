/**
 * Timeline lint against per-source shot indexes (DESIGN.md §13.2 rows 2–3). Pure: no processes.
 *
 * Per clip the VISIBLE source range includes dissolve handles (CLAUDE.md): a dissolve of N frames
 * at a cut covers [C−a, C+b) with a = floor(N/2), so the outgoing clip shows b source frames past
 * its out and the incoming clip shows a source frames before its in. Source frames consumed by the
 * clip body = round(dur × rate) for constant speed (rate 1 when Clip.speed is absent); ramps
 * integrate an eased rate over `rampFrames`.
 *
 * Everything is advisory ('warn'): the brief decides whether a crossing or a static shot is wanted.
 */
import { framesToTc, splitDissolve } from '../core/timecode.js';
import type { Clip, Frames, Project, QcIssue } from '../core/types.js';

/** What lint needs from a shot index (structurally compatible with engine/shots.ts ShotIndex). */
export interface ShotData {
  frames: Frames; // source length at project fps
  cuts: Frames[]; // first frame of each new shot, ascending
  motion?: number[]; // per-frame motion (mafd); absent = no low-motion check
}

export type ShotIndexMap = ReadonlyMap<string, ShotData> | Readonly<Record<string, ShotData | undefined>>;

export interface LintRules {
  flashFrames?: Frames; // a visible shot piece shorter than this is a flash (default 6)
  nearClips?: number; // repeat check looks this many clips ahead (default 3)
  maxStaticSec?: number; // default project.styleRules.maxStaticSec ?? 4
  staticMotion?: number; // mafd below this counts as static (default 0.5 at 320 px analysis width)
  checks?: Array<'cutcross' | 'flash' | 'repeat' | 'lowmotion'>; // default all
}

export interface LintIssue extends QcIssue {
  tc?: string; // timeline timecode of startFrame
  sourceFrame?: Frames; // the source shot change (cutcross/flash) or the first reused frame (repeat)
  side?: 'head' | 'tail' | 'middle';
  suggestion?: string;
}

const DEFAULT_FLASH = 6;
const DEFAULT_NEAR = 3;
const DEFAULT_STATIC_SEC = 4;
const DEFAULT_STATIC_MOTION = 0.5;

function shotsFor(map: ShotIndexMap, id: string): ShotData | undefined {
  return map instanceof Map ? map.get(id) : (map as Record<string, ShotData | undefined>)[id];
}

// ---------- speed ----------

function smoothstep(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/** Source frames consumed by the first `k` timeline frames of a clip (fractional). */
function makeCum(clip: Clip): (k: number) => number {
  const rate = clip.speed?.rate ?? 1;
  const from = clip.speed?.rampFrom;
  const rampN = clip.speed?.rampFrames ?? 0;
  if (from === undefined || rampN <= 0) return (k) => k * rate;
  const table: number[] = [0];
  for (let t = 0; t < rampN; t++) table.push(table[t]! + from + (rate - from) * smoothstep((t + 0.5) / rampN));
  return (k) => {
    if (k <= 0) return k * from;
    if (k >= rampN) return table[rampN]! + (k - rampN) * rate;
    const i = Math.floor(k);
    return table[i]! + (k - i) * (table[i + 1]! - table[i]!);
  };
}

/** Inverse of cum: timeline offset (fractional) at which source offset `s` is shown. */
function invCum(cum: (k: number) => number, s: number, dur: number): number {
  if (s <= 0) { const r0 = cum(1) - cum(0); return r0 > 0 ? s / r0 : 0; }
  const end = cum(dur);
  if (s >= end) { const r1 = cum(dur) - cum(dur - 1); return dur + (r1 > 0 ? (s - end) / r1 : 0); }
  let lo = 0;
  let hi = dur;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (cum(mid) < s) lo = mid; else hi = mid; }
  return hi;
}

/** Source frames consumed by a clip body: round(dur × rate) for constant speed. */
export function consumedFrames(clip: Clip): Frames {
  return Math.round(makeCum(clip)(clip.dur));
}

// ---------- ranges ----------

interface ClipRange {
  clip: Clip;
  index: number;
  start: Frames; // timeline start
  headHandle: Frames; // timeline frames shown before `start` under the incoming dissolve (a)
  tailHandle: Frames; // timeline frames shown after the clip end under the outgoing dissolve (b)
  srcIn: Frames;
  srcOut: Frames; // exclusive, body only: srcIn + consumed
  visFrom: Frames; // source range incl. handles
  visTo: Frames;
  /** source frame → timeline offset from `start` (fractional, may be < 0 or > dur in handles) */
  toTimeline: (srcFrame: number) => number;
}

function clipRanges(p: Project): ClipRange[] {
  const video = p.timeline.video;
  const cutAfter = new Map(p.timeline.cuts.map((c) => [c.after, c.dissolve]));
  const out: ClipRange[] = [];
  let pos = 0;
  video.forEach((clip, i) => {
    const prev = video[i - 1];
    const head = prev ? splitDissolve(cutAfter.get(prev.id) ?? 0).a : 0;
    const tail = i < video.length - 1 ? splitDissolve(cutAfter.get(clip.id) ?? 0).b : 0;
    const dur = Math.max(0, clip.dur);
    const cum = makeCum(clip);
    const srcOut = clip.in + Math.round(cum(dur));
    out.push({
      clip, index: i, start: pos, headHandle: head, tailHandle: tail,
      srcIn: clip.in, srcOut,
      visFrom: clip.in + Math.round(cum(-head)),
      visTo: clip.in + Math.round(cum(dur + tail)),
      toTimeline: (s) => invCum(cum, s - clip.in, dur),
    });
    pos += dur;
  });
  return out;
}

// ---------- lint ----------

function sourceIsStill(p: Project, id: string): boolean {
  const a = p.assets[id];
  return !a || a.kind === 'still' || a.kind === 'audio';
}

export function lintTimeline(p: Project, shots: ShotIndexMap, rules: LintRules = {}): LintIssue[] {
  const fps = p.meta.fps;
  const tc = (f: Frames) => framesToTc(f, fps);
  const flashN = rules.flashFrames ?? DEFAULT_FLASH;
  const near = rules.nearClips ?? DEFAULT_NEAR;
  const staticFrames = Math.round((rules.maxStaticSec ?? p.styleRules?.maxStaticSec ?? DEFAULT_STATIC_SEC) * fps);
  const staticMotion = rules.staticMotion ?? DEFAULT_STATIC_MOTION;
  const on = (k: 'cutcross' | 'flash' | 'repeat' | 'lowmotion') => !rules.checks || rules.checks.includes(k);
  const ranges = clipRanges(p);
  const issues: LintIssue[] = [];

  for (const r of ranges) {
    const { clip } = r;
    if (clip.dur <= 0) continue;
    const sd = sourceIsStill(p, clip.src) ? undefined : shotsFor(shots, clip.src);

    if (sd && (on('cutcross') || on('flash'))) issues.push(...cutIssues(r, sd, flashN, fps, on));

    if (on('flash') && clip.dur + r.headHandle + r.tailHandle < flashN) {
      issues.push({
        kind: 'flash', severity: 'warn', clipId: clip.id, startFrame: r.start, endFrame: r.start + clip.dur, tc: tc(r.start),
        message: `คลิป ${clip.id} ยาวแค่ ${clip.dur} เฟรม (< ${flashN}) ที่ ${tc(r.start)} — อาจเห็นเป็นเฟรมแวบ / clip shorter than ${flashN} frames`,
      });
    }

    if (sd?.motion && on('lowmotion') && !clip.pushIn) {
      const run = longestStaticRun(sd.motion, r.srcIn, r.srcOut, sd.cuts, staticMotion);
      if (run) {
        const t0 = Math.max(0, Math.round(r.toTimeline(run.from)));
        const t1 = Math.min(clip.dur, Math.round(r.toTimeline(run.to)));
        if (t1 - t0 > staticFrames) {
          const sec = ((t1 - t0) / fps).toFixed(1);
          issues.push({
            kind: 'lowmotion', severity: 'warn', clipId: clip.id, startFrame: r.start + t0, endFrame: r.start + t1, tc: tc(r.start + t0),
            suggestion: 'pushIn 6–8 (Clip.pushIn) หรือเลือกช่วงต้นทางที่มีการเคลื่อนไหว',
            message: `(คำแนะนำ) คลิป ${clip.id} ภาพแทบนิ่ง ${sec} วิ ${tc(r.start + t0)} → ${tc(r.start + t1)} (> ${(staticFrames / fps).toFixed(1)} วิ) — ลอง pushIn 6–8% / nearly static for ${sec}s: consider Clip.pushIn 6–8`,
          });
        }
      }
    }
  }

  if (on('repeat')) {
    for (let i = 0; i < ranges.length; i++) {
      const a = ranges[i]!;
      if (sourceIsStill(p, a.clip.src) || a.clip.dur <= 0) continue;
      for (let j = i + 1; j <= Math.min(ranges.length - 1, i + near); j++) {
        const b = ranges[j]!;
        if (b.clip.src !== a.clip.src || b.clip.dur <= 0) continue;
        const from = Math.max(a.srcIn, b.srcIn);
        const to = Math.min(a.srcOut, b.srcOut);
        if (to <= from) continue;
        const t0 = Math.max(0, Math.round(b.toTimeline(from)));
        const t1 = Math.min(b.clip.dur, Math.max(t0 + 1, Math.round(b.toTimeline(to))));
        issues.push({
          kind: 'repeat', severity: 'warn', clipId: b.clip.id, startFrame: b.start + t0, endFrame: b.start + t1, tc: tc(b.start + t0), sourceFrame: from,
          message: `คลิป ${b.clip.id} ใช้ต้นทางซ้ำกับ ${a.clip.id} (${j - i === 1 ? 'ติดกัน' : `ห่าง ${j - i} คลิป`}) ช่วงต้นทาง ${tc(from)}–${tc(to)} (${to - from} เฟรม) ที่ ${tc(b.start + t0)} / reuses ${to - from} source frames of ${a.clip.id}`,
        });
      }
    }
  }

  issues.sort((x, y) => (x.startFrame ?? 0) - (y.startFrame ?? 0));
  return issues;
}

function cutIssues(r: ClipRange, sd: ShotData, flashN: Frames, fps: number, on: (k: 'cutcross' | 'flash') => boolean): LintIssue[] {
  const tc = (f: Frames) => framesToTc(f, fps);
  const inside = sd.cuts.filter((c) => c > r.visFrom && c < r.visTo);
  if (!inside.length) return [];
  const vFrom = -r.headHandle;
  const vTo = r.clip.dur + r.tailHandle;
  // timeline offsets of each source cut, then the visible pieces between them
  const offs = inside.map((c) => Math.min(vTo, Math.max(vFrom, Math.round(r.toTimeline(c)))));
  const bounds = [vFrom, ...offs, vTo];
  const pieces = bounds.slice(0, -1).map((b, i) => ({ from: b, to: bounds[i + 1]! }));
  const out: LintIssue[] = [];
  const short = pieces.map((pc) => pc.to - pc.from < flashN);
  const where = (off: number) => (off < 0 || off >= r.clip.dur ? ' (อยู่ใน handle ของ dissolve / inside a dissolve handle)' : '');
  pieces.forEach((pc, i) => {
    if (!short[i] || !on('flash')) return;
    const side: LintIssue['side'] = i === 0 ? 'head' : i === pieces.length - 1 ? 'tail' : 'middle';
    const cut = side === 'head' ? inside[0]! : inside[i - 1]!;
    const len = pc.to - pc.from;
    const start = r.start + pc.from;
    const sideTh = side === 'head' ? 'หัวคลิป' : side === 'tail' ? 'ท้ายคลิป' : 'กลางคลิป';
    out.push({
      kind: 'flash', severity: 'warn', clipId: r.clip.id, startFrame: start, endFrame: r.start + pc.to, tc: tc(start), sourceFrame: cut, side,
      suggestion: side === 'head' ? `ขยับ in ไปที่ ${cut} (timeline_snap)` : side === 'tail' ? `ตัด out ให้จบที่ ${cut} (timeline_snap)` : 'แยกคลิปหรือเลือกช่วงใหม่',
      message: `เฟรมแวบ ${len} เฟรม (< ${flashN}) ที่${sideTh} ${r.clip.id} ${tc(start)} — ช็อตข้างเคียงในต้นทางหลุดเข้ามา (รอยตัดต้นทาง ${tc(cut)})${where(pc.from)} / ${len}-frame flash at clip ${side}`,
    });
  });
  if (on('cutcross')) {
    inside.forEach((c, i) => {
      if (short[i] || short[i + 1]) return; // already reported as a flash
      const off = offs[i]!;
      const before = off - vFrom;
      const after = vTo - off;
      const side: LintIssue['side'] = before <= after ? 'head' : 'tail';
      const at = r.start + off;
      out.push({
        kind: 'cutcross', severity: 'warn', clipId: r.clip.id, startFrame: at, endFrame: at + 1, tc: tc(at), sourceFrame: c, side,
        message: `คลิป ${r.clip.id} ข้ามรอยตัดต้นทาง (source ${tc(c)}) ที่ ${tc(at)} — ${before} เฟรมก่อน / ${after} เฟรมหลัง, ใกล้${side === 'head' ? 'หัว' : 'ท้าย'}คลิป${where(off)} / crosses a source shot change`,
      });
    });
  }
  return out;
}

/** Longest run of frames with motion < threshold inside [from, to); cut frames break runs. */
function longestStaticRun(motion: number[], from: Frames, to: Frames, cuts: Frames[], threshold: number): { from: Frames; to: Frames } | undefined {
  const cutSet = new Set(cuts);
  let best: { from: Frames; to: Frames } | undefined;
  let runStart = -1;
  const end = Math.min(to, motion.length);
  for (let f = Math.max(0, from); f <= end; f++) {
    const still = f < end && !cutSet.has(f) && motion[f]! < threshold;
    if (still && runStart < 0) runStart = f;
    if (!still && runStart >= 0) {
      if (!best || f - runStart > best.to - best.from) best = { from: runStart, to: f };
      runStart = -1;
    }
  }
  return best;
}

// ---------- snap ----------

export interface SnapOptions {
  headHandle?: Frames; // timeline frames shown before the clip under an incoming dissolve
  tailHandle?: Frames;
  allowDurChange?: boolean; // default false: keep the timeline duration
}

export interface SnapProposal {
  clipId: string;
  changed: boolean;
  before: { in: Frames; dur: Frames };
  in: Frames;
  dur: Frames;
  reasons: string[];
  warnings: string[];
}

/**
 * Move a clip's source window so its visible head/tail land on source shot boundaries when a
 * boundary sits within k timeline frames inside the clip (a leak of the neighbouring shot).
 * Keeps the timeline duration by sliding the window; shortens the clip only when allowed.
 * Never moves the window outside [0, source length).
 */
export function snapToShots(clip: Clip, shots: ShotData, k: Frames, opts: SnapOptions = {}): SnapProposal {
  const rate = clip.speed?.rate ?? 1;
  const hh = opts.headHandle ?? 0;
  const th = opts.tailHandle ?? 0;
  const consumed = consumedFrames(clip);
  const hhSrc = Math.round(hh * (clip.speed?.rampFrom ?? rate));
  const thSrc = Math.round(th * rate);
  const kSrc = Math.max(1, Math.round(k * rate));
  const res: SnapProposal = { clipId: clip.id, changed: false, before: { in: clip.in, dur: clip.dur }, in: clip.in, dur: clip.dur, reasons: [], warnings: [] };
  const visFrom = clip.in - hhSrc;
  const visTo = clip.in + consumed + thSrc;
  const cuts = shots.cuts;
  const headCut = cuts.filter((c) => c > visFrom && c - visFrom <= kSrc).pop(); // last boundary in the head zone
  const tailCut = cuts.find((c) => c < visTo && visTo - c <= kSrc && c > (headCut ?? -Infinity));
  if (headCut === undefined && tailCut === undefined) return res;
  const crosses = (lo: number, hi: number) => cuts.some((c) => c > lo && c < hi);
  const durFor = (srcFrames: number) => Math.max(1, Math.round(srcFrames / rate));

  if (headCut !== undefined && tailCut === undefined) {
    const d = headCut - visFrom;
    if (visTo + d <= shots.frames && !crosses(visTo - 1, visTo + d)) {
      res.in = clip.in + d;
      res.reasons.push(`หัวคลิปเห็นช็อตก่อนหน้า ${d} เฟรมต้นทาง → เลื่อน in ไป ${res.in} (คงความยาว) / head leak: slide in by ${d}`);
    } else if (opts.allowDurChange) {
      res.in = clip.in + d;
      res.dur = durFor(consumed - d);
      res.reasons.push(`หัวคลิปเห็นช็อตก่อนหน้า ${d} เฟรม → in ${res.in}, สั้นลงเป็น ${res.dur} เฟรม / head leak: trim head`);
    } else {
      res.warnings.push(`หัวคลิปเห็นช็อตก่อนหน้า ${d} เฟรม แต่เลื่อนโดยคงความยาวไม่ได้ (ชนรอยตัด/สุดไฟล์) — ใช้ allowDurChange / cannot slide without changing duration`);
    }
  } else if (tailCut !== undefined && headCut === undefined) {
    const d = visTo - tailCut;
    if (visFrom - d >= 0 && !crosses(visFrom - d, visFrom + 1)) {
      res.in = clip.in - d;
      res.reasons.push(`ท้ายคลิปเห็นช็อตถัดไป ${d} เฟรมต้นทาง → เลื่อน in ไป ${res.in} (คงความยาว) / tail leak: slide in back by ${d}`);
    } else if (opts.allowDurChange) {
      res.dur = durFor(consumed - d);
      res.reasons.push(`ท้ายคลิปเห็นช็อตถัดไป ${d} เฟรม → สั้นลงเป็น ${res.dur} เฟรม / tail leak: trim tail`);
    } else {
      res.warnings.push(`ท้ายคลิปเห็นช็อตถัดไป ${d} เฟรม แต่เลื่อนโดยคงความยาวไม่ได้ (ชนรอยตัด/ต้นไฟล์) — ใช้ allowDurChange / cannot slide without changing duration`);
    }
  } else {
    const dh = headCut! - visFrom;
    const dt = visTo - tailCut!;
    if (opts.allowDurChange && consumed - dh - dt > 0) {
      res.in = clip.in + dh;
      res.dur = durFor(consumed - dh - dt);
      res.reasons.push(`ทั้งหัว (${dh}) และท้าย (${dt}) เห็นช็อตข้างเคียง → in ${res.in}, dur ${res.dur} / both ends leak: trim both`);
    } else {
      res.warnings.push(`ทั้งหัว (${dh}) และท้าย (${dt}) เห็นช็อตข้างเคียง — ช็อตต้นทางสั้นกว่าคลิป ต้องลดความยาว (allowDurChange) / shot shorter than clip`);
    }
  }
  if (res.in < hhSrc) {
    res.warnings.push('in ใหม่ไม่เหลือ handle พอสำหรับ dissolve / not enough head handle');
  }
  res.changed = res.in !== clip.in || res.dur !== clip.dur;
  return res;
}
