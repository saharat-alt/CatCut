/**
 * Premiere Pro handoff without computer use: CatCut ⇄ the CatCut bridge extension inside Premiere.
 * push = export_premiere_xml + import into the open Premiere project (new bin + sequence, never saved);
 * pull = Premiere exports a sequence as FCP7 XML + import_premiere_xml (dry run unless apply).
 */
import { constants } from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import { createPremiereClient, stagePath } from '../engine/premiere.js';
import { uniqueOutputPath } from '../engine/aerender.js';
import { requireProject } from './state.js';
import { tool, ToolError } from './tooldef.js';
function client(state) {
    state.premiere ??= createPremiereClient();
    return state.premiere;
}
const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
/** The open Premiere project must be the one the caller named (file name or full path). */
function assertProject(open, wanted) {
    if (!open)
        throw new ToolError('Premiere ไม่ได้เปิดโปรเจกต์ไว้ / no project is open in Premiere');
    const w = wanted.trim();
    const hit = /[\\/]/.test(w) ? same(open.path, w) : [open.name, basename(open.path)].some((n) => n.toLowerCase() === w.toLowerCase() || n.toLowerCase() === `${w.toLowerCase()}.prproj`);
    if (!hit)
        throw new ToolError(`โปรเจกต์ที่เปิดใน Premiere ไม่ตรงกับที่ระบุ / Premiere has a different project open`, { open, wanted: w });
    return open;
}
async function callCatCut(state, name, args) {
    const { callTool, toolResultData } = await import('./tools.js'); // tools.ts aggregates this module
    const r = await callTool(state, name, args);
    const data = toolResultData(r);
    if (r.isError)
        throw new ToolError(String(data['error'] ?? `${name} failed`), data);
    return data;
}
const slug = (s) => s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'sequence';
export const PREMIERE_TOOLS = [
    tool({
        name: 'premiere_status',
        description: 'สถานะ Premiere ผ่าน CatCut bridge (ไม่ใช้ computer use): ติดตั้งแล้วไหม เชื่อมอยู่ไหม โปรเจกต์ที่เปิด และ sequence · Premiere bridge status: installed, connected, open project, sequences',
        input: {},
        handler: async (_a, state) => {
            const c = client(state);
            const st = await c.status();
            if (!st.connected) {
                return {
                    ...st,
                    hint: st.installed
                        ? 'เปิด Premiere Pro แล้ว bridge จะเริ่มเอง (หรือ Window > Extensions > CatCut Bridge) / start Premiere: the bridge starts by itself'
                        : 'ติดตั้งครั้งเดียว: `catcut premiere-bridge install` แล้วรีสตาร์ต Premiere / install once, then restart Premiere',
                };
            }
            const live = await c.call('status', {}, { timeoutMs: 30_000 });
            return { ...st, ...live };
        },
    }),
    tool({
        name: 'premiere_push',
        description: 'ส่งไทม์ไลน์ CatCut เข้าโปรเจกต์ที่เปิดอยู่ใน Premiere เป็น sequence ใหม่ใน bin "CatCut" แล้วเปิดให้ (ไม่ save โปรเจกต์ Premiere) · Hand the CatCut timeline to the open Premiere project as a new sequence (no computer use; Premiere is not saved). '
            + '`project` must name the Premiere project that is open (see premiere_status) so a cut never lands in the wrong job.',
        input: {
            project: z.string().describe('the open Premiere project: file name (e.g. "JOB_EDIT.prproj") or full path'),
            version: z.string().optional().describe('CatCut version to hand off (default: latest)'),
            sequenceName: z.string().optional(),
            bin: z.string().optional().describe('Premiere bin for the import (default "CatCut")'),
            open: z.boolean().optional().describe('open the new sequence in the timeline (default true)'),
        },
        writesProject: true,
        handler: async (a, state) => {
            requireProject(state);
            const c = client(state);
            const st = await c.status();
            if (!st.connected)
                throw new ToolError('Premiere bridge ไม่ได้เชื่อม / bridge not connected: call premiere_status', { ...st });
            const target = assertProject(st.project, a.project);
            const exported = await callCatCut(state, 'export_premiere_xml', { version: a.version, sequenceName: a.sequenceName });
            const xml = String(exported['path']);
            const staged = await stagePath(c, '.xml');
            await copyFile(xml, staged, constants.COPYFILE_EXCL);
            try {
                const res = await c.call('importXml', { path: staged, bin: a.bin ?? 'CatCut', open: a.open !== false, expectProject: target.path }, { timeoutMs: 180_000 });
                return {
                    ok: true, xml, version: exported['version'], ...res,
                    ...(exported['warnings'] ? { warnings: exported['warnings'] } : {}), ...(exported['unrendered'] ? { unrendered: exported['unrendered'] } : {}),
                    hint: 'ตัดต่อใน Premiere ได้เลย เสร็จแล้วใช้ premiere_pull เพื่อดึงกลับ (Premiere ยังไม่ได้ save) / edit in Premiere, then premiere_pull',
                };
            }
            finally {
                await rm(staged, { force: true });
            }
        },
    }),
    tool({
        name: 'premiere_pull',
        description: 'ดึง sequence จาก Premiere กลับเข้า CatCut: Premiere export FCP XML (ไม่แก้โปรเจกต์ Premiere) → import_premiere_xml; ค่าเริ่มต้นแค่สรุปความต่าง, apply: true เพื่อใช้ · Pull a Premiere sequence back into CatCut (dry run by default)',
        input: {
            sequence: z.string().optional().describe('sequence name or id (default: the active sequence)'),
            apply: z.boolean().optional().describe('commit the imported timeline (default false = summary, diff and warnings only)'),
        },
        writesProject: true,
        mutating: true,
        handler: async (a, state) => {
            const p = requireProject(state);
            const c = client(state);
            const staged = await stagePath(c, '.xml');
            try {
                const res = await c.call('exportXml', { sequence: a.sequence, path: staged }, { timeoutMs: 180_000 });
                const dir = join(state.api.project.projectPaths(p).out, 'premiere');
                await mkdir(dir, { recursive: true });
                const xml = uniqueOutputPath(join(dir, `${slug(res.sequence.name)}.xml`));
                await copyFile(staged, xml, constants.COPYFILE_EXCL);
                const imported = await callCatCut(state, 'import_premiere_xml', { path: xml, apply: a.apply === true });
                return { ...imported, pulledFrom: { project: res.project, sequence: res.sequence }, xml };
            }
            finally {
                await rm(staged, { force: true });
            }
        },
    }),
];
//# sourceMappingURL=tools-premiere.js.map