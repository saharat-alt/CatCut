/**
 * Edit tools end to end through callTool: shot_revert (clip + AE render re-point, segment cache reuse),
 * joins_report / joins_apply, preview_range. AE is a mock that writes ProRes with ffmpeg.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import * as projectApi from '../../src/core/project.js';
import { JobManager } from '../../src/core/jobs.js';
import { getEnvironment } from '../../src/core/tools.js';
import type { AeBackend, AeCompAsset, Project } from '../../src/core/types.js';
import { Assembler, probe } from '../../src/engine/ffmpeg.js';
import type { AppState } from '../../src/mcp/state.js';
import { callTool, toolResultData } from '../../src/mcp/tools.js';

const env = await getEnvironment();
const W = 128;
const H = 72;
let dir: string;
let fingerprint = 'comp-one';
let renders = 0;

async function ff(args: string[]): Promise<void> {
  await execa(env.tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { windowsHide: true, timeout: 120_000 });
}

const ae: AeBackend = {
  kind: 'mock',
  fingerprint: async () => ({ Title: fingerprint }),
  render: async (req) => {
    renders++;
    const colour = fingerprint === 'comp-one' ? 'blue' : fingerprint === 'comp-two' ? 'green' : 'red';
    await ff(['-f', 'lavfi', '-i', `color=${colour}:size=${W}x${H}:rate=25`, '-t', '4', '-an', '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', req.outPath]);
    return { path: req.outPath, frames: 100, elapsedMs: 0, usedFallback: false, log: 'mock' };
  },
  listComps: async () => [], inspectComp: async () => { throw new Error('unused'); }, edit: async () => { throw new Error('unused'); },
  previewFrame: async () => { throw new Error('unused'); }, version: async () => 'mock',
};

let state: AppState;
let p: Project;
const ok = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await callTool(state, name, args);
  const data = toolResultData(r);
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(data)}`);
  return data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const build = () => (state.assembler as Assembler).build(p, { skipQc: true, skipDeliver: true });

beforeAll(async () => {
  dir = await mkdtemp(join(os.tmpdir(), 'editmcp-edit-'));
  const cam = join(dir, 'กล้อง.mkv');
  await ff(['-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=25:d=4`, '-c:v', 'ffv1', cam]);
  const assembler = new Assembler({ tools: env.tools, env: { ...env, encoders: { ...env.encoders, h264_nvenc: false } }, ae, concurrency: 1 });
  state = {
    env, ae, assembler, jobs: new JobManager(), problems: [],
    api: {
      project: projectApi,
      xmeml: { writeXmeml: () => '', readXmeml: () => { throw new Error('unused'); } },
      probe: (f) => probe(env.tools, f, { fps: 25 }),
    },
  };
  p = await projectApi.createProject(join(dir, 'โปรเจกต์'), { name: 'edit', width: W, height: H });
  await projectApi.addFileAsset(p, cam, { id: 'cam', probe: (f) => probe(env.tools, f, { fps: 25 }) });
  projectApi.addAeComp(p, join(dir, 'template.aep'), 'Title', 'title');
  p.timeline.video = [
    { id: 'a', src: 'cam', in: 10, dur: 20 },
    { id: 't', src: 'title', in: 5, dur: 20 },
  ];
  p.timeline.cuts = [{ after: 'a', dissolve: 4 }];
  p.timeline.audio.useClipAudio = false;
  state.project = p;
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe('shot_revert', () => {
  it('restores a clip and an older AE render; the next build reuses the old segments without rendering', async () => {
    const v1 = await build();
    expect(v1.stats).toMatchObject({ compsRendered: 1, segmentsRendered: 2, dissolvesRendered: 1 });
    const v1Render = (p.assets['title'] as AeCompAsset).render!;
    expect(v1.version.clipSnapshots?.['t']).toMatchObject({ clip: { id: 't', in: 5 }, render: v1Render, fingerprint: 'comp-one' });

    // edit both shots: retime + push-in the camera clip, change the comp
    p.timeline.video[0] = { id: 'a', src: 'cam', in: 30, dur: 20, speed: { rate: 0.5 }, pushIn: 10 };
    fingerprint = 'comp-two';
    const v2 = await build();
    expect(v2.stats).toMatchObject({ compsRendered: 1, segmentsRendered: 2 });
    expect((p.assets['title'] as AeCompAsset).render!.path).not.toBe(v1Render.path);

    const dry = await ok('shot_revert', { clipId: 't', version: 'v001' });
    expect(dry).toMatchObject({ applied: false, render: { action: 'repoint', to: v1Render.path } });
    expect((p.assets['title'] as AeCompAsset).render!.path).not.toBe(v1Render.path); // dry run changed nothing

    const applied = await ok('shot_revert', { clipId: 't', version: 'v001', apply: true });
    expect(applied.applied).toBe(true);
    expect(existsSync(applied.backup)).toBe(true);
    const comp = p.assets['title'] as AeCompAsset & { revertPin?: { version: string; compFingerprint?: string } };
    expect(comp.render).toEqual(v1Render);
    expect(comp.fingerprint).toBe('comp-one');
    expect(comp.revertPin).toMatchObject({ version: 'v001', compFingerprint: 'comp-two' });

    const a = await ok('shot_revert', { clipId: 'a', version: 'v001', apply: true });
    expect(a.diff).toMatchObject({ in: { from: 30, to: 10 }, speed: { to: null }, pushIn: { from: 10, to: null } });
    expect(p.timeline.video[0]).toEqual({ id: 'a', src: 'cam', in: 10, dur: 20 });

    renders = 0;
    const v3 = await build();
    expect(renders).toBe(0); // the live comp is still 'comp-two', but the reverted render is kept
    expect(v3.stats).toMatchObject({ compsRendered: 0, compsReused: 1, segmentsRendered: 0, segmentsReused: 2, dissolvesRendered: 0 });
    expect(v3.version.planHash).toBe(v1.version.planHash);

    // the reverted state survives a reload, and the first edit of the comp after the revert renders again
    const reloaded = await projectApi.loadProject(p.dir);
    expect((reloaded.assets['title'] as typeof comp).revertPin?.version).toBe('v001');
    fingerprint = 'comp-three';
    const v4 = await build();
    expect(v4.stats.compsRendered).toBe(1);
    expect((p.assets['title'] as typeof comp).revertPin).toBeUndefined();
  }, 180_000);

  it('refuses unknown versions/shots, reports identical shots, and keepDuration keeps the timeline length', async () => {
    expect((await callTool(state, 'shot_revert', { clipId: 't', version: 'v099' })).isError).toBe(true);
    expect((await callTool(state, 'shot_revert', { clipId: 'nope', version: 'v001' })).isError).toBe(true);
    const same = await ok('shot_revert', { clipId: 'a', version: 'v003' });
    expect(same.note).toMatch(/identical/);
    p.timeline.video[0] = { id: 'a', src: 'cam', in: 10, dur: 30 };
    const kept = await ok('shot_revert', { clipId: 'a', version: 'v003', keepDuration: true });
    expect(kept.restored.dur).toBe(30);
    const full = await ok('shot_revert', { clipId: 'a', version: 'v003' });
    expect(full.warnings.join(' ')).toMatch(/-10/);
    p.timeline.video[0] = { id: 'a', src: 'cam', in: 10, dur: 20 };
  });
});

describe('joins tools', () => {
  it('report without a policy proposes nothing; with styleRules.joins apply backs up and changes the dissolve', async () => {
    const r = await ok('joins_report');
    expect(r.policy).toBe('none');
    expect(r.cuts).toHaveLength(1);
    expect(r.cuts[0]).toMatchObject({ after: 'a', from: 'footage', to: 'card', dissolve: 4, match: 'no-policy' });
    const none = await ok('joins_apply', { apply: true });
    expect(none).toMatchObject({ applied: false, policy: 'none', proposals: [] });

    p.styleRules = { joins: [{ from: 'card', to: 'footage', dissolve: 8 }] };
    const dry = await ok('joins_apply');
    expect(dry.proposals).toEqual([expect.objectContaining({ after: 'a', current: 4, proposed: 8, feasible: true })]);
    expect(p.timeline.cuts).toEqual([{ after: 'a', dissolve: 4 }]);
    const applied = await ok('joins_apply', { apply: true });
    expect(applied).toMatchObject({ applied: true, changed: 1 });
    expect(p.timeline.cuts).toEqual([{ after: 'a', dissolve: 8 }]);
    const backups = await ok('timeline_restore');
    expect(backups.backups.map((b: { reason: string }) => b.reason)).toContain('before joins_apply (styleRules.joins)');
    await ok('timeline_restore', { backup: backups.backups[backups.backups.length - 1].name });
    expect(p.timeline.cuts).toEqual([{ after: 'a', dissolve: 4 }]);
    delete p.styleRules;
  });
});

describe('preview_range', () => {
  it('previews a range of the current timeline and of a version master into review/previews', async () => {
    const cur = await ok('preview_range', { from: 10, to: 30 });
    expect(cur).toMatchObject({ frames: 20, source: 'timeline', fromTc: '00:00:00:10' });
    expect(cur.path).toContain(join('review', 'previews'));
    expect((await probe(env.tools, cur.path, { fps: 25 })).durationFrames).toBe(20);
    const ver = await ok('preview_range', { from: 0, to: 15, version: 'v001', scale: 0.25 });
    expect(ver).toMatchObject({ frames: 15, source: 'version', version: 'v001' });
    expect((await probe(env.tools, ver.path, { fps: 25 })).height).toBe(18);
    expect((await callTool(state, 'preview_range', { from: 0, to: 10, version: 'v001', current: true })).isError).toBe(true);
  }, 120_000);
});
