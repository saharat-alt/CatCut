import { mkdir, mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { captureReviewPlan, createProject } from '../../src/core/project.js';
import { openReview } from '../../src/review/server.js';
import { readReviewSession, submitReview } from '../../src/review/session.js';
import type { Version } from '../../src/core/types.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const dir = await mkdtemp(join(os.tmpdir(), 'editmcp-review-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const p = await createProject(dir, { name: 'รีวิว <script>', fps: 25, width: 320, height: 180 });
  p.assets.title = { id: 'title', kind: 'aecomp', aep: join(dir, 'title.aep'), comp: 'ข้อความไทย' };
  p.timeline.video = [{ id: 's1', src: 'title', in: 10, dur: 50, marker: 'เปิดเรื่อง' }, { id: 's2', src: 'camera', in: 0, dur: 25 }];
  const proxy = join(dir, 'ไทย.mp4');
  await writeFile(proxy, '0123456789');
  const v: Version = { id: 'v001', createdAt: new Date().toISOString(), planHash: 'old-plan', master: join(dir, 'master.mov'), reviewProxy: proxy, reviewPlan: captureReviewPlan(p), deliverables: {}, stats: { segmentsTotal: 2, segmentsRendered: 2, segmentsReused: 0, dissolvesRendered: 0, compsRendered: 1, compsReused: 0, timingsMs: {} } };
  p.versions.push(v);
  const server = await openReview(p, v);
  cleanup.push(() => server.close());
  return { p, v, server, url: server.url, dir };
}
const note = { id: 'n1', frame: 20, in: 10, out: 30, intent: 'text', text: 'แก้ <ชื่อ> "ธนาคาร"', strokes: [{ points: [[0.1, 0.2], [0.8, 0.7]] }] };

describe('local review', () => {
  it('keeps version shot identity and streams only its selected proxy with valid byte ranges', async () => {
    const { p, server, url } = await fixture();
    p.timeline.video.reverse();
    const data = await fetch(url + 'data').then(r => r.json());
    expect(data.plan.shots[0]).toMatchObject({ id: 's1', start: 0, in: 10, comp: 'ข้อความไทย' });
    expect(data.plan.frames).toBe(75);
    const res = await fetch(url + 'media', { headers: { Range: 'bytes=2-5' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await res.text()).toBe('2345');
    expect((await fetch(url + 'media', { headers: { Range: 'bytes=-3' } })).status).toBe(206);
    expect((await fetch(url + 'media', { headers: { Range: 'bytes=10-' } })).status).toBe(416);
    expect((await fetch(new URL('/data', url))).status).toBe(404);
    expect((await fetch(url + 'unknown-file')).status).toBe(404);
    const badHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(url, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    expect(badHost).toBe(403);
    expect(server.url).toContain('127.0.0.1:');
  });
  it('autosaves normalized notes, rejects stale revisions, and preserves each submission', async () => {
    const { p, v, url, dir } = await fixture();
    const save = (body: unknown) => fetch(url + 'session', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: new URL(url).origin }, body: JSON.stringify(body) });
    const res = await save({ revision: 0, notes: [note] });
    expect(res.status).toBe(200);
    const saved = await res.json();
    expect(saved.revision).toBe(1);
    expect(saved.notes[0]).toMatchObject({ shot: 's1', asset: 'title', comp: 'ข้อความไทย', sourceFrame: 30 });
    expect((await save({ revision: 0, notes: [] })).status).toBe(409);
    expect((await readReviewSession(p, v)).notes[0]?.text).toBe(note.text);
    const first = await submitReview(p, v, 1);
    expect(first.session.status).toBe('submitted');
    expect(JSON.parse(await readFile(first.path, 'utf8')).notes[0].text).toBe(note.text);
    const newer = await save({ revision: 2, notes: [{ ...note, text: 'เพิ่มคำแก้' }] });
    expect(newer.status).toBe(200);
    const second = await submitReview(p, v, 3);
    expect(second.path).not.toBe(first.path);
    expect(JSON.parse(await readFile(first.path, 'utf8')).notes[0].text).toBe(note.text);
    expect((await readdir(join(dir, 'review', 'v001'))).filter(f => f.startsWith('submitted-'))).toHaveLength(2);
  });
  it('rejects cross-origin writes, invalid frames/regions/claims, and oversized input without saving', async () => {
    const { url, p, v } = await fixture();
    const send = (body: unknown, origin = new URL(url).origin) => fetch(url + 'session', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
    expect((await send({ revision: 0, notes: [] }, 'https://evil.example')).status).toBe(403);
    for (const bad of [{ ...note, frame: 75 }, { ...note, in: 25 }, { ...note, out: 76 }, { ...note, shot: 'fake' }, { ...note, strokes: [{ points: [[-1, 0]] }] }, { ...note, text: 'x'.repeat(5001) }]) {
      expect((await send({ revision: 0, notes: [bad] })).status).toBe(400);
    }
    expect((await send({ revision: 0, notes: [note, note] })).status).toBe(400);
    expect((await send({ junk: 'x'.repeat(2 * 1024 * 1024) })).status).toBe(413);
    expect((await readReviewSession(p, v)).revision).toBe(0);
    const page = await fetch(url);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
  });
  it('refuses mismatched legacy versions and reopens saved sessions', async () => {
    const { p, v, server } = await fixture();
    await server.close();
    const reopened = await openReview(p, v);
    cleanup.push(() => reopened.close());
    expect(await fetch(reopened.url + 'data').then(r => r.json())).toMatchObject({ session: { revision: 0 } });
    delete v.reviewPlan;
    await expect(openReview(p, v)).rejects.toThrow(/rebuild/i);
  });
  it('reports a held or abandoned lock without changing notes or breaking the lock', async () => {
    const { p, v, dir, url } = await fixture();
    const lock = join(dir, 'review', 'v001', 'session.lock');
    await mkdir(join(dir, 'review', 'v001'), { recursive: true });
    await writeFile(lock, 'fixture-lock-owner');
    const response = await fetch(url + 'session', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: new URL(url).origin }, body: JSON.stringify({ revision: 0, notes: [note] }) });
    expect(response.status).toBe(423);
    expect((await response.json()).error).toContain('session.lock');
    expect(await readFile(lock, 'utf8')).toBe('fixture-lock-owner');
    expect((await readReviewSession(p, v)).revision).toBe(0);
  });
});
