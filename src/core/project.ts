import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AeCompAsset,
  Asset,
  AudioClip,
  Clip,
  FileAsset,
  Frames,
  ProbeInfo,
  Project,
  ReviewPlan,
  Timeline,
} from './types.js';
import { hashFile, hashJson, hashString } from './hash.js';
import { splitDissolve } from './timecode.js';

const PROJECT_FILE = 'project.json';

export interface ProjectPaths {
  cacheSegments: string;
  cacheRenders: string;
  cacheAudio: string;
  out: string;
  review: string;
  tmp: string;
}

// ---------- create / load / save ----------

export async function createProject(
  dir: string,
  meta: { name: string; fps?: number; width?: number; height?: number },
): Promise<Project> {
  const abs = path.resolve(dir);
  const file = path.join(abs, PROJECT_FILE);
  const name = meta.name?.trim();
  if (!name) throw new Error('project name is required');
  const fps = meta.fps ?? 25;
  const width = meta.width ?? 1920;
  const height = meta.height ?? 1080;
  if (!(Number.isFinite(fps) && fps > 0)) throw new Error(`bad fps: ${meta.fps}`);
  for (const [k, v] of [['width', width], ['height', height]] as const) {
    if (!(Number.isInteger(v) && v > 0)) throw new Error(`bad ${k}: ${v}`);
  }
  await mkdir(abs, { recursive: true });
  if (existsSync(file)) throw new Error(`project already exists: ${file}`);
  const p: Project = {
    meta: { name, fps, width, height, createdAt: new Date().toISOString(), schema: 1 },
    dir: abs,
    assets: {},
    timeline: normalizeTimeline(undefined),
    delivery: { targets: [] },
    versions: [],
  };
  projectPaths(p);
  await saveProject(p);
  return p;
}

/** `dir` may be the project directory or the project.json path itself. */
export async function loadProject(dir: string): Promise<Project> {
  let abs = path.resolve(dir);
  const st = await stat(abs).catch(() => undefined);
  if (st?.isFile()) abs = path.dirname(abs);
  const file = path.join(abs, PROJECT_FILE);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    throw new Error(`no ${PROJECT_FILE} in ${abs}`);
  }
  let data: Partial<Project>;
  try {
    data = JSON.parse(raw) as Partial<Project>;
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  if (!data.meta || data.meta.schema !== 1) throw new Error(`unsupported project schema in ${file}`);
  return {
    meta: data.meta,
    dir: abs,
    assets: data.assets ?? {},
    timeline: normalizeTimeline(data.timeline),
    delivery: data.delivery ?? { targets: [] },
    versions: data.versions ?? [],
  };
}

/** Atomic: writes a temp file next to project.json then renames over it. `dir` is not persisted. */
export async function saveProject(p: Project): Promise<void> {
  const file = path.join(p.dir, PROJECT_FILE);
  const tmp = path.join(p.dir, `.${PROJECT_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const { dir: _dir, ...persisted } = p;
  await mkdir(p.dir, { recursive: true });
  await writeFile(tmp, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
  try {
    await renameWithRetry(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** Windows can refuse a rename for a moment while an editor/AV scanner holds the target. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      lastErr = e;
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw e;
      await new Promise((r) => setTimeout(r, 30 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export function projectPaths(p: Project): ProjectPaths {
  const paths: ProjectPaths = {
    cacheSegments: path.join(p.dir, 'cache', 'segments'),
    cacheRenders: path.join(p.dir, 'cache', 'renders'),
    cacheAudio: path.join(p.dir, 'cache', 'audio'),
    out: path.join(p.dir, 'out'),
    review: path.join(p.dir, 'review'),
    tmp: path.join(p.dir, 'cache', 'tmp'),
  };
  for (const d of Object.values(paths)) mkdirSync(d, { recursive: true });
  return paths;
}

// ---------- assets ----------

const AUDIO_EXT = new Set(['.wav', '.mp3', '.aac', '.m4a', '.flac', '.ogg', '.oga', '.opus', '.aif', '.aiff', '.wma', '.ac3']);
const STILL_EXT = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.gif', '.webp', '.psd', '.exr', '.dpx', '.heic', '.heif', '.tga']);

function inferKind(file: string): FileAsset['kind'] {
  const ext = path.extname(file).toLowerCase();
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (STILL_EXT.has(ext)) return 'still';
  return 'camera';
}

function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** Ids end up in file names: no path separators or characters Windows refuses. */
function assertValidId(id: string): void {
  if (!id || id === '.' || id === '..' || /[\\/:*?"<>|\p{Cc}]/u.test(id) || /^\s|\s$/.test(id)) {
    throw new Error(`invalid asset id: ${JSON.stringify(id)}`);
  }
}

/** Keep letters/digits/combining marks (Thai vowels and tone marks are marks), collapse the rest to '_'. */
function sanitizeId(s: string, fallbackPrefix: string): string {
  const cleaned = s.replace(/[^\p{L}\p{M}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '');
  return cleaned || `${fallbackPrefix}_${hashString(s).slice(0, 8)}`;
}

function uniqueId(p: Project, base: string): string {
  if (!(base in p.assets)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}_${n}`;
    if (!(id in p.assets)) return id;
  }
}

export async function addFileAsset(
  p: Project,
  filePath: string,
  opts: { id?: string; kind?: FileAsset['kind']; probe?: (path: string) => Promise<ProbeInfo> } = {},
): Promise<FileAsset> {
  const abs = path.resolve(filePath);
  const st = await stat(abs).catch(() => undefined);
  if (!st?.isFile()) throw new Error(`file not found: ${abs}`);
  const kind = opts.kind ?? inferKind(abs);

  let id = opts.id;
  if (id !== undefined) {
    assertValidId(id);
    const existing = p.assets[id];
    if (existing && !(existing.kind !== 'aecomp' && samePath(existing.path, abs))) {
      throw new Error(`asset id already in use: ${id}`);
    }
  } else {
    // Re-adding the same file is idempotent.
    const existing = Object.values(p.assets).find((a): a is FileAsset => a.kind !== 'aecomp' && samePath(a.path, abs));
    id = existing?.id ?? uniqueId(p, sanitizeId(path.basename(abs, path.extname(abs)), kind));
  }

  const asset: FileAsset = { id, kind, path: abs, hash: await hashFile(abs) };
  if (opts.probe) asset.probe = await opts.probe(abs);
  p.assets[id] = asset;
  return asset;
}

export function addAeComp(p: Project, aep: string, comp: string, id?: string): AeCompAsset {
  const abs = path.resolve(aep);
  const compName = comp.trim();
  if (!compName) throw new Error('comp name is required');
  const matches = (a: Asset): a is AeCompAsset => a.kind === 'aecomp' && samePath(a.aep, abs) && a.comp === compName;

  if (id !== undefined) {
    assertValidId(id);
    const existing = p.assets[id];
    if (existing) {
      if (matches(existing)) return existing;
      throw new Error(`asset id already in use: ${id}`);
    }
  } else {
    const existing = Object.values(p.assets).find(matches);
    if (existing) return existing;
    id = uniqueId(p, `C_${sanitizeId(compName, 'comp')}`);
  }
  const asset: AeCompAsset = { id, kind: 'aecomp', aep: abs, comp: compName };
  p.assets[id] = asset;
  return asset;
}

// ---------- timeline ----------

function normalizeTimeline(t: Partial<Timeline> | undefined): Timeline {
  const audio = t?.audio;
  const out: Timeline = {
    video: Array.isArray(t?.video) ? t.video.map((c) => ({ ...c })) : [],
    cuts: Array.isArray(t?.cuts) ? t.cuts.map((c) => ({ ...c })) : [],
    audio: {
      vo: Array.isArray(audio?.vo) ? audio.vo.map((c) => ({ ...c })) : [],
      music: Array.isArray(audio?.music) ? audio.music.map((c) => ({ ...c })) : [],
      sfx: Array.isArray(audio?.sfx) ? audio.sfx.map((c) => ({ ...c })) : [],
    },
  };
  if (audio?.duck !== undefined) out.audio.duck = { ...audio.duck };
  if (audio?.useClipAudio !== undefined) out.audio.useClipAudio = audio.useClipAudio;
  return out;
}

export function setTimeline(p: Project, t: Timeline): void {
  if (!t || typeof t !== 'object') throw new TypeError('timeline must be an object');
  p.timeline = normalizeTimeline(t);
}

/** Source length in frames when known (probe, or the AE render record). Stills loop, so they report undefined. */
function sourceFrames(a: Asset): Frames | undefined {
  if (a.kind === 'still') return undefined;
  if (a.kind === 'aecomp') return a.probe?.durationFrames ?? a.render?.frames;
  return a.probe?.durationFrames;
}

function hasAudio(a: Asset): boolean | undefined {
  if (a.kind === 'still') return false;
  if (a.kind === 'audio') return a.probe ? a.probe.hasAudio : true;
  return a.probe?.hasAudio;
}

const isFrames = (v: unknown): v is Frames => Number.isInteger(v);

export function validateTimeline(p: Project): string[] {
  const errors: string[] = [];
  const t = p.timeline ?? normalizeTimeline(undefined);
  const video = t.video ?? [];
  const cuts = t.cuts ?? [];
  const assetOf = (id: string): Asset | undefined => p.assets[id];

  if (video.length === 0) errors.push('timeline.video is empty');

  // --- video clips ---
  const clipById = new Map<string, Clip>();
  const clipIndex = new Map<string, number>();
  video.forEach((c, i) => {
    const tag = `clip[${c?.id ?? `#${i}`}]`;
    if (!c || typeof c !== 'object') { errors.push(`${tag}: not an object`); return; }
    if (!c.id || typeof c.id !== 'string') errors.push(`${tag}: missing id`);
    else if (clipById.has(c.id)) errors.push(`${tag}: duplicate clip id`);
    else { clipById.set(c.id, c); clipIndex.set(c.id, i); }

    if (!isFrames(c.dur)) errors.push(`${tag}: dur must be an integer frame count (got ${c.dur})`);
    else if (c.dur <= 0) errors.push(`${tag}: dur must be > 0 (got ${c.dur})`);
    if (!isFrames(c.in)) errors.push(`${tag}: in must be an integer frame count (got ${c.in})`);
    else if (c.in < 0) errors.push(`${tag}: in must be >= 0 (got ${c.in})`);
    if (c.scale !== undefined && !(Number.isFinite(c.scale) && c.scale > 0)) errors.push(`${tag}: scale must be > 0 (got ${c.scale})`);

    const a = c.src ? assetOf(c.src) : undefined;
    if (!a) { errors.push(`${tag}: unknown asset '${c.src}'`); return; }
    if (a.kind === 'audio') errors.push(`${tag}: asset '${c.src}' is audio-only, cannot be used as video`);
    const len = sourceFrames(a);
    if (len !== undefined && isFrames(c.in) && isFrames(c.dur) && c.in + c.dur > len) {
      errors.push(`${tag}: in+dur (${c.in + c.dur}) exceeds source length ${len} of '${c.src}'`);
    }
  });

  // --- cuts / dissolves ---
  const seenCut = new Set<string>();
  const reserved = new Map<string, Frames>(); // frames of each clip consumed by dissolves on either side
  for (const cut of cuts) {
    const tag = `cut[after=${cut?.after}]`;
    if (!cut || typeof cut !== 'object') { errors.push('cut: not an object'); continue; }
    const idx = clipIndex.get(cut.after);
    if (idx === undefined) { errors.push(`${tag}: unknown clip`); continue; }
    if (idx === video.length - 1) { errors.push(`${tag}: refers to the last clip, there is nothing after it`); continue; }
    if (seenCut.has(cut.after)) { errors.push(`${tag}: duplicate cut`); continue; }
    seenCut.add(cut.after);

    if (!isFrames(cut.dissolve) || cut.dissolve < 0) { errors.push(`${tag}: dissolve must be an integer >= 0 (got ${cut.dissolve})`); continue; }
    if (cut.dissolve === 0) continue;

    const A = video[idx] as Clip;
    const B = video[idx + 1] as Clip;
    const { a, b } = splitDissolve(cut.dissolve);
    reserved.set(A.id, (reserved.get(A.id) ?? 0) + a);
    reserved.set(B.id, (reserved.get(B.id) ?? 0) + b);

    // A needs b frames of handle after its out point, B needs a frames before its in point.
    // Only checked when the clips' own in/dur are valid; those errors are already reported above.
    const assetA = assetOf(A.src);
    const assetB = assetOf(B.src);
    const lenA = assetA ? sourceFrames(assetA) : undefined;
    if (lenA !== undefined && isFrames(A.in) && A.in >= 0 && isFrames(A.dur) && A.dur > 0) {
      const avail = lenA - (A.in + A.dur);
      if (avail < b) errors.push(`${tag}: dissolve ${cut.dissolve} needs ${b} handle frame(s) after '${A.id}' out, source '${A.src}' has ${Math.max(0, avail)}`);
    }
    if (assetB && assetB.kind !== 'still' && isFrames(B.in) && B.in >= 0 && B.in < a) {
      errors.push(`${tag}: dissolve ${cut.dissolve} needs ${a} handle frame(s) before '${B.id}' in, clip has ${B.in}`);
    }
  }
  for (const [id, n] of reserved) {
    const c = clipById.get(id);
    if (c && isFrames(c.dur) && c.dur > 0 && n >= c.dur) {
      errors.push(`clip[${id}]: dissolves consume ${n} frame(s) but the clip is only ${c.dur}; at least 1 frame of body must remain`);
    }
  }

  // --- audio ---
  const audioIds = new Set<string>();
  const tracks: Array<[string, AudioClip[]]> = [['vo', t.audio?.vo ?? []], ['music', t.audio?.music ?? []], ['sfx', t.audio?.sfx ?? []]];
  for (const [track, clips] of tracks) {
    clips.forEach((c, i) => {
      const tag = `audio.${track}[${c?.id ?? `#${i}`}]`;
      if (!c || typeof c !== 'object') { errors.push(`${tag}: not an object`); return; }
      if (!c.id || typeof c.id !== 'string') errors.push(`${tag}: missing id`);
      else if (audioIds.has(c.id)) errors.push(`${tag}: duplicate audio clip id`);
      else audioIds.add(c.id);

      if (!isFrames(c.at) || c.at < 0) errors.push(`${tag}: at must be an integer >= 0 (got ${c.at})`);
      if (c.in !== undefined && (!isFrames(c.in) || c.in < 0)) errors.push(`${tag}: in must be an integer >= 0 (got ${c.in})`);
      if (c.dur !== undefined && (!isFrames(c.dur) || c.dur <= 0)) errors.push(`${tag}: dur must be an integer > 0 (got ${c.dur})`);
      if (c.gainDb !== undefined && !Number.isFinite(c.gainDb)) errors.push(`${tag}: gainDb must be a number`);
      for (const k of ['fadeIn', 'fadeOut'] as const) {
        const v = c[k];
        if (v !== undefined && (!isFrames(v) || v < 0)) errors.push(`${tag}: ${k} must be an integer >= 0 (got ${v})`);
      }

      const a = c.src ? assetOf(c.src) : undefined;
      if (!a) { errors.push(`${tag}: unknown asset '${c.src}'`); return; }
      if (hasAudio(a) === false) errors.push(`${tag}: asset '${c.src}' has no audio`);
      const len = sourceFrames(a);
      const inF = c.in ?? 0;
      if (len !== undefined && isFrames(inF)) {
        if (c.dur !== undefined && isFrames(c.dur) && inF + c.dur > len) {
          errors.push(`${tag}: in+dur (${inF + c.dur}) exceeds source length ${len} of '${c.src}'`);
        } else if (c.dur === undefined && inF >= len) {
          errors.push(`${tag}: in (${inF}) is at or past the end of source '${c.src}' (${len})`);
        }
      }
    });
  }
  const duck = t.audio?.duck;
  if (duck !== undefined) {
    if (!Number.isFinite(duck.underDb)) errors.push('audio.duck.underDb must be a number');
    if (!(Number.isFinite(duck.attackMs) && duck.attackMs >= 0)) errors.push('audio.duck.attackMs must be >= 0');
    if (!(Number.isFinite(duck.releaseMs) && duck.releaseMs >= 0)) errors.push('audio.duck.releaseMs must be >= 0');
  }

  return errors;
}

export function timelineFrames(p: Project): Frames {
  return (p.timeline?.video ?? []).reduce((sum, c) => sum + (isFrames(c.dur) && c.dur > 0 ? c.dur : 0), 0);
}

export function captureReviewPlan(p: Project): ReviewPlan {
  const starts = clipStartFrames(p);
  return {
    fps: p.meta.fps, width: p.meta.width, height: p.meta.height, frames: timelineFrames(p),
    cuts: structuredClone(p.timeline.cuts),
    shots: p.timeline.video.map(c => {
      const asset = p.assets[c.src];
      return { ...c, start: starts.get(c.id) ?? 0, ...(asset?.kind === 'aecomp' ? { comp: asset.comp } : {}) };
    }),
  };
}

export function clipStartFrames(p: Project): Map<string, Frames> {
  const starts = new Map<string, Frames>();
  let pos = 0;
  for (const c of p.timeline?.video ?? []) {
    starts.set(c.id, pos);
    pos += isFrames(c.dur) && c.dur > 0 ? c.dur : 0;
  }
  return starts;
}

/**
 * Identity of what a build would produce: timeline + the content identity of every referenced
 * asset (file hash / comp fingerprint, falling back to the path when not yet known) + picture format.
 * Unreferenced assets, project name and delivery settings do not affect it.
 */
export function planHash(p: Project): string {
  const t = p.timeline ?? normalizeTimeline(undefined);
  const used = new Set<string>();
  for (const c of t.video ?? []) used.add(c.src);
  for (const c of [...(t.audio?.vo ?? []), ...(t.audio?.music ?? []), ...(t.audio?.sfx ?? [])]) used.add(c.src);
  const assets = [...used].sort().map((id) => {
    const a = p.assets[id];
    if (!a) return { id, missing: true };
    if (a.kind === 'aecomp') return { id, kind: a.kind, comp: a.comp, src: a.fingerprint ?? `aep:${a.aep}` };
    return { id, kind: a.kind, src: a.hash ?? `path:${a.path}` };
  });
  return hashJson({
    meta: { fps: p.meta.fps, width: p.meta.width, height: p.meta.height },
    timeline: t,
    assets,
  });
}

/** 'v001', 'v002', ...: one past the highest existing id, skipping any id whose out/ folder already exists. */
export function nextVersionId(p: Project): string {
  let n = 0;
  for (const v of p.versions) {
    const m = /^v(\d+)$/.exec(v.id);
    if (m) n = Math.max(n, parseInt(m[1] as string, 10));
  }
  for (;;) {
    n++;
    const id = `v${String(n).padStart(3, '0')}`;
    if (!p.versions.some((v) => v.id === id) && !existsSync(path.join(p.dir, 'out', id))) return id;
  }
}
