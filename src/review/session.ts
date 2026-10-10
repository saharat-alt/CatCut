import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { captureReviewPlan, planHash, projectPaths } from '../core/project.js';
import type { Project, ReviewPlan, Version } from '../core/types.js';

const frame = z.number().int().nonnegative();
const coordinate = z.number().min(0).max(1);
const noteInput = z.object({
  id: z.string().min(1).max(80), frame, in: frame, out: frame,
  intent: z.enum(['cut', 'timing', 'text', 'color', 'audio']),
  text: z.string().trim().min(1).max(5000),
  strokes: z.array(z.object({ points: z.array(z.tuple([coordinate, coordinate])).min(2).max(512) }).strict()).max(16),
  status: z.enum(['open', 'resolved']).default('open'),
}).strict();
const saveInput = z.object({ revision: frame, notes: z.array(noteInput).max(100) }).strict();
const submitInput = z.object({ revision: frame }).strict();
const storedNote = noteInput.extend({ shot: z.string(), asset: z.string(), sourceFrame: frame, comp: z.string().optional() });
const sessionSchema = z.object({
  version: z.string(), planHash: z.string(), revision: frame, updatedAt: z.string(),
  status: z.enum(['draft', 'submitted']), notes: z.array(storedNote).max(100),
}).strict();
export type ReviewSession = z.infer<typeof sessionSchema>;

export class ReviewError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function versionPlan(p: Project, v: Version): ReviewPlan {
  if (v.reviewPlan) return v.reviewPlan;
  if (v.planHash !== planHash(p)) throw new ReviewError('This version has no shot snapshot. Rebuild before reviewing it.');
  return captureReviewPlan(p);
}

function sessionDir(p: Project, v: Version): string {
  if (!/^v\d+$/.test(v.id)) throw new ReviewError('Invalid version id');
  return join(projectPaths(p).review, v.id);
}

export async function readReviewSession(p: Project, v: Version): Promise<ReviewSession> {
  const file = join(sessionDir(p, v), 'session.json');
  try {
    const s = sessionSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    if (s.version !== v.id || s.planHash !== v.planHash) throw new ReviewError('Review belongs to a different build', 409);
    return s;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { version: v.id, planHash: v.planHash, revision: 0, updatedAt: new Date().toISOString(), status: 'draft', notes: [] };
  }
}

const pending = new Map<string, Promise<unknown>>();
function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const result = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  pending.set(key, result);
  const clear = () => { if (pending.get(key) === result) pending.delete(key); };
  void result.then(clear, clear);
  return result;
}

async function persist(dir: string, s: ReviewSession): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `session-${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(s, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    await rename(tmp, join(dir, 'session.json'));
  } finally { await rm(tmp, { force: true }); }
}

async function locked<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dir, { recursive: true });
  const lockPath = join(dir, 'session.lock');
  const deadline = Date.now() + 2000;
  // shortcut: a crash can leave the lock; use OS advisory locks if unattended recovery is required.
  let lock;
  for (;;) {
    try { lock = await open(lockPath, 'wx'); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new ReviewError('Review is locked by another process. Retry; if it crashed, close all review processes before removing session.lock.', 423);
      await delay(20);
    }
  }
  try { await lock.writeFile(String(process.pid)); return await fn(); }
  finally { await lock.close(); await rm(lockPath); }
}

export function saveReviewSession(p: Project, v: Version, input: unknown): Promise<ReviewSession> {
  const parsed = saveInput.safeParse(input);
  if (!parsed.success) throw new ReviewError('Invalid notes or revision');
  const plan = versionPlan(p, v);
  const ids = new Set<string>();
  const notes = parsed.data.notes.map(n => {
    if (ids.has(n.id)) throw new ReviewError('Duplicate note id');
    ids.add(n.id);
    if (n.in > n.frame || n.out <= n.frame || n.out > plan.frames) throw new ReviewError('Note range must contain its frame and stay inside the version');
    const shot = plan.shots.find(s => n.frame >= s.start && n.frame < s.start + s.dur);
    if (!shot) throw new ReviewError('No shot at this frame');
    return { ...n, shot: shot.id, asset: shot.src, sourceFrame: shot.in + n.frame - shot.start, ...(shot.comp ? { comp: shot.comp } : {}) };
  });
  const dir = sessionDir(p, v);
  return serialize(dir, () => locked(dir, async () => {
    const previous = await readReviewSession(p, v);
    if (parsed.data.revision !== previous.revision) throw new ReviewError('Notes changed in another window. Reload before saving.', 409);
    const s: ReviewSession = { ...previous, revision: previous.revision + 1, updatedAt: new Date().toISOString(), status: 'draft', notes };
    await persist(dir, s);
    return s;
  }));
}

export function submitReview(p: Project, v: Version, revision?: number): Promise<{ session: ReviewSession; path: string }> {
  const dir = sessionDir(p, v);
  return serialize(dir, () => locked(dir, async () => {
    const previous = await readReviewSession(p, v);
    const parsed = submitInput.safeParse({ revision: revision ?? previous.revision });
    if (!parsed.success) throw new ReviewError('Invalid revision');
    if (parsed.data.revision !== previous.revision) throw new ReviewError('Notes changed in another window. Reload before submitting.', 409);
    if (!previous.notes.length) throw new ReviewError('Add a note before submitting');
    const s: ReviewSession = { ...previous, revision: previous.revision + 1, updatedAt: new Date().toISOString(), status: 'submitted' };
    await mkdir(dir, { recursive: true });
    const file = join(dir, `submitted-${randomUUID()}.json`);
    await writeFile(file, JSON.stringify(s, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    await persist(dir, s);
    return { session: s, path: file };
  }));
}
