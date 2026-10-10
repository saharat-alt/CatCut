/**
 * MCP tool definitions. Each tool: zod input shape + handler(args, state) → JSON-able data.
 * Errors thrown by a handler become `isError` results with a JSON body ({ ok: false, error, ...data }).
 * All times are frames at project fps (CLAUDE.md).
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { z } from 'zod';
import { framesToTc } from '../core/timecode.js';
import type { AeOp, Asset, AudioClip, Clip, JobInfo, Project, Timeline } from '../core/types.js';
import { compsNeedingRender, isAeComp, requireFfmpeg, requireProject, type AppState } from './state.js';

// ---------- result plumbing ----------

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/** Throw to return a structured failure (data is merged into the JSON body). */
class ToolError extends Error {
  constructor(message: string, public readonly data: Record<string, unknown> = {}) {
    super(message);
  }
}

export interface ToolDef {
  name: string;
  description: string;
  input: z.ZodRawShape;
  // `never` lets each tool keep its precise inferred arg type without a cast at definition time.
  handler: (args: never, state: AppState) => Promise<unknown>;
}

function tool<S extends z.ZodRawShape>(def: {
  name: string;
  description: string;
  input: S;
  handler: (args: z.infer<z.ZodObject<S>>, state: AppState) => Promise<unknown>;
}): ToolDef {
  return def as ToolDef;
}

function json(data: unknown): string {
  return JSON.stringify(data, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v), 2);
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: json(data) }] };
}

function fail(err: unknown): ToolResult {
  const body = err instanceof ToolError
    ? { ok: false, error: err.message, ...err.data }
    : { ok: false, error: err instanceof Error ? err.message : String(err) };
  return { isError: true, content: [{ type: 'text', text: json(body) }] };
}

export async function runTool(t: ToolDef, args: unknown, state: AppState): Promise<ToolResult> {
  try {
    if (['project_new', 'project_open', 'asset_add', 'timeline_set', 'timeline_edit', 'audio_add', 'ae_edit', 'import_premiere_xml'].includes(t.name)) {
      const running = activeJob(state, ['build', 'deliver']);
      if (running) throw new ToolError(`wait for ${running.name} before editing the project`, { jobId: running.id });
    }
    return ok(await t.handler(args as never, state));
  } catch (err) {
    return fail(err);
  }
}

/** Validate args with the tool's schema and run it (used by the CLI and tests). */
export async function callTool(state: AppState, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`unknown tool: ${name}`);
  const parsed = z.object(t.input).safeParse(args);
  if (!parsed.success) return fail(new ToolError('invalid arguments', { issues: parsed.error.issues }));
  return runTool(t, parsed.data, state);
}

/** Parse the JSON body of a ToolResult. */
export function toolResultData(r: ToolResult): Record<string, unknown> {
  const text = r.content[0]?.text ?? '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

// ---------- schemas ----------

const frames = z.number().int();
const layerRef = z.union([z.string(), z.number()]);

const ClipSchema = z.object({
  id: z.string().min(1),
  src: z.string().min(1).describe('asset id'),
  in: frames.min(0).describe('source in-point (frames)'),
  dur: frames.describe('timeline duration (frames)'),
  scale: z.number().optional().describe('percent, default 100'),
  marker: z.string().optional().describe('marker name at clip start'),
});
const CutSchema = z.object({
  after: z.string().describe('clip id; the cut between it and the next clip'),
  dissolve: frames.min(0).describe('frames; 0 = hard cut'),
});
const AudioClipSchema = z.object({
  id: z.string().min(1),
  src: z.string().min(1).describe('asset id'),
  at: frames.min(0).describe('timeline position (frames)'),
  in: frames.min(0).optional(),
  dur: frames.optional(),
  gainDb: z.number().optional(),
  fadeIn: frames.min(0).optional(),
  fadeOut: frames.min(0).optional(),
});
const DuckSchema = z.object({ underDb: z.number(), attackMs: z.number(), releaseMs: z.number() });
const AudioTracksSchema = z.object({
  vo: z.array(AudioClipSchema).default([]),
  music: z.array(AudioClipSchema).default([]),
  sfx: z.array(AudioClipSchema).default([]),
  duck: DuckSchema.optional(),
  useClipAudio: z.boolean().optional(),
});
const TimelineSchema = z.object({
  video: z.array(ClipSchema),
  cuts: z.array(CutSchema).default([]),
  audio: AudioTracksSchema.default({ vo: [], music: [], sfx: [] }),
});

const AeOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('setText'), layer: layerRef, text: z.string(), fontSize: z.number().optional(), font: z.string().optional(), color: z.tuple([z.number(), z.number(), z.number()]).optional() }),
  z.object({ op: z.literal('replaceFootage'), layer: layerRef, path: z.string() }),
  z.object({ op: z.literal('shiftLayer'), layer: layerRef, frames }),
  z.object({ op: z.literal('setProperty'), layer: layerRef, property: z.string(), value: z.unknown(), atFrame: frames.optional() }),
  z.object({ op: z.literal('addEffect'), layer: layerRef, matchName: z.string(), properties: z.record(z.unknown()).optional() }),
  z.object({ op: z.literal('applyPreset'), layer: layerRef, ffxPath: z.string() }),
  z.object({ op: z.literal('setLayerEnabled'), layer: layerRef, enabled: z.boolean() }),
  z.object({ op: z.literal('duplicateComp'), newName: z.string() }),
  z.object({ op: z.literal('script'), jsx: z.string() }),
]);

const EditOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('insert'), clip: ClipSchema, index: z.number().int().min(0).optional(), after: z.string().optional().describe('insert after this clip id (default: end)') }),
  z.object({ op: z.literal('move'), id: z.string(), index: z.number().int().min(0) }),
  z.object({ op: z.literal('remove'), id: z.string() }),
  z.object({ op: z.literal('trim'), id: z.string(), in: frames.min(0).optional(), dur: frames.optional() }),
  z.object({ op: z.literal('set_dissolve'), after: z.string(), frames: frames.min(0).describe('0 removes the dissolve') }),
  z.object({ op: z.literal('set_marker'), id: z.string(), name: z.string().optional().describe('omit to remove') }),
  z.object({ op: z.literal('set_scale'), id: z.string(), scale: z.number().positive() }),
  z.object({ op: z.literal('remove_audio'), id: z.string() }),
]);
type EditOp = z.infer<typeof EditOpSchema>;

// ---------- helpers ----------

const WIN = process.platform === 'win32';
function samePath(a: string, b: string): boolean {
  const x = resolve(a); const y = resolve(b);
  return WIN ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** Never overwrite: returns p, or p_2, p_3 ... (before the extension). */
export function uniquePath(p: string): string {
  if (!existsSync(p)) return p;
  const ext = extname(p);
  const base = ext ? p.slice(0, -ext.length) : p;
  for (let i = 2; ; i++) {
    const c = `${base}_${i}${ext}`;
    if (!existsSync(c)) return c;
  }
}

function fileSafe(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'untitled';
}

function asciiSlug(s: string): string {
  const slug = s.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  if (slug === s) return slug;
  // non-ASCII (e.g. Thai) names: keep a stable short hash so different comps never collide
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return `${slug || 'comp'}_${h.toString(16)}`;
}

function assetSummary(a: Asset) {
  const pr = a.probe;
  const base = {
    id: a.id,
    kind: a.kind,
    frames: pr?.durationFrames,
    size: pr?.width && pr.height ? `${pr.width}x${pr.height}` : undefined,
    fps: pr?.fps,
    hasAudio: pr?.hasAudio,
  };
  if (isAeComp(a)) {
    const stale = !!a.render && a.fingerprint !== undefined && a.render.fingerprint !== a.fingerprint;
    return { ...base, aep: a.aep, comp: a.comp, render: a.render ? { path: a.render.path, frames: a.render.frames, stale } : null, needsRender: !a.render || stale };
  }
  return { ...base, path: a.path };
}

function timelineSummary(state: AppState, p: Project) {
  const fps = p.meta.fps;
  const total = state.api.project.timelineFrames(p);
  const starts = state.api.project.clipStartFrames(p);
  const t = p.timeline;
  return {
    frames: total,
    tc: framesToTc(total, fps),
    clips: t.video.map((c) => {
      const start = starts.get(c.id) ?? 0;
      return { id: c.id, src: c.src, start, startTc: framesToTc(start, fps), in: c.in, dur: c.dur, scale: c.scale, marker: c.marker };
    }),
    dissolves: t.cuts.filter((c) => c.dissolve > 0),
    audio: { vo: t.audio.vo.length, music: t.audio.music.length, sfx: t.audio.sfx.length, duck: t.audio.duck, useClipAudio: t.audio.useClipAudio ?? true },
  };
}

function jobSummary(j: JobInfo, logLines = 20) {
  return { ...j, log: j.log.slice(-logLines) };
}

function activeJob(state: AppState, names: string[]): JobInfo | undefined {
  return state.jobs.list().find((j) => (j.status === 'running' || j.status === 'queued') && names.includes(j.name));
}

/** Apply a new timeline; on validation errors the previous timeline is restored and the errors returned. */
function commitTimeline(state: AppState, p: Project, next: Timeline): string[] {
  const prev = p.timeline;
  state.api.project.setTimeline(p, next);
  const errors = state.api.project.validateTimeline(p);
  if (errors.length) state.api.project.setTimeline(p, prev);
  return errors;
}

async function commitOrThrow(state: AppState, p: Project, next: Timeline, what: string): Promise<void> {
  const errors = commitTimeline(state, p, next);
  if (errors.length) throw new ToolError(`${what} ไม่ผ่านการตรวจสอบ ไม่ได้บันทึก / ${what} invalid, not applied`, { errors });
  await state.api.project.saveProject(p);
}

export function applyEditOps(t: Timeline, ops: EditOp[]): Timeline {
  const tl = structuredClone(t);
  const idx = (id: string): number => {
    const i = tl.video.findIndex((c) => c.id === id);
    if (i < 0) throw new Error(`ไม่พบคลิป / unknown clip: ${id}`);
    return i;
  };
  const clip = (id: string): Clip => tl.video[idx(id)]!;
  for (const op of ops) {
    switch (op.op) {
      case 'insert': {
        if (tl.video.some((c) => c.id === op.clip.id)) throw new Error(`clip id ซ้ำ / duplicate clip id: ${op.clip.id}`);
        const at = op.after !== undefined ? idx(op.after) + 1 : Math.min(op.index ?? tl.video.length, tl.video.length);
        tl.video.splice(at, 0, op.clip);
        break;
      }
      case 'move': {
        const [c] = tl.video.splice(idx(op.id), 1);
        tl.video.splice(Math.min(op.index, tl.video.length), 0, c!);
        break;
      }
      case 'remove':
        tl.video.splice(idx(op.id), 1);
        tl.cuts = tl.cuts.filter((c) => c.after !== op.id);
        break;
      case 'trim': {
        const c = clip(op.id);
        if (op.in !== undefined) c.in = op.in;
        if (op.dur !== undefined) c.dur = op.dur;
        break;
      }
      case 'set_dissolve': {
        if (idx(op.after) === tl.video.length - 1) throw new Error(`ใส่ dissolve หลังคลิปสุดท้ายไม่ได้ / no cut after the last clip: ${op.after}`);
        tl.cuts = tl.cuts.filter((c) => c.after !== op.after);
        if (op.frames > 0) tl.cuts.push({ after: op.after, dissolve: op.frames });
        break;
      }
      case 'set_marker': {
        const c = clip(op.id);
        if (op.name) c.marker = op.name; else delete c.marker;
        break;
      }
      case 'set_scale':
        clip(op.id).scale = op.scale;
        break;
      case 'remove_audio': {
        const a = tl.audio;
        const before = a.vo.length + a.music.length + a.sfx.length;
        a.vo = a.vo.filter((c) => c.id !== op.id);
        a.music = a.music.filter((c) => c.id !== op.id);
        a.sfx = a.sfx.filter((c) => c.id !== op.id);
        if (a.vo.length + a.music.length + a.sfx.length === before) throw new Error(`ไม่พบ audio clip / unknown audio clip: ${op.id}`);
        break;
      }
    }
  }
  // cuts are keyed by the clip before them; after moves/removes drop the ones that no longer sit between two clips
  const last = tl.video[tl.video.length - 1]?.id;
  const ids = new Set(tl.video.map((c) => c.id));
  tl.cuts = tl.cuts.filter((c) => ids.has(c.after) && c.after !== last);
  return tl;
}

interface ClipChange { index: number; id?: string; field: string; from?: unknown; to?: unknown }

/** Positional diff of two timelines (Premiere does not preserve our clip ids reliably). */
export function diffTimelines(a: Timeline, b: Timeline) {
  const clips: ClipChange[] = [];
  const n = Math.max(a.video.length, b.video.length);
  for (let i = 0; i < n; i++) {
    const x = a.video[i]; const y = b.video[i];
    if (!x) { clips.push({ index: i, id: y!.id, field: 'added', to: y }); continue; }
    if (!y) { clips.push({ index: i, id: x.id, field: 'removed', from: x }); continue; }
    for (const f of ['src', 'in', 'dur', 'scale', 'marker'] as const) {
      const from = f === 'scale' ? x[f] ?? 100 : x[f];
      const to = f === 'scale' ? y[f] ?? 100 : y[f];
      if (from !== to) clips.push({ index: i, id: x.id, field: f, from, to });
    }
  }
  const dis = (t: Timeline) => new Map(t.cuts.filter((c) => c.dissolve > 0).map((c) => [c.after, c.dissolve]));
  const da = dis(a); const db = dis(b);
  const dissolves: Array<{ after: string; from: number; to: number }> = [];
  for (const k of new Set([...da.keys(), ...db.keys()])) {
    const from = da.get(k) ?? 0; const to = db.get(k) ?? 0;
    if (from !== to) dissolves.push({ after: k, from, to });
  }
  const sum = (t: Timeline) => t.video.reduce((s, c) => s + c.dur, 0);
  const counts = (t: Timeline) => ({ vo: t.audio.vo.length, music: t.audio.music.length, sfx: t.audio.sfx.length });
  return {
    frames: { before: sum(a), after: sum(b) },
    clips: { before: a.video.length, after: b.video.length, changed: clips },
    dissolves,
    audio: { before: counts(a), after: counts(b) },
  };
}

function projectStatus(state: AppState, p: Project) {
  const assets = Object.values(p.assets);
  const byKind: Record<string, number> = {};
  for (const a of assets) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
  const latest = p.versions[p.versions.length - 1];
  return {
    name: p.meta.name,
    dir: p.dir,
    fps: p.meta.fps,
    size: `${p.meta.width}x${p.meta.height}`,
    assets: { total: assets.length, byKind, compsNeedingRender: compsNeedingRender(p) },
    timeline: timelineSummary(state, p),
    validation: state.api.project.validateTimeline(p),
    delivery: p.delivery,
    versions: {
      count: p.versions.length,
      latest: latest ? { id: latest.id, createdAt: latest.createdAt, master: latest.master, reviewProxy: latest.reviewProxy, deliverables: latest.deliverables, qcOk: latest.qc?.ok } : null,
    },
    jobs: state.jobs.list().filter((j) => j.status === 'running' || j.status === 'queued').map((j) => ({ id: j.id, name: j.name, progress: j.progress })),
  };
}

const COMPAT_NOTES: readonly string[] = [
  'AE headless = AfterFX.com -m -noui -r <jsx>: ต้องมี -m เสมอ ไม่งั้นสคริปต์จะไปรันใน AE ที่เปิดอยู่ (DESIGN §2.1)',
  'AE 25.2.2–26.3: ชื่อไฟล์ output ภาษาไทยจากสคริปต์กลายเป็นขีด → render ชื่อ ASCII แล้ว rename (DESIGN §2.1)',
  'saveFrameToPng ไม่เสถียร → preview frame ใช้ aerender -s N -e N (DESIGN §2.1)',
  'OutputModule.setSettings เปลี่ยน Format ไม่ได้ → ต้องมี OM template "EDITMCP ProRes 422 HQ" หรือ fallback Lossless + ffmpeg (DESIGN §2.1, §12)',
  'ไม่ใช้ nexrender patch (commandLineRenderer.jsx): ต้อง admin และพังเมื่ออัปเดต AE (DESIGN §2.1)',
  'Premiere ไม่มี headless: แลกเปลี่ยนด้วย FCP7 XML (xmeml) เท่านั้น; FCPXML เปิดไม่ได้, OTIO ยังเบต้าไม่มีทรานซิชัน (DESIGN §2.2)',
  'Premiere 2026: dissolve เลขคี่ / Motion scale / pathurl ไทย ยังต้องทดสอบจริง (DESIGN §5.3, §10)',
  'ffmpeg 9: ไม่อ่าน camera RAW (R3D/BRAW/ARRIRAW) (DESIGN §2.3)',
  'เครื่อง 16 GB: render AE ทีละตัว, เช็ค RAM ว่างก่อน aerender (CLAUDE.md)',
];

// ---------- tools ----------

export const TOOLS: readonly ToolDef[] = [
  tool({
    name: 'project_new',
    description: 'สร้างโปรเจกต์ใหม่ในโฟลเดอร์ (project.json) · Create a project: dir, name, fps=25, 1920x1080',
    input: {
      dir: z.string().describe('project folder (created if missing)'),
      name: z.string().min(1),
      fps: z.number().positive().optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
    },
    handler: async (a, state) => {
      const dir = resolve(a.dir);
      if (existsSync(join(dir, 'project.json'))) throw new ToolError('มีโปรเจกต์อยู่แล้ว ใช้ project_open / project already exists, use project_open', { dir });
      const p = await state.api.project.createProject(dir, { name: a.name, fps: a.fps, width: a.width, height: a.height });
      state.project = p;
      return { ok: true, ...projectStatus(state, p) };
    },
  }),

  tool({
    name: 'project_open',
    description: 'เปิดโปรเจกต์ที่มีอยู่ · Open an existing project folder',
    input: { dir: z.string() },
    handler: async (a, state) => {
      const p = await state.api.project.loadProject(resolve(a.dir));
      state.project = p;
      return { ok: true, ...projectStatus(state, p) };
    },
  }),

  tool({
    name: 'project_status',
    description: 'สถานะโปรเจกต์: assets, timeline, comp ที่ต้อง render, เวอร์ชัน, jobs · Project status',
    input: {},
    handler: async (_a, state) => projectStatus(state, requireProject(state)),
  }),

  tool({
    name: 'asset_add',
    description: 'เพิ่มไฟล์สื่อ (path) หรือ AE comp (aep + comp) · Add a media file or an After Effects comp',
    input: {
      path: z.string().optional().describe('video / still / audio file'),
      aep: z.string().optional().describe('.aep path (with comp)'),
      comp: z.string().optional().describe('comp name inside the .aep'),
      id: z.string().optional().describe('asset id (default: auto)'),
      kind: z.enum(['camera', 'graphic', 'still', 'audio']).optional().describe('for files; default from probe'),
    },
    handler: async (a, state) => {
      const p = requireProject(state);
      let asset: Asset;
      if (a.aep) {
        if (!a.comp) throw new ToolError('ต้องระบุ comp คู่กับ aep / comp is required with aep');
        const aep = resolve(a.aep);
        if (!existsSync(aep)) throw new ToolError(`ไม่พบไฟล์ / file not found: ${aep}`);
        asset = state.api.project.addAeComp(p, aep, a.comp, a.id);
      } else if (a.path) {
        requireFfmpeg(state);
        const path = resolve(a.path);
        if (!existsSync(path)) throw new ToolError(`ไม่พบไฟล์ / file not found: ${path}`);
        asset = await state.api.project.addFileAsset(p, path, { id: a.id, kind: a.kind, probe: state.api.probe });
      } else {
        throw new ToolError('ต้องระบุ path หรือ aep+comp / give path, or aep + comp');
      }
      await state.api.project.saveProject(p);
      return { ok: true, asset: assetSummary(asset) };
    },
  }),

  tool({
    name: 'asset_list',
    description: 'รายการ assets ทั้งหมด · List assets',
    input: {},
    handler: async (_a, state) => {
      const p = requireProject(state);
      return { assets: Object.values(p.assets).map(assetSummary) };
    },
  }),

  tool({
    name: 'timeline_set',
    description: 'ตั้งไทม์ไลน์ทั้งหมด (หน่วยเฟรม) ตรวจสอบก่อน ถ้าผิดจะไม่บันทึก · Set the whole timeline (frames); validated, rejected if invalid',
    input: { timeline: TimelineSchema },
    handler: async (a, state) => {
      const p = requireProject(state);
      await commitOrThrow(state, p, a.timeline, 'timeline');
      return { ok: true, timeline: timelineSummary(state, p) };
    },
  }),

  tool({
    name: 'timeline_edit',
    description: 'แก้ไทม์ไลน์ทีละจุด: insert / move / remove / trim / set_dissolve / set_marker / set_scale / remove_audio · Small timeline edits (validated)',
    input: { ops: z.array(EditOpSchema).min(1) },
    handler: async (a, state) => {
      const p = requireProject(state);
      const next = applyEditOps(p.timeline, a.ops);
      await commitOrThrow(state, p, next, 'timeline');
      return { ok: true, applied: a.ops.length, timeline: timelineSummary(state, p) };
    },
  }),

  tool({
    name: 'audio_add',
    description: 'ใส่ VO / เพลง / SFX ที่ตำแหน่ง (เฟรม); ตั้ง ducking ได้ · Add an audio clip to vo / music / sfx',
    input: {
      track: z.enum(['vo', 'music', 'sfx']),
      src: z.string().describe('asset id'),
      at: frames.min(0).default(0),
      id: z.string().optional(),
      in: frames.min(0).optional(),
      dur: frames.optional(),
      gainDb: z.number().optional(),
      fadeIn: frames.min(0).optional(),
      fadeOut: frames.min(0).optional(),
      duck: DuckSchema.optional().describe('music under vo, e.g. {underDb:-12, attackMs:150, releaseMs:400}'),
      useClipAudio: z.boolean().optional(),
    },
    handler: async (a, state) => {
      const p = requireProject(state);
      const next = structuredClone(p.timeline);
      const all = [...next.audio.vo, ...next.audio.music, ...next.audio.sfx];
      let id = a.id;
      if (!id) {
        let n = next.audio[a.track].length + 1;
        while (all.some((c) => c.id === `${a.track}${n}`)) n++;
        id = `${a.track}${n}`;
      } else if (all.some((c) => c.id === id)) {
        throw new ToolError(`audio id ซ้ำ / duplicate audio id: ${id}`);
      }
      const clip: AudioClip = { id, src: a.src, at: a.at, in: a.in, dur: a.dur, gainDb: a.gainDb, fadeIn: a.fadeIn, fadeOut: a.fadeOut };
      next.audio[a.track].push(clip);
      if (a.duck) next.audio.duck = a.duck;
      if (a.useClipAudio !== undefined) next.audio.useClipAudio = a.useClipAudio;
      await commitOrThrow(state, p, next, 'audio');
      return { ok: true, clip, timeline: timelineSummary(state, p) };
    },
  }),

  tool({
    name: 'ae_list_comps',
    description: 'รายชื่อ comp ใน .aep (เปิด AE แบบ headless) · List comps in an .aep',
    input: { aep: z.string() },
    handler: async (a, state) => ({ comps: await state.ae.listComps(resolve(a.aep)) }),
  }),

  tool({
    name: 'ae_inspect_comp',
    description: 'ดู layer ของ comp (ชนิด, in/out, ข้อความ, effects, ขอบเขต) · Inspect a comp\'s layers',
    input: { aep: z.string(), comp: z.string(), atFrame: frames.min(0).optional() },
    handler: async (a, state) => state.ae.inspectComp(resolve(a.aep), a.comp, a.atFrame),
  }),

  tool({
    name: 'ae_edit',
    description: 'แก้ comp (setText, replaceFootage, shiftLayer, setProperty, addEffect, applyPreset, setLayerEnabled, duplicateComp, script) แล้วบันทึก; render เดิมจะถูกนับว่าเก่า · Edit a comp',
    input: { aep: z.string(), comp: z.string(), ops: z.array(AeOpSchema).min(1), saveAs: z.string().optional() },
    handler: async (a, state) => {
      const aep = resolve(a.aep);
      const res = await state.ae.edit({ aep, comp: a.comp, ops: a.ops as AeOp[], saveAs: a.saveAs ? resolve(a.saveAs) : undefined });
      const stale: string[] = [];
      const p = state.project;
      if (p && res.ok) {
        for (const asset of Object.values(p.assets)) {
          if (isAeComp(asset) && asset.comp === a.comp && samePath(asset.aep, res.savedTo)) {
            asset.fingerprint = res.fingerprint;
            stale.push(asset.id);
          }
        }
        if (stale.length) await state.api.project.saveProject(p);
      }
      return { ...res, staleAssets: stale, hint: stale.length ? 'build จะ render comp นี้ใหม่ / build re-renders these comps' : undefined };
    },
  }),

  tool({
    name: 'ae_preview_frame',
    description: 'render เฟรมเดียวของ comp เป็น PNG · Render one frame of a comp to PNG',
    input: { aep: z.string(), comp: z.string(), frame: frames.min(0).default(0), out: z.string().optional().describe('png path (default: project review folder)') },
    handler: async (a, state) => {
      let out = a.out ? resolve(a.out) : '';
      if (!out) {
        const dir = state.project ? state.api.project.projectPaths(state.project).review : join(os.tmpdir(), 'editmcp');
        await mkdir(dir, { recursive: true });
        out = join(dir, `preview_${asciiSlug(a.comp)}_${a.frame}.png`);
      }
      out = uniquePath(out);
      const png = await state.ae.previewFrame(resolve(a.aep), a.comp, a.frame, out);
      return { ok: true, png };
    },
  }),

  tool({
    name: 'build',
    description: 'render เฉพาะที่เปลี่ยน → ต่อท่อน → เสียง → master ProRes → QC → deliverables; คืน job id ทันที · Incremental build (async job)',
    input: {
      force: z.boolean().optional().describe('ignore caches'),
      skipQc: z.boolean().optional(),
      skipDeliver: z.boolean().optional(),
    },
    handler: async (a, state) => {
      const p = requireProject(state);
      requireFfmpeg(state);
      const running = activeJob(state, ['build', 'deliver']);
      if (running) throw new ToolError(`มี ${running.name} กำลังทำงานอยู่ / a ${running.name} job is already running`, { jobId: running.id });
      const errors = state.api.project.validateTimeline(p);
      if (errors.length) throw new ToolError('timeline ไม่ผ่านการตรวจสอบ / timeline invalid', { errors });
      const job = state.jobs.start('build', async (ctx) => {
        const r = await state.assembler.build(p, {
          force: a.force, skipQc: a.skipQc, skipDeliver: a.skipDeliver, signal: ctx.signal,
          onProgress: (pr) => {
            ctx.progress(pr);
            ctx.log(`${pr.stage} ${pr.done}/${pr.total}${pr.message ? ' ' + pr.message : ''}`);
          },
        });
        return { version: r.version.id, master: r.version.master, reviewProxy: r.version.reviewProxy, deliverables: r.version.deliverables, qcOk: r.version.qc?.ok, qcIssues: r.version.qc?.issues.length ?? 0, stats: r.stats };
      });
      return { ok: true, jobId: job.id, status: job.status, hint: 'ดูความคืบหน้าด้วย job_status / poll job_status {id}' };
    },
  }),

  tool({
    name: 'deliver',
    description: 'สร้าง deliverable จาก master ของเวอร์ชัน (job) · Encode deliverables (yt, fb, vert, th_tv, th_prores, led, m422hq) from a version',
    input: {
      version: z.string().optional().describe('default: latest'),
      targets: z.array(z.string()).optional().describe('default: project.delivery.targets'),
    },
    handler: async (a, state) => {
      const p = requireProject(state);
      requireFfmpeg(state);
      const running = activeJob(state, ['build', 'deliver']);
      if (running) throw new ToolError(`มี ${running.name} กำลังทำงานอยู่ / a ${running.name} job is already running`, { jobId: running.id });
      const version = a.version ?? p.versions[p.versions.length - 1]?.id;
      if (!version) throw new ToolError('ยังไม่มีเวอร์ชัน ต้อง build ก่อน / no version yet: run build first');
      if (!p.versions.some((v) => v.id === version)) throw new ToolError(`ไม่พบเวอร์ชัน / unknown version: ${version}`, { versions: p.versions.map((v) => v.id) });
      const targets = a.targets ?? p.delivery.targets;
      if (!targets.length) throw new ToolError('ไม่มี target / no delivery targets given');
      const job = state.jobs.start('deliver', async (ctx) => {
        const deliverables = await state.assembler.deliver(p, version, targets, {
          signal: ctx.signal,
          onProgress: (pr) => { ctx.progress(pr); ctx.log(`${pr.stage} ${pr.done}/${pr.total}${pr.message ? ' ' + pr.message : ''}`); },
        });
        return { version, deliverables };
      });
      return { ok: true, jobId: job.id, status: job.status, version, targets };
    },
  }),

  tool({
    name: 'job_status',
    description: 'ความคืบหน้า / log / ผลลัพธ์ของ job · Job progress, log tail and result',
    input: { id: z.string() },
    handler: async (a, state) => {
      const j = state.jobs.get(a.id);
      if (!j) throw new ToolError(`ไม่พบ job / unknown job: ${a.id}`);
      return jobSummary(j, 200);
    },
  }),

  tool({
    name: 'job_list',
    description: 'รายการ jobs · List jobs',
    input: {},
    handler: async (_a, state) => ({ jobs: state.jobs.list().map((j) => jobSummary(j, 3)) }),
  }),

  tool({
    name: 'job_cancel',
    description: 'ยกเลิก job ที่กำลังทำงาน · Cancel a running job',
    input: { id: z.string() },
    handler: async (a, state) => {
      const j = state.jobs.get(a.id);
      if (!j) throw new ToolError(`ไม่พบ job / unknown job: ${a.id}`);
      return { ok: true, cancelled: state.jobs.cancel(a.id), status: state.jobs.get(a.id)?.status };
    },
  }),

  tool({
    name: 'qc_report',
    description: 'รายงาน QC ของเวอร์ชัน (ล่าสุดถ้าไม่ระบุ) · QC report of a version',
    input: { version: z.string().optional() },
    handler: async (a, state) => {
      const p = requireProject(state);
      const v = a.version ? p.versions.find((x) => x.id === a.version) : p.versions[p.versions.length - 1];
      if (!v) throw new ToolError(a.version ? `ไม่พบเวอร์ชัน / unknown version: ${a.version}` : 'ยังไม่มีเวอร์ชัน / no version yet');
      return { version: v.id, master: v.master, qc: v.qc ?? null, note: v.qc ? undefined : 'ไม่มีรายงาน QC (build ด้วย skipQc?) / no QC report' };
    },
  }),

  tool({
    name: 'export_premiere_xml',
    description: 'ส่งออก FCP7 XML (xmeml) ไปเปิดใน Premiere → out/<version>/<name>.xml · Export the timeline as FCP7 XML for Premiere',
    input: { version: z.string().optional().describe('default: latest, or "draft" before any build'), sequenceName: z.string().optional() },
    handler: async (a, state) => {
      const p = requireProject(state);
      if (a.version && !p.versions.some((v) => v.id === a.version)) throw new ToolError(`ไม่พบเวอร์ชัน / unknown version: ${a.version}`);
      const version = a.version ?? p.versions[p.versions.length - 1]?.id ?? 'draft';
      const sequenceName = a.sequenceName ?? `${p.meta.name}_${version}`;
      const xml = state.api.xmeml.writeXmeml(p, { sequenceName });
      const dir = join(state.api.project.projectPaths(p).out, version);
      await mkdir(dir, { recursive: true });
      const path = uniquePath(join(dir, `${fileSafe(p.meta.name)}.xml`));
      await writeFile(path, xml, { encoding: 'utf8', flag: 'wx' });
      return { ok: true, path, version, sequenceName, clips: p.timeline.video.length, unrendered: compsNeedingRender(p) };
    },
  }),

  tool({
    name: 'import_premiere_xml',
    description: 'นำ FCP7 XML ที่ export จาก Premiere กลับมา: สรุปความต่าง แล้วใช้กับไทม์ไลน์ (ถ้าผ่านการตรวจสอบ) · Import Premiere XML: diff + apply',
    input: { path: z.string() },
    handler: async (a, state) => {
      const p = requireProject(state);
      const path = resolve(a.path);
      if (!existsSync(path)) throw new ToolError(`ไม่พบไฟล์ / file not found: ${path}`);
      const r = state.api.xmeml.readXmeml(await readFile(path, 'utf8'), p);
      const warnings: string[] = [];
      if (r.fps !== p.meta.fps) warnings.push(`fps ใน XML = ${r.fps} แต่โปรเจกต์ = ${p.meta.fps}`);
      if (r.width !== p.meta.width || r.height !== p.meta.height) warnings.push(`ขนาดใน XML = ${r.width}x${r.height} แต่โปรเจกต์ = ${p.meta.width}x${p.meta.height}`);
      const diff = diffTimelines(p.timeline, r.timeline);
      const errors = commitTimeline(state, p, r.timeline);
      if (errors.length) {
        throw new ToolError('ไทม์ไลน์จาก XML ไม่ผ่านการตรวจสอบ ไม่ได้บันทึก / imported timeline invalid, not applied', { errors, unresolvedPaths: r.unresolvedPaths, diff, warnings });
      }
      await state.api.project.saveProject(p);
      return { ok: true, applied: true, file: basename(path), diff, warnings, unresolvedPaths: r.unresolvedPaths, timeline: timelineSummary(state, p) };
    },
  }),

  tool({
    name: 'doctor',
    description: 'ตรวจเครื่องมือ: ffmpeg, encoders (NVENC), AE, RAM + ข้อควรระวังตามเวอร์ชัน · Environment check and compat notes',
    input: {},
    handler: async (_a, state) => {
      const env = state.env;
      const freeRamGb = os.freemem() / 2 ** 30;
      let aeVersion = 'unknown (not launched)';
      if (process.env['EDITMCP_ALLOW_AE'] === '1' && env.tools.afterfx) {
        try { aeVersion = await state.ae.version(); } catch (err) { aeVersion = `error: ${err instanceof Error ? err.message : String(err)}`; }
      } else if (env.aeVersion) {
        aeVersion = env.aeVersion;
      }
      const r1 = (n: number) => Math.round(n * 10) / 10;
      return {
        ok: state.problems.length === 0,
        tools: env.tools,
        ffmpegVersion: env.ffmpegVersion,
        encoders: env.encoders,
        gpu: env.encoders.h264_nvenc ? 'NVENC encoder found; runtime failure falls back to libx264' : 'ไม่มี NVENC → libx264',
        ram: { totalGb: r1(env.totalRamGb), freeGb: r1(freeRamGb), low: freeRamGb < 3 },
        cpuThreads: env.cpuThreads,
        aeVersion,
        aeBackend: state.ae.kind,
        afterEffects: env.tools.afterfx ? 'found' : 'not found (ae_* tools unavailable)',
        premiere: env.tools.premiereExe ? 'found (optional; exchange via FCP7 XML)' : 'not found (optional)',
        problems: state.problems,
        compat: COMPAT_NOTES,
        project: state.project ? { name: state.project.meta.name, dir: state.project.dir } : null,
      };
    },
  }),
];
