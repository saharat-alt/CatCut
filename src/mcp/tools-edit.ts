/**
 * Edit tools (DESIGN.md §13.2 rows 3, 9, 10 and §13.3 item 6): join report/policy, per-shot revert,
 * quick range previews. Mutating tools are dry runs by default and back the timeline up before applying.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { framesToTc } from '../core/timecode.js';
import type { Clip, JobInfo, Project, Version } from '../core/types.js';
import type { PinnableComp, PreviewRangeOptions, PreviewRangeResult } from '../engine/ffmpeg.js';
import { applyJoinProposals, joinReport, proposeJoins, type EdgeOptions } from '../engine/joins.js';
import { requireFfmpeg, requireProject, type AppState, type JobContext } from './state.js';
import { tool, ToolError, type ToolDef } from './tooldef.js';

const WAIT_MS = 20_000;
/** Job names that use the project (same list the core tools block on). */
const PROJECT_JOBS = ['build', 'deliver', 'preview', 'review_open'];

// ---------- helpers ----------

function activeJob(state: AppState): JobInfo | undefined {
  return state.jobs.list().find((j) => (j.status === 'running' || j.status === 'queued') && PROJECT_JOBS.includes(j.name));
}

async function runJob(state: AppState, name: string, wait: boolean | undefined, fn: (ctx: JobContext) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const job = state.jobs.start(name, fn);
  const pending = () => ({ ok: true, jobId: job.id, status: state.jobs.get(job.id)?.status ?? job.status, pending: true, hint: 'ยังทำงานอยู่ — ดูผลด้วย job_status {id} / still running: poll job_status' });
  if (wait === false) return pending();
  let timer: NodeJS.Timeout | undefined;
  const info = await Promise.race([
    state.jobs.wait(job.id),
    new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), WAIT_MS); }),
  ]);
  clearTimeout(timer);
  if (!info) return pending();
  if (info.status === 'done') return { ...(info.result as Record<string, unknown>), jobId: job.id };
  throw new ToolError(info.error ?? `${name} ${info.status}`, { jobId: job.id, status: info.status });
}

/** history/timeline-<ISO-safe>-<n>.json (same format timeline_restore lists); exclusive create, never overwrites. */
async function backupTimeline(p: Project, reason: string): Promise<string> {
  const dir = join(p.dir, 'history');
  await mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  const stamp = now.replace(/[:.]/g, '-');
  const body = `${JSON.stringify({ savedAt: now, reason, timeline: p.timeline }, null, 2)}\n`;
  for (let n = 1; ; n++) {
    const file = join(dir, `timeline-${stamp}-${n}.json`);
    try {
      await writeFile(file, body, { encoding: 'utf8', flag: 'wx' });
      return file;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

function findVersion(p: Project, id: string): Version {
  const v = p.versions.find((x) => x.id === id);
  if (!v) throw new ToolError(`ไม่พบเวอร์ชัน / unknown version: ${id}`, { versions: p.versions.map((x) => x.id) });
  return v;
}

const edgeArgs = {
  logoPattern: z.string().optional().describe('regex (case-insensitive) for logo edges, matched on asset id / slot / comp or file name; default logo|โลโก้'),
  edgeTypes: z.record(z.string()).optional().describe('explicit edge type by clip id, slot id or asset id, e.g. {"title": "card", "S07": "logo"}'),
};

function edgeOpts(a: { logoPattern?: string; edgeTypes?: Record<string, string> }): EdgeOptions {
  if (a.logoPattern !== undefined) {
    try {
      new RegExp(a.logoPattern, 'iu');
    } catch (e) {
      throw new ToolError(`logoPattern ไม่ใช่ regex ที่ถูกต้อง / invalid logoPattern: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ...(a.logoPattern !== undefined ? { logoPattern: a.logoPattern } : {}), ...(a.edgeTypes ? { overrides: a.edgeTypes } : {}) };
}

const CLIP_FIELDS = ['src', 'in', 'dur', 'scale', 'marker', 'slot', 'speed', 'pushIn'] as const;

function clipDiff(from: Clip, to: Clip): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of CLIP_FIELDS) {
    if (JSON.stringify(from[k]) !== JSON.stringify(to[k])) out[k] = { from: from[k] ?? null, to: to[k] ?? null };
  }
  return out;
}

type PreviewCapable = { previewRange?: (p: Project, opts: PreviewRangeOptions) => Promise<PreviewRangeResult> };

const frames = z.number().int();

// ---------- tools ----------

export const EDIT_TOOLS: ToolDef[] = [
  tool({
    name: 'joins_report',
    description: 'รายงานทุกรอยต่อ: ชนิดขอบ (card/footage/logo), dissolve ปัจจุบัน, handle ที่มี (คิด speed แล้ว), และเทียบกับ join policy ถ้าโปรเจกต์มี (styleRules.joins จากบรีฟ) · Report every cut: edge types, dissolve, handles, policy match',
    input: { ...edgeArgs },
    handler: async (a, state) => {
      const p = requireProject(state);
      const r = joinReport(p, edgeOpts(a));
      const differs = r.cuts.filter((c) => c.match === 'differs').length;
      return {
        ok: true, ...r,
        ...(r.policy === 'styleRules.joins' && differs ? { hint: `${differs} รอยต่อไม่ตรง policy — ดูข้อเสนอด้วย joins_apply (dry run) / ${differs} cut(s) differ: joins_apply proposes` } : {}),
      };
    },
  }),

  tool({
    name: 'joins_apply',
    description: 'เสนอ/ใช้ความยาว dissolve ตาม join policy ของโปรเจกต์ (styleRules.joins) หรือกฎที่ผู้ใช้/บรีฟระบุใน rules; ไม่มี policy = ไม่เสนออะไร (บรีฟเป็นผู้ตัดสิน); ค่าเริ่มต้น dry run, apply: true เพื่อใช้ (สำรองไทม์ไลน์ใน history/ ก่อน) · Propose/apply dissolves from the project join policy',
    input: {
      ...edgeArgs,
      rules: z.array(z.object({ from: z.string(), to: z.string(), dissolve: frames.min(0) })).optional()
        .describe('rules stated by the brief/user for this run (edge types card/footage/logo/custom, "*" = any); default styleRules.joins. A rule also covers the reverse direction unless that direction has its own rule'),
      cuts: z.array(z.string()).optional().describe('limit to cuts after these clip ids'),
      apply: z.boolean().optional().describe('default false: only propose'),
    },
    mutating: true,
    writesProject: true,
    handler: async (a, state) => {
      const p = requireProject(state);
      const opts = { ...edgeOpts(a), ...(a.rules ? { rules: a.rules } : {}) };
      const { report, proposals: all } = proposeJoins(p, opts);
      if (report.policy === 'none') {
        return {
          ok: true, applied: false, policy: 'none', proposals: [], cuts: report.cuts, note: report.note,
          hint: 'ตั้ง styleRules.joins (rules_set_style) จากบรีฟ หรือส่ง rules ที่ผู้ใช้สั่ง / set styleRules.joins from the brief or pass the user\'s rules',
        };
      }
      const wanted = a.cuts ? new Set(a.cuts) : undefined;
      if (wanted) {
        const unknown = [...wanted].filter((id) => !report.cuts.some((c) => c.after === id));
        if (unknown.length) throw new ToolError(`ไม่พบรอยต่อหลังคลิป / no cut after: ${unknown.join(', ')}`, { unknown });
      }
      const proposals = all.filter((x) => !wanted || wanted.has(x.after));
      const feasible = proposals.filter((x) => x.feasible);
      const skipped = proposals.filter((x) => !x.feasible);
      const base = { policy: report.policy, rules: report.rules, proposals, skipped, note: report.note };
      if (!a.apply || !feasible.length) {
        return { ok: true, applied: false, ...base, ...(feasible.length ? { next: 'ตรวจแล้วเรียกซ้ำด้วย apply: true / call again with apply: true' } : {}) };
      }
      const backup = await backupTimeline(p, `before joins_apply (${report.policy})`);
      const prev = p.timeline;
      const next = structuredClone(prev);
      next.cuts = applyJoinProposals(next.cuts, feasible);
      state.api.project.setTimeline(p, next);
      const errors = state.api.project.validateTimeline(p);
      if (errors.length) {
        state.api.project.setTimeline(p, prev);
        throw new ToolError('ไทม์ไลน์หลังปรับรอยต่อไม่ผ่านการตรวจสอบ ไม่ได้บันทึก / timeline invalid after the join changes, not applied', { errors, backup, ...base });
      }
      await state.api.project.saveProject(p);
      return { ok: true, applied: true, backup, changed: feasible.length, ...base, hint: 'ย้อนกลับได้ด้วย timeline_restore; build เพื่อดูผล / undo with timeline_restore' };
    },
  }),

  tool({
    name: 'shot_revert',
    description: 'ย้อนช็อตเดียวกลับไปเป็นแบบในเวอร์ชันก่อน ("อันก่อนสวยกว่า"): คืนค่าคลิป (in/dur/scale/speed/pushIn...) และสำหรับ AE comp ชี้ render กลับไปไฟล์เดิม (ถ้ายังอยู่) ให้ build ใช้ segment cache เดิม; ใช้ทำตามคำขอ revert จากหน้ารีวิว (review_notes → revertRequests {version, clipId}); ค่าเริ่มต้น dry run, apply: true เพื่อใช้ (สำรองไทม์ไลน์ก่อน) · Revert one shot to its state in an earlier version',
    input: {
      clipId: z.string().min(1),
      version: z.string().min(1).describe('version to take the shot from, e.g. v003'),
      keepDuration: z.boolean().optional().describe('keep the current clip duration (timeline length unchanged); default false = restore the old duration too'),
      apply: z.boolean().optional().describe('default false: only show what would change'),
    },
    mutating: true,
    writesProject: true,
    handler: async (a, state) => {
      const p = requireProject(state);
      const v = findVersion(p, a.version);
      const warnings: string[] = [];
      const index = p.timeline.video.findIndex((c) => c.id === a.clipId);
      const cur = index >= 0 ? p.timeline.video[index] : undefined;
      const snap = v.clipSnapshots?.[a.clipId];
      let restored: Clip;
      if (snap) {
        restored = structuredClone(snap.clip);
      } else {
        const shot = v.reviewPlan?.shots.find((s) => s.id === a.clipId);
        if (!shot) throw new ToolError(`${v.id} ไม่มีช็อต ${a.clipId} / ${v.id} has no shot '${a.clipId}'`, { shots: Object.keys(v.clipSnapshots ?? {}).length ? Object.keys(v.clipSnapshots ?? {}) : v.reviewPlan?.shots.map((s) => s.id) ?? [] });
        restored = { ...(cur ?? {}), id: shot.id, src: shot.src, in: shot.in, dur: shot.dur, ...(shot.marker ? { marker: shot.marker } : {}) };
        warnings.push(`${v.id} ถูก build ก่อนมี snapshot รายช็อต: คืนได้แค่ src/in/dur/marker (scale/speed/pushIn ใช้ของปัจจุบัน) / ${v.id} predates per-shot snapshots: only src/in/dur/marker restored`);
      }
      if (!cur) {
        throw new ToolError(`คลิป ${a.clipId} ไม่อยู่ในไทม์ไลน์ปัจจุบัน — ใส่กลับด้วย timeline_edit insert / clip not in the current timeline: insert it with timeline_edit`, { snapshot: restored });
      }
      if (a.keepDuration && restored.dur !== cur.dur) {
        warnings.push(`คงความยาวปัจจุบัน ${cur.dur} เฟรม (ใน ${v.id} ยาว ${restored.dur}) / kept the current duration`);
        restored.dur = cur.dur;
      }
      const asset = p.assets[restored.src];
      if (!asset) throw new ToolError(`ไม่พบ asset ${restored.src} ของช็อตนี้ในโปรเจกต์แล้ว / asset '${restored.src}' no longer exists`);
      let render: Record<string, unknown> | undefined;
      let repoint = false;
      if (asset.kind === 'aecomp') {
        const old = snap?.render;
        if (!old) render = { action: 'none', reason: 'no render recorded for this shot' };
        else if (asset.render?.path === old.path && asset.render.renderedAt === old.renderedAt) render = { action: 'unchanged', path: old.path };
        else if (!existsSync(old.path)) {
          render = { action: 'missing', path: old.path };
          warnings.push(`ไฟล์ render ของ ${v.id} ไม่อยู่แล้ว (${old.path}) — build จะ render comp สถานะปัจจุบัน / the old render is gone: the build renders the comp as it is now`);
        } else {
          repoint = true;
          render = { action: 'repoint', from: asset.render?.path ?? null, to: old.path, fingerprint: old.fingerprint, renderedAt: old.renderedAt };
          warnings.push('ไฟล์ .aep ไม่ถูกย้อน: ถ้าแก้ comp นี้อีก build จะ render จากสถานะปัจจุบันของ comp / the .aep is not reverted: the next edit of this comp renders from its current state');
          const others = p.timeline.video.filter((c) => c.src === asset.id && c.id !== a.clipId).map((c) => c.id);
          if (others.length) warnings.push(`คลิปอื่นที่ใช้ comp เดียวกันจะได้ render เก่าด้วย: ${others.join(', ')} / other clips share this comp and get the old render too`);
        }
      }
      const diff = clipDiff(cur, restored);
      if (cur.dur !== restored.dur) warnings.push(`ความยาวเรื่องเปลี่ยน ${restored.dur - cur.dur > 0 ? '+' : ''}${restored.dur - cur.dur} เฟรม — ใช้ keepDuration: true ถ้าต้องคงความยาว / timeline length changes by ${restored.dur - cur.dur} frames`);
      const base = { clipId: a.clipId, version: v.id, current: cur, restored, diff, render, warnings };
      if (!a.apply) {
        return {
          ok: true, applied: false, ...base,
          ...(Object.keys(diff).length || repoint ? { next: 'ตรวจแล้วเรียกซ้ำด้วย apply: true / call again with apply: true' } : { note: 'ช็อตนี้เหมือนใน ' + v.id + ' อยู่แล้ว / already identical' }),
        };
      }
      if (!Object.keys(diff).length && !repoint) return { ok: true, applied: false, ...base, note: `ช็อตนี้เหมือนใน ${v.id} อยู่แล้ว / already identical` };
      const comp = asset.kind === 'aecomp' ? (asset as PinnableComp) : undefined;
      const oldProbe = repoint && snap?.render ? await state.api.probe(snap.render.path) : undefined; // before any change
      const backup = await backupTimeline(p, `before shot_revert ${a.clipId} -> ${v.id}`);
      const prevTimeline = p.timeline;
      const prevComp = comp ? structuredClone(comp) : undefined;
      const next = structuredClone(prevTimeline);
      next.video[index] = restored;
      if (comp && repoint && snap?.render) {
        comp.revertPin = { ...(comp.fingerprint !== undefined ? { compFingerprint: comp.fingerprint } : {}), version: v.id, clipId: a.clipId, at: new Date().toISOString() };
        comp.render = structuredClone(snap.render);
        comp.fingerprint = snap.render.fingerprint;
        if (oldProbe) comp.probe = oldProbe;
      }
      state.api.project.setTimeline(p, next);
      const errors = state.api.project.validateTimeline(p);
      if (errors.length) {
        state.api.project.setTimeline(p, prevTimeline);
        if (comp && prevComp) p.assets[comp.id] = prevComp;
        throw new ToolError('ไทม์ไลน์หลังย้อนช็อตไม่ผ่านการตรวจสอบ ไม่ได้บันทึก / timeline invalid after the revert, not applied', { errors, backup, ...base });
      }
      await state.api.project.saveProject(p);
      return {
        ok: true, applied: true, backup, ...base,
        hint: 'build เพื่อได้เวอร์ชันใหม่ (segment ที่ตรงกับ ' + v.id + ' ใช้ cache เดิม); ย้อนการย้อนด้วย timeline_restore / build next; undo with timeline_restore',
      };
    },
  }),

  tool({
    name: 'preview_range',
    description: 'พรีวิว H.264 ความละเอียดต่ำของช่วงเฟรม [from, to) อย่างเร็ว: จากไทม์ไลน์ปัจจุบัน (encode เฉพาะท่อนที่ต้องใช้ ลง segment cache ให้ build ใช้ต่อ) หรือตัดจาก master ของเวอร์ชัน; ไฟล์ไปที่ <project>/review/previews/ ไม่ทับไฟล์เดิม (job) · Quick low-res preview of a timeline range',
    input: {
      from: frames.min(0).describe('first timeline frame'),
      to: frames.min(1).describe('end frame (exclusive)'),
      version: z.string().optional().describe('trim this version\'s master instead of assembling the current timeline'),
      current: z.boolean().optional().describe('true (default when no version): preview the current timeline'),
      scale: z.number().min(0.1).max(1).optional().describe('picture scale, default 0.5'),
      wait: z.boolean().optional().describe('default true: wait up to ~20 s for the result'),
    },
    writesProject: true,
    handler: async (a, state) => {
      const p = requireProject(state);
      requireFfmpeg(state);
      if (a.version && a.current) throw new ToolError('เลือกอย่างใดอย่างหนึ่ง: version หรือ current / pass either version or current, not both');
      if (!(a.to > a.from)) throw new ToolError(`ช่วงไม่ถูกต้อง / bad range: to (${a.to}) must be > from (${a.from})`);
      if (a.version) {
        const v = findVersion(p, a.version);
        if (!existsSync(v.master)) throw new ToolError(`ไม่พบ master ของ ${v.id} / master missing: ${v.master}`);
      } else {
        const errors = state.api.project.validateTimeline(p);
        if (errors.length) throw new ToolError('timeline ไม่ผ่านการตรวจสอบ / timeline invalid', { errors });
      }
      const asm = state.assembler as typeof state.assembler & PreviewCapable;
      if (typeof asm.previewRange !== 'function') throw new ToolError('assembler นี้ทำ preview_range ไม่ได้ / this assembler cannot preview ranges');
      const running = activeJob(state);
      if (running) throw new ToolError(`มี ${running.name} กำลังทำงานอยู่ / a ${running.name} job is already running`, { jobId: running.id });
      const fps = p.meta.fps;
      // runs as a 'preview' job: project edits and builds wait for it (it may render comps and fill the cache)
      return runJob(state, 'preview', a.wait, async (ctx) => {
        const r = await asm.previewRange!(p, {
          from: a.from, to: a.to, ...(a.version ? { version: a.version } : {}), ...(a.scale !== undefined ? { scale: a.scale } : {}), signal: ctx.signal,
          onProgress: (pr) => { ctx.progress(pr); ctx.log(`${pr.stage} ${pr.done}/${pr.total}${pr.message ? ' ' + pr.message : ''}`); },
        });
        return { ok: true, ...r, fromTc: framesToTc(r.from, fps), toTc: framesToTc(r.to, fps) } as Record<string, unknown>;
      });
    },
  }),
];
