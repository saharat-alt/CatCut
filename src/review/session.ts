import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { captureReviewPlan, planHash, projectPaths } from '../core/project.js';
import type { Project, ReviewPlan, Version } from '../core/types.js';

/** Pen colour = edit intent (DESIGN §7.5). The UI chips in web/review/style.css use the same values. */
export const INTENT_COLORS = {
  cut: '#ff5a52', timing: '#ffd23f', text: '#4c8dff', color: '#3ccf6e', audio: '#b77cff', other: '#c4c4cc',
} as const;
type Intent = keyof typeof INTENT_COLORS;

const frame = z.number().int().nonnegative();
const coordinate = z.number().min(0).max(1);
const intent = z.enum(Object.keys(INTENT_COLORS) as [Intent, ...Intent[]]);
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
const text = z.string().trim().max(5000).default('');
// Legacy strokes are bare { points } freehand lines; circle/arrow are two points (box corners / tail→head).
const stroke = z.object({
  kind: z.enum(['free', 'circle', 'arrow']).default('free'),
  points: z.array(z.tuple([coordinate, coordinate])).min(2).max(512),
  intent: intent.optional(),
  color: color.optional(),
}).strict().refine(s => s.kind === 'free' || s.points.length === 2, 'Circle and arrow marks have exactly two points');
const strokes = z.array(stroke).max(16);
const noteBase = z.object({
  id: z.string().min(1).max(80), frame, in: frame, out: frame, intent, color: color.optional(), text, strokes,
  status: z.enum(['open', 'resolved']).default('open'),
}).strict();
const noteInput = noteBase.refine(n => n.text.length > 0 || n.strokes.length > 0, 'A note needs text or a mark');
const saveInput = z.object({ revision: frame, notes: z.array(noteInput).max(100) }).strict();
const submitInput = z.object({ revision: frame }).strict();

type NoteFields = z.infer<typeof noteBase>;
/** Fill colour defaults so every stored note and stroke carries its intent + colour. */
function withColors<T extends NoteFields>(n: T): T & { color: string } {
  return {
    ...n, color: n.color ?? INTENT_COLORS[n.intent],
    strokes: n.strokes.map(s => {
      const i = s.intent ?? n.intent;
      return { ...s, intent: i, color: s.color ?? INTENT_COLORS[i] };
    }),
  };
}
const storedNote = noteBase.extend({ shot: z.string(), asset: z.string(), sourceFrame: frame, comp: z.string().optional() }).transform(withColors);
const sessionSchema = z.object({
  version: z.string(), planHash: z.string(), revision: frame, updatedAt: z.string(),
  status: z.enum(['draft', 'submitted']), notes: z.array(storedNote).max(100),
}).strict();
export type ReviewSession = z.infer<typeof sessionSchema>;

const draftInput = z.object({
  frame, in: frame, out: frame, intent, text: z.string().max(5000), strokes, editingId: z.string().min(1).max(80).optional(),
}).strict();
const draftBody = z.object({ draft: draftInput.nullable() }).strict();
const storedDraft = draftInput.extend({ version: z.string(), planHash: z.string(), updatedAt: z.string() }).strict();
type ReviewDraft = z.infer<typeof storedDraft>;

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

async function persist(dir: string, name: string, value: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `${name}-${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    await rename(tmp, join(dir, `${name}.json`));
  } finally { await rm(tmp, { force: true }); }
}

/** A lock older than this, or whose owner pid is gone, is treated as left behind by a crash. */
const LOCK_STALE_MS = 2 * 60_000;

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Returns the lock text if the lock looks abandoned, otherwise undefined. */
async function staleLock(lockPath: string): Promise<string | undefined> {
  let content: string, mtime: number;
  try { [content, mtime] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath).then(s => s.mtimeMs)]); }
  catch { return undefined; }
  let pid: number | undefined, at = mtime, host: string | undefined;
  try {
    const owner = JSON.parse(content) as unknown;
    if (typeof owner === 'number') pid = owner; // legacy lock: bare pid
    else if (owner && typeof owner === 'object') {
      const o = owner as Record<string, unknown>;
      if (typeof o.pid === 'number') pid = o.pid;
      if (typeof o.at === 'number') at = o.at;
      if (typeof o.host === 'string') host = o.host;
    }
  } catch { /* unreadable owner: fall back to age */ }
  if (Date.now() - at > LOCK_STALE_MS) return content;
  if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0 && (host === undefined || host === hostname()) && !pidAlive(pid)) return content;
  return undefined;
}

/** Move an abandoned lock aside; only one contender wins the rename. A lock that changed meanwhile is put back. */
async function reclaim(lockPath: string, staleContent: string): Promise<void> {
  const aside = `${lockPath}.stale-${randomUUID()}`;
  try { await rename(lockPath, aside); } catch { return; }
  const moved = await readFile(aside, 'utf8').catch(() => staleContent);
  if (moved !== staleContent) {
    // Someone re-created the lock between our check and rename: restore it unless a newer lock exists.
    try { await open(lockPath, 'wx').then(h => h.writeFile(moved).finally(() => h.close())); } catch { /* newer lock already in place */ }
  }
  await rm(aside, { force: true });
}

async function locked<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dir, { recursive: true });
  const lockPath = join(dir, 'session.lock');
  const deadline = Date.now() + 2000;
  const token = JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now(), id: randomUUID() });
  let lock;
  for (;;) {
    try { lock = await open(lockPath, 'wx'); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stale = await staleLock(lockPath);
      if (stale !== undefined) { await reclaim(lockPath, stale); continue; }
      if (Date.now() >= deadline) throw new ReviewError(`Review is locked by another process (session.lock). Retry in a moment; a lock left by a crashed process is reclaimed automatically after ${LOCK_STALE_MS / 60_000} minutes.`, 423);
      await delay(20);
    }
  }
  try { await lock.writeFile(token); return await fn(); }
  finally {
    await lock.close();
    // Only remove our own lock; if it was reclaimed after a hang, leave the new owner's lock alone.
    if (await readFile(lockPath, 'utf8').catch(() => undefined) === token) await rm(lockPath, { force: true });
  }
}

export function saveReviewSession(p: Project, v: Version, input: unknown): Promise<ReviewSession> {
  const parsed = saveInput.safeParse(input);
  if (!parsed.success) throw new ReviewError(parsed.error.issues.some(i => i.message === 'A note needs text or a mark') ? 'A note needs text or a mark' : 'Invalid notes or revision');
  const plan = versionPlan(p, v);
  const ids = new Set<string>();
  const notes = parsed.data.notes.map(n => {
    if (ids.has(n.id)) throw new ReviewError('Duplicate note id');
    ids.add(n.id);
    if (n.in > n.frame || n.out <= n.frame || n.out > plan.frames) throw new ReviewError('Note range must contain its frame and stay inside the version');
    const shot = plan.shots.find(s => n.frame >= s.start && n.frame < s.start + s.dur);
    if (!shot) throw new ReviewError('No shot at this frame');
    return withColors({ ...n, shot: shot.id, asset: shot.src, sourceFrame: shot.in + n.frame - shot.start, ...(shot.comp ? { comp: shot.comp } : {}) });
  });
  const dir = sessionDir(p, v);
  return serialize(dir, () => locked(dir, async () => {
    const previous = await readReviewSession(p, v);
    if (parsed.data.revision !== previous.revision) throw new ReviewError('Notes changed in another window. Reload before saving.', 409);
    const s: ReviewSession = { ...previous, revision: previous.revision + 1, updatedAt: new Date().toISOString(), status: 'draft', notes };
    await persist(dir, 'session', s);
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
    await persist(dir, 'session', s);
    return { session: s, path: file };
  }));
}

/** The unsaved editor draft (text, marks, range) so a reload or crash does not lose it. Not part of the agent-facing notes. */
export async function readReviewDraft(p: Project, v: Version): Promise<ReviewDraft | null> {
  try {
    const d = storedDraft.parse(JSON.parse(await readFile(join(sessionDir(p, v), 'draft.json'), 'utf8')));
    return d.version === v.id && d.planHash === v.planHash ? d : null;
  } catch { return null; }
}

export function saveReviewDraft(p: Project, v: Version, input: unknown): Promise<ReviewDraft | null> {
  const parsed = draftBody.safeParse(input);
  if (!parsed.success) throw new ReviewError('Invalid draft');
  const d = parsed.data.draft;
  if (d) {
    const plan = versionPlan(p, v);
    if (d.frame >= plan.frames || d.in >= d.out || d.out > plan.frames) throw new ReviewError('Draft range must stay inside the version');
  }
  const dir = sessionDir(p, v);
  return serialize(`${dir}#draft`, async () => {
    if (!d) { await rm(join(dir, 'draft.json'), { force: true }); return null; }
    const stored: ReviewDraft = { ...d, version: v.id, planHash: v.planHash, updatedAt: new Date().toISOString() };
    await persist(dir, 'draft', stored);
    return stored;
  });
}
