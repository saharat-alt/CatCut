import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureReviewPlan, createProject } from '../../src/core/project.js';
import type { Version } from '../../src/core/types.js';
import { openReview } from '../../src/review/server.js';
import { NOTE_STATUSES, readReviewSession, saveReviewSession, submitReview } from '../../src/review/session.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const stats = { segmentsTotal: 1, segmentsRendered: 1, segmentsReused: 0, dissolvesRendered: 0, compsRendered: 0, compsReused: 0, timingsMs: {} };

async function fixture() {
  const dir = await mkdtemp(join(os.tmpdir(), 'editmcp-ab-'));
  const elsewhere = await mkdtemp(join(os.tmpdir(), 'editmcp-other-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }), () => rm(elsewhere, { recursive: true, force: true }));
  const p = await createProject(dir, { name: 'เทียบ', fps: 25, width: 320, height: 180 });
  const version = async (id: string, shots: Array<[string, string, number, number]>, proxy: string | undefined, fps = 25): Promise<Version> => {
    p.timeline.video = shots.map(([cid, src, inn, dur]) => ({ id: cid, src, in: inn, dur }));
    if (proxy) await writeFile(proxy, `proxy-${id}`);
    return { id, createdAt: id, planHash: `hash-${id}`, master: join(dir, `${id}.mov`), ...(proxy ? { reviewProxy: proxy } : {}), reviewPlan: { ...captureReviewPlan(p), fps }, deliverables: {}, stats };
  };
  const v1 = await version('v001', [['s1', 'cam', 10, 50], ['s2', 'card', 0, 25]], join(dir, 'ก่อน.mp4'));
  const v2 = await version('v002', [['s1', 'cam', 15, 45], ['s2', 'card', 0, 25], ['s3', 'end', 0, 10]], join(dir, 'หลัง.mp4'));
  const outside = await version('v003', [['s1', 'cam', 10, 50], ['s2', 'card', 0, 25]], join(elsewhere, 'stolen.mp4'));
  const noProxy = await version('v004', [['s1', 'cam', 10, 50]], undefined);
  const otherFps = await version('v005', [['s1', 'cam', 10, 50]], join(dir, 'fps.mp4'), 30);
  p.versions.push(v1, v2, outside, noProxy, otherFps);
  return { p, v1, v2, dir };
}
async function open(p: Awaited<ReturnType<typeof fixture>>['p'], v: Version) {
  const server = await openReview(p, v);
  cleanup.push(() => server.close());
  return server.url;
}
const rawGet = (url: string, path: string, host?: string) => new Promise<number | undefined>((resolve, reject) => {
  const u = new URL(url);
  const req = request({ host: u.hostname, port: u.port, path: u.pathname + path, headers: host ? { Host: host } : {} }, res => { res.resume(); resolve(res.statusCode); });
  req.on('error', reject); req.end();
});

describe('A/B compare routes', () => {
  it('lists only comparable versions of this project and serves their proxies read-only', async () => {
    const { p, v2 } = await fixture();
    const url = await open(p, v2);
    const data = await fetch(url + 'data').then(r => r.json());
    expect(data.compare).toEqual({ versions: [{ id: 'v001', createdAt: 'v001', frames: 75 }], previous: 'v001' });
    const media = await fetch(url + 'compare/v001/media', { headers: { Range: 'bytes=0-5' } });
    expect(media.status).toBe(206);
    expect(await media.text()).toBe('proxy-');
    expect(media.headers.get('content-security-policy')).toContain("default-src 'none'");
    for (const bad of ['v003', 'v004', 'v005', 'v002', 'v999', '%2E%2E%2F%2E%2E%2Fproject.json', 'v001%2F..%2F..']) {
      expect((await fetch(url + `compare/${bad}/media`)).status, bad).toBe(404);
      expect((await fetch(url + `compare/${bad}/data`)).status, bad).toBe(404);
    }
    expect(await rawGet(url, 'compare/../../project.json')).toBe(404);
    expect(await rawGet(url, 'compare/v001/media', 'evil.example')).toBe(403);
    expect((await fetch(url + 'compare/v001/media', { method: 'PUT', headers: { Origin: new URL(url).origin, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(405);
  });

  it('maps frames across versions of different length by shot id and warns', async () => {
    const { p, v2 } = await fixture();
    const url = await open(p, v2);
    const map = await fetch(url + 'compare/v001/data').then(r => r.json());
    expect(map).toMatchObject({ version: 'v001', frames: 75, method: 'shot' });
    expect(map.warning).toContain('v002 80 f');
    expect(map.shots.map((s: { id: string }) => s.id)).toEqual(['s1', 's2']);
    // v002 s1 starts at source 15; v001 s1 at source 10 → +5. v002 s3 does not exist in v001 → timecode, clamped.
    expect(map.segments).toEqual([
      { start: 0, dur: 45, toStart: 5, toMin: 0, toMax: 49 },
      { start: 45, dur: 25, toStart: 50, toMin: 50, toMax: 74 },
      { start: 70, dur: 10, toStart: 70, toMin: 0, toMax: 74 },
    ]);
  });

  it('shows the previous version notes on their mapped frames for ก่อน/หลัง', async () => {
    const { p, v1, v2 } = await fixture();
    await saveReviewSession(p, v1, { revision: 0, notes: [{ id: 'old', frame: 20, in: 10, out: 30, intent: 'cut', text: 'สั้นลง', strokes: [] }] });
    const url = await open(p, v2);
    const data = await fetch(url + 'data').then(r => r.json());
    expect(data.history).toMatchObject({ version: 'v001', notes: [{ id: 'old', frame: 15, sourceFrame: 20, text: 'สั้นลง', status: 'open' }] });
  });
});

describe('parked notes and version preferences', () => {
  const base = { frame: 20, in: 10, out: 30, strokes: [] };
  it('keeps parked notes, records revertTo requests, and splits the submitted payload', async () => {
    const { p, v2, dir } = await fixture();
    expect(NOTE_STATUSES).toContain('parked');
    const saved = await saveReviewSession(p, v2, { revision: 0, notes: [
      { ...base, id: 'a', intent: 'text', text: 'แก้ชื่อ' },
      { ...base, id: 'b', intent: 'color', text: 'ยังไม่ต้องแก้', status: 'parked' },
      { ...base, id: 'c', intent: 'audio', text: 'เสร็จแล้ว', status: 'resolved' },
      { ...base, id: 'd', intent: 'other', text: '', revertTo: { version: 'v001', clipId: 's1' } },
    ] });
    expect(saved.notes.map(n => n.status)).toEqual(['open', 'parked', 'resolved', 'open']);
    expect(saved.notes[3]).toMatchObject({ revertTo: { version: 'v001', clipId: 's1' }, shot: 's1' });
    const submitted = await submitReview(p, v2, 1);
    expect(submitted.actionable.map(n => n.id)).toEqual(['a', 'd']);
    expect(submitted.parked.map(n => n.id)).toEqual(['b']);
    expect(submitted.resolved.map(n => n.id)).toEqual(['c']);
    expect(submitted.revertRequests).toEqual([{ noteId: 'd', version: 'v001', clipId: 's1', frame: 20 }]);
    const file = JSON.parse(await readFile(submitted.path, 'utf8'));
    expect(file.rule).toMatch(/parked/);
    expect(file.parked.map((n: { id: string }) => n.id)).toEqual(['b']);
    expect(file.actionable.map((n: { id: string }) => n.id)).toEqual(['a', 'd']);
    expect(submitted.path.startsWith(join(dir, 'review', 'v002'))).toBe(true);
    expect((await readReviewSession(p, v2)).notes[1]?.status).toBe('parked');
  });
  it('rejects malformed version preferences', async () => {
    const { p, v2 } = await fixture();
    const save = async (revertTo: unknown, intent = 'other', frame = 20) => saveReviewSession(p, v2, { revision: 0, notes: [{ ...base, frame, in: frame - 5, out: frame + 5, id: 'r', intent, text: '', revertTo }] });
    await expect(save({ version: 'v001', clipId: 's1' }, 'text')).rejects.toThrow(/"other" intent/);
    await expect(save({ version: 'v002', clipId: 's1' })).rejects.toThrow(/another version/);
    await expect(save({ version: 'v009', clipId: 's1' })).rejects.toThrow(/Unknown version/);
    await expect(save({ version: 'v001', clipId: 's2' })).rejects.toThrow(/shot at its frame/);
    await expect(save({ version: 'v001', clipId: 's3' }, 'other', 75)).rejects.toThrow(/not in the preferred version/);
    await expect(save({ version: '../v001', clipId: 's1' })).rejects.toThrow(/Invalid/);
    await expect(save({ version: 'v001', clipId: 's1', extra: 1 })).rejects.toThrow(/Invalid/);
    expect((await readReviewSession(p, v2)).revision).toBe(0);
  });
});
