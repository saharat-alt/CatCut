/**
 * Rules, evidence and disk housekeeping tools (DESIGN §13.2 rows 4, 5, 8, 11; §13.2.1: the brief wins).
 */
import { z } from 'zod';
import { addConstraint, checkRules, ConstraintInputSchema, evidenceFrames, extractEvidence, listConstraints, removeConstraint, RuleConflictError, rulesForAgent, setStyleRules, StylePatchSchema, } from '../core/rules.js';
import { diskReport, gcApply, gcPlan, setVersionKeep } from '../engine/housekeeping.js';
import { requireFfmpeg, requireProject } from './state.js';
import { tool, ToolError } from './tooldef.js';
/** Turn a brief conflict into a structured "ask the user first" failure. */
function guard(fn) {
    try {
        return fn();
    }
    catch (e) {
        if (e instanceof RuleConflictError)
            throw new ToolError(e.message, { conflicts: e.conflicts, needsUserConfirmation: true });
        throw e;
    }
}
function planSummary(plan) {
    const byReason = {};
    for (const it of plan.items) {
        const r = (byReason[it.reason] ??= { files: 0, bytes: 0 });
        r.files++;
        r.bytes += it.bytes;
    }
    return {
        planId: plan.planId,
        createdAt: plan.createdAt,
        expiresAt: new Date(Date.parse(plan.createdAt) + 10 * 60_000).toISOString(),
        retainedVersions: plan.retainedVersions,
        totalBytes: plan.totalBytes,
        totalGb: +(plan.totalBytes / 1024 ** 3).toFixed(2),
        files: plan.items.length,
        byReason,
        versionsToRemove: [...new Set(plan.items.flatMap((i) => (i.version ? [i.version] : [])))],
        items: plan.items.slice(0, 60).map((i) => ({ rel: i.rel, bytes: i.bytes, reason: i.reason })),
        truncated: plan.items.length > 60,
        keptUnknown: plan.keptUnknown,
        next: 'แสดงรายการนี้ให้ผู้ใช้ดู ถ้าผู้ใช้อนุมัติ เรียก cache_gc_apply {planId, confirm:"ลบ"} ภายใน 10 นาที / show this to the user; only after they approve call cache_gc_apply within 10 minutes',
    };
}
export const RULES_TOOLS = [
    tool({
        name: 'rules_get',
        description: 'เช็กลิสต์กฎของโปรเจกต์ (อ่านก่อนแก้/บิลด์ทุกครั้ง) · Project rules checklist: re-read before every edit and build',
        input: {},
        handler: async (_a, state) => {
            const p = requireProject(state);
            const { text, items } = rulesForAgent(p);
            return { text, items, constraints: listConstraints(p), styleRules: p.styleRules ?? {} };
        },
    }),
    tool({
        name: 'rules_add_constraint',
        description: 'เพิ่มกฎจากบรีฟหรือคำสั่งผู้ใช้ (ต้องมี source + quote) · Add a constraint from the brief or the user, with a short quote. check: board-only | logo-static | no-repeat-gimmick (auto) | no-cover-photo | manual (visual)',
        input: {
            text: ConstraintInputSchema.shape.text.describe("the rule in the user's / brief's words"),
            source: ConstraintInputSchema.shape.source,
            quote: ConstraintInputSchema.shape.quote.describe('short quote of the brief / user message'),
            scope: ConstraintInputSchema.shape.scope.describe("'all' or comma-separated clip / asset / slot ids, comp name or effect match name"),
            check: ConstraintInputSchema.shape.check,
            id: ConstraintInputSchema.shape.id,
            max: ConstraintInputSchema.shape.max.describe('no-repeat-gimmick: max consecutive clips (default 1)'),
        },
        mutating: true,
        writesProject: true,
        handler: async (a, state) => {
            const p = requireProject(state);
            const r = addConstraint(p, a);
            await state.api.project.saveProject(p);
            return { ok: true, ...r };
        },
    }),
    tool({
        name: 'rules_remove_constraint',
        description: 'ลบกฎ (กฎจากบรีฟต้องถามผู้ใช้ก่อน แล้วส่ง userConfirmed) · Remove a constraint; brief rules need userConfirmed',
        input: { id: z.string().min(1), userConfirmed: z.boolean().optional() },
        mutating: true,
        writesProject: true,
        handler: async (a, state) => {
            const p = requireProject(state);
            const removed = guard(() => removeConstraint(p, a.id, { userConfirmed: a.userConfirmed }));
            await state.api.project.saveProject(p);
            return { ok: true, removed };
        },
    }),
    tool({
        name: 'rules_set_style',
        description: 'ตั้ง/รวม styleRules (radius, safe margin, palette, joins, thai, maxStaticSec; null = ลบ) · Merge StyleRules; user changes to brief values need overrideBrief after asking',
        input: {
            style: StylePatchSchema,
            source: z.enum(['brief', 'user']),
            quote: z.string().min(1).max(400),
            overrideBrief: z.boolean().optional().describe('true only after the user explicitly agreed to override the brief'),
        },
        mutating: true,
        writesProject: true,
        handler: async (a, state) => {
            const p = requireProject(state);
            const r = guard(() => setStyleRules(p, a.style, { source: a.source, quote: a.quote, overrideBrief: a.overrideBrief }));
            if (r.changed.length)
                await state.api.project.saveProject(p);
            return { ok: true, ...r };
        },
    }),
    tool({
        name: 'rules_check',
        description: 'ตรวจกฎที่ตรวจด้วยเครื่องได้ → issues (style) + เช็กลิสต์ที่ต้องดูด้วยตา · Machine-check constraints; returns issues, a visual checklist and skipped checks',
        input: {
            effects: z.record(z.array(z.string())).optional().describe('asset id -> effect/preset match names (from ae_inspect_comp), for no-repeat-gimmick'),
        },
        handler: async (a, state) => {
            const p = requireProject(state);
            const r = checkRules(p, a.effects ? { effects: a.effects } : {});
            return { ok: !r.issues.some((i) => i.severity === 'error'), ...r };
        },
    }),
    tool({
        name: 'rules_evidence',
        description: 'ดึงเฟรมหลักฐานของทุก instance ของ asset/comp (หรือคลิปที่ระบุ) จาก master ของเวอร์ชัน + contact sheet — ใช้ก่อนรายงานว่าแก้ครบ · One frame per instance from the version master, before claiming "fixed everywhere"',
        input: {
            assetId: z.string().optional(),
            clipIds: z.array(z.string()).optional(),
            version: z.string().optional().describe('default: latest'),
            offset: z.number().int().min(0).optional().describe('frame inside each instance (from clip start); default: middle, clear of dissolves'),
            offsets: z.array(z.number().int().min(0)).max(24).optional().describe('several frames per instance, e.g. each review note frame minus the clip start; overrides offset'),
            extract: z.boolean().default(true).describe('false: only list the frames'),
        },
        writesProject: true,
        handler: async (a, state) => {
            const p = requireProject(state);
            if (!a.assetId && !a.clipIds?.length)
                throw new ToolError('ต้องระบุ assetId หรือ clipIds / give assetId or clipIds');
            const plan = evidenceFrames(p, a.version, { ...(a.assetId ? { assetId: a.assetId } : {}), ...(a.clipIds ? { clipIds: a.clipIds } : {}), ...(a.offset !== undefined ? { offset: a.offset } : {}), ...(a.offsets?.length ? { offsets: a.offsets } : {}) });
            if (!a.extract || !plan.instances.length)
                return { ok: plan.instances.length > 0, ...plan };
            requireFfmpeg(state);
            const r = await extractEvidence(state.env.tools, p, plan);
            return {
                ok: r.frames.length === plan.instances.length,
                versionId: plan.versionId, from: plan.from, instances: new Set(plan.instances.map((x) => x.clipId)).size,
                ...r,
                note: 'แนบทุกเฟรมเมื่อรายงานผลการแก้ / attach every frame when reporting the fix',
            };
        },
    }),
    tool({
        name: 'disk_report',
        description: 'พื้นที่ว่างต่อไดรฟ์, ขนาด AE disk cache, ขนาด cache/ และ out/ ต่อเวอร์ชัน, และโฟลเดอร์อื่นในโปรเจกต์ (ไฟล์ที่ไม่ใช่ของ CatCut) พร้อมเตือนเมื่อเกินงบ · Free space, AE cache, project cache/out by version, other project folders, budget warning',
        input: { budgetGb: z.number().positive().optional().describe('warn when the project folder is larger (default 50)') },
        handler: async (a, state) => diskReport(requireProject(state), a.budgetGb ? { budgetGb: a.budgetGb } : {}),
    }),
    tool({
        name: 'cache_gc_plan',
        description: 'วางแผนล้างไฟล์ที่ไม่ใช้ (เวอร์ชันเก่า, segment/render ที่ถูกแทน, temp) — ยังไม่ลบ · Plan cleanup of superseded versions/segments/renders; deletes nothing',
        input: { keepLatest: z.number().int().min(1).max(100).default(3).describe('always keep this many newest versions (plus any marked keep)') },
        writesProject: true,
        handler: async (a, state) => planSummary(await gcPlan(requireProject(state), { keepLatest: a.keepLatest })),
    }),
    tool({
        name: 'cache_gc_apply',
        description: 'ลบตามแผน (หลังผู้ใช้อนุมัติเท่านั้น) confirm ต้องเป็น "ลบ" หรือ "delete"; แผนต้องอายุไม่เกิน 10 นาที · Apply a gc plan after explicit user approval',
        input: { planId: z.string().min(1), confirm: z.string().describe('"ลบ" or "delete", only after the user approved') },
        mutating: true,
        writesProject: true,
        handler: async (a, state) => {
            const p = requireProject(state);
            const r = await gcApply(p, a.planId, a.confirm);
            if (r.purgedVersions.length)
                await state.api.project.saveProject(p);
            return { ok: r.skipped.every((s) => s.reason === 'already gone'), ...r, freedGb: +(r.freedBytes / 1024 ** 3).toFixed(2) };
        },
    }),
    tool({
        name: 'version_keep',
        description: 'ทำเครื่องหมายเวอร์ชันว่าเก็บไว้ (cache_gc_plan จะไม่แตะ) · Mark a version keep so gc never removes it',
        input: { version: z.string().min(1), keep: z.boolean().default(true) },
        mutating: true,
        writesProject: true,
        handler: async (a, state) => {
            const p = requireProject(state);
            const v = setVersionKeep(p, a.version, a.keep);
            await state.api.project.saveProject(p);
            return { ok: true, version: v.id, keep: !!v.keep };
        },
    }),
];
//# sourceMappingURL=tools-rules.js.map