import { join } from 'node:path';
import { z } from 'zod';
import { comparePairs, renderCompareSheet, sheetMedia } from '../review/compare.js';
import { ReviewError, versionPlan } from '../review/session.js';
import type { Project, Version } from '../core/types.js';
import type { AppState } from './state.js';
import { tool, ToolError, type ToolDef } from './tooldef.js';

function version(p: Project, id: string): Version {
  const v = p.versions.find(x => x.id === id);
  if (!v) throw new ToolError(`ไม่พบเวอร์ชัน / unknown version: ${id}`);
  return v;
}

function project(state: AppState): Project {
  if (!state.project) throw new ToolError('ยังไม่ได้เปิดโปรเจกต์ / no project open');
  return state.project;
}

// Feature tools for 'review2' (parked notes, A/B compare). Registered via tools-extra.ts.
export const REVIEW2_TOOLS: ToolDef[] = [
  tool({
    name: 'review_compare_sheet',
    description: 'ภาพเทียบก่อน/หลัง (PNG) ของสองเวอร์ชัน: คู่เฟรม A|B พร้อมเวอร์ชันและไทม์โค้ด บันทึกใน review/compare/ ไม่ทับไฟล์เดิม · Before/after contact sheet of two versions',
    input: {
      versionA: z.string().regex(/^v\d+$/).describe('left column, e.g. the earlier version'),
      versionB: z.string().regex(/^v\d+$/).describe('right column'),
      clipIds: z.array(z.string().min(1)).max(24).optional().describe('shots of version A (middle frame of each); default: every shot'),
      frames: z.array(z.number().int().nonnegative()).max(24).optional().describe('frames of version A; mapped to B by timecode, or by shot id when lengths differ'),
    },
    writesProject: true,
    handler: async (a, state) => {
      const p = project(state);
      if (a.clipIds?.length && a.frames?.length) throw new ToolError('ใช้ clipIds หรือ frames อย่างใดอย่างหนึ่ง / pass clipIds or frames, not both');
      if (a.versionA === a.versionB) throw new ToolError('เลือกสองเวอร์ชันที่ต่างกัน / pick two different versions');
      if (!state.env.tools.ffmpeg) throw new ToolError('ไม่พบ ffmpeg / ffmpeg not found (run doctor)');
      const va = version(p, a.versionA), vb = version(p, a.versionB);
      try {
        const planA = versionPlan(p, va), planB = versionPlan(p, vb);
        if (planA.fps !== planB.fps) throw new ToolError(`fps ต่างกัน / fps differ (${planA.fps} vs ${planB.fps})`);
        const { pairs, map } = comparePairs(planA, planB, { ...(a.clipIds ? { clipIds: a.clipIds } : {}), ...(a.frames ? { frames: a.frames } : {}) });
        const outPath = join(state.api.project.projectPaths(p).review, 'compare', `${va.id}_vs_${vb.id}.png`);
        return await renderCompareSheet({
          tools: state.env.tools, map, pairs, outPath,
          a: { id: va.id, media: sheetMedia(va), plan: planA },
          b: { id: vb.id, media: sheetMedia(vb), plan: planB },
        });
      } catch (error) {
        if (error instanceof ReviewError) throw new ToolError(error.message);
        throw error;
      }
    },
  }),
];
