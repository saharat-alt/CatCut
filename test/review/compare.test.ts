import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureReviewPlan, createProject, projectPaths } from '../../src/core/project.js';
import { discoverTools } from '../../src/core/tools.js';
import type { Project, ReviewPlan, ToolPaths, Version } from '../../src/core/types.js';
import { REVIEW2_TOOLS } from '../../src/mcp/tools-review2.js';
import type { AppState } from '../../src/mcp/state.js';
import { comparePairs, mapFrame, mapFrames } from '../../src/review/compare.js';

const plan = (frames: number, shots: ReviewPlan['shots']): ReviewPlan => ({ fps: 25, width: 320, height: 180, frames, shots });

describe('frame mapping between versions', () => {
  const a = plan(75, [{ id: 's1', src: 'cam', start: 0, in: 10, dur: 50 }, { id: 's2', src: 'card', start: 50, in: 0, dur: 25 }]);
  it('maps by timecode when both versions have the same length', () => {
    const m = mapFrames(a, plan(75, [{ id: 'x', src: 'y', start: 0, in: 0, dur: 75 }]));
    expect(m).toMatchObject({ method: 'timecode' });
    expect(m.warning).toBeUndefined();
    expect(mapFrame(m, 42)).toBe(42);
  });
  it('maps by shot id when lengths differ: same source keeps the source frame, other sources align shot starts, missing shots fall back with a warning', () => {
    // v2: s1 trimmed at the head by 5 source frames (in 15, dur 40), s3 inserted first, s2 swapped to another card.
    const b = plan(85, [{ id: 's3', src: 'logo', start: 0, in: 0, dur: 20 }, { id: 's1', src: 'cam', start: 20, in: 15, dur: 40 }, { id: 's2', src: 'card2', start: 60, in: 0, dur: 25 }]);
    const m = mapFrames(a, b, { from: 'v001', to: 'v002' });
    expect(m.method).toBe('shot');
    expect(m.warning).toContain('v001 75 f');
    expect(mapFrame(m, 10)).toBe(25); // source frame 20 → b.start 20 + (20 - 15)
    expect(mapFrame(m, 0)).toBe(20); // source frame 10 was trimmed away → clamped to the shot head
    expect(mapFrame(m, 49)).toBe(59); // past the new tail → clamped inside s1
    expect(mapFrame(m, 55)).toBe(65); // other source: aligned to shot start
    const missing = mapFrames(a, plan(60, [{ id: 's1', src: 'cam', start: 0, in: 10, dur: 60 }]));
    expect(missing.warning).toContain('s2');
    expect(mapFrame(missing, 70)).toBe(59); // timecode, clamped to the end of B
  });
  it('picks pairs from clip ids, explicit frames, or every shot and rejects bad input', () => {
    const b = plan(80, [{ id: 's1', src: 'cam', start: 0, in: 10, dur: 55 }, { id: 's2', src: 'card', start: 55, in: 0, dur: 25 }]);
    expect(comparePairs(a, b).pairs).toEqual([{ clipId: 's1', a: 25, b: 25 }, { clipId: 's2', a: 62, b: 67 }]);
    expect(comparePairs(a, b, { clipIds: ['s2'] }).pairs).toEqual([{ clipId: 's2', a: 62, b: 67 }]);
    expect(comparePairs(a, b, { frames: [3] }).pairs).toEqual([{ clipId: 's1', a: 3, b: 3 }]);
    expect(() => comparePairs(a, b, { frames: [75] })).toThrow(/outside/);
    expect(() => comparePairs(a, b, { clipIds: ['nope'] })).toThrow(/not in version A/);
    expect(() => comparePairs(a, b, { frames: Array.from({ length: 25 }, (_, i) => i) })).toThrow(/At most/);
  });
});

describe('review_compare_sheet', () => {
  let tools: ToolPaths, dir: string, p: Project;
  const sheet = REVIEW2_TOOLS.find(t => t.name === 'review_compare_sheet')!;
  const call = (args: unknown) => (sheet.handler as (a: unknown, s: AppState) => Promise<unknown>)(args, { project: p, env: { tools }, api: { project: { projectPaths } } } as unknown as AppState);
  beforeAll(async () => {
    tools = discoverTools();
    dir = await mkdtemp(join(os.tmpdir(), 'editmcp-compare-'));
    p = await createProject(join(dir, 'งาน ทดสอบ'), { name: 'compare', fps: 25, width: 320, height: 180 });
    const master = (name: string, frames: number, src: string) => {
      const out = join(p.dir, 'out', name);
      execFileSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'lavfi', '-i', `${src}=size=320x180:rate=25`, '-frames:v', String(frames), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10', out]);
      return out;
    };
    const stats = { segmentsTotal: 1, segmentsRendered: 1, segmentsReused: 0, dissolvesRendered: 0, compsRendered: 0, compsReused: 0, timingsMs: {} };
    p.timeline.video = [{ id: 's1', src: 'cam', in: 0, dur: 30 }, { id: 's2', src: 'card', in: 0, dur: 20 }];
    const v1: Version = { id: 'v001', createdAt: '', planHash: 'a', master: master('ก่อน.mp4', 50, 'testsrc'), reviewPlan: captureReviewPlan(p), deliverables: {}, stats };
    p.timeline.video = [{ id: 's1', src: 'cam', in: 0, dur: 40 }, { id: 's2', src: 'card', in: 0, dur: 20 }];
    const v2: Version = { id: 'v002', createdAt: '', planHash: 'b', master: join(p.dir, 'missing.mov'), reviewProxy: master('หลัง.mp4', 60, 'testsrc2'), reviewPlan: captureReviewPlan(p), deliverables: {}, stats };
    p.versions.push(v1, v2);
  }, 30_000);
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it('renders labelled before/after pairs into review/compare without overwriting', async () => {
    const first = await call({ versionA: 'v001', versionB: 'v002' }) as { path: string; sidecar: string; method: string; warning: string; pairs: unknown[] };
    expect(first.path).toBe(join(p.dir, 'review', 'compare', 'v001_vs_v002.png'));
    expect(first.method).toBe('shot');
    expect(first.warning).toContain('ความยาวไม่เท่ากัน');
    expect(first.pairs).toEqual([
      { clipId: 's1', a: { version: 'v001', frame: 15, tc: '00:00:00:15' }, b: { version: 'v002', frame: 15, tc: '00:00:00:15' } },
      { clipId: 's2', a: { version: 'v001', frame: 40, tc: '00:00:01:15' }, b: { version: 'v002', frame: 50, tc: '00:00:02:00' } },
    ]);
    const size = execFileSync(tools.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', first.path], { encoding: 'utf8' }).trim();
    expect(size).toBe(`${2 * 484},${2 * 274}`);
    expect(JSON.parse(await readFile(first.sidecar, 'utf8'))).toMatchObject({ versionA: 'v001', versionB: 'v002', pairs: first.pairs });
    const second = await call({ versionA: 'v001', versionB: 'v002', frames: [3] }) as { path: string };
    expect(second.path).toBe(join(p.dir, 'review', 'compare', 'v001_vs_v002_2.png'));
    expect(existsSync(first.path)).toBe(true);
  }, 60_000);

  it('refuses unknown versions, the same version twice, and mixed selectors', async () => {
    await expect(call({ versionA: 'v001', versionB: 'v009' })).rejects.toThrow(/unknown version/);
    await expect(call({ versionA: 'v001', versionB: 'v001' })).rejects.toThrow(/different/);
    await expect(call({ versionA: 'v001', versionB: 'v002', clipIds: ['s1'], frames: [1] })).rejects.toThrow(/not both/);
    await expect(call({ versionA: 'v001', versionB: 'v002', clipIds: ['zzz'] })).rejects.toThrow(/not in version A/);
  });
});
