import { execa, type Options as ExecaOptions } from 'execa';
import { constants, existsSync } from 'node:fs';
import { copyFile, link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type {
  AeBackend,
  Asset,
  AudioClip,
  BuildOptions,
  BuildResult,
  BuildStats,
  Clip,
  DeliveryPreset,
  DeliveryTargetId,
  Environment,
  Frames,
  ProbeInfo,
  Progress,
  Project,
  QcReport,
  ToolPaths,
  Version,
} from '../core/types.js';
import { hashFile, hashJson, hashString } from '../core/hash.js';
import {
  clipStartFrames,
  nextVersionId,
  planHash,
  projectPaths,
  saveProject,
  timelineFrames,
  validateTimeline,
} from '../core/project.js';
import { splitDissolve } from '../core/timecode.js';
import { MASTER_PRESET_ID, presetToFfmpegArgs, resolvePreset } from './presets.js';

// ---------- types owned by this module ----------

/** Mirrors `runQc` from qc.ts; injected so this module does not import it. */
export interface QcArgs {
  tools: ToolPaths;
  path: string;
  expectedFrames: Frames;
  fps: number;
  loudness?: { integratedLufs: number; truePeakDb: number; toleranceLu?: number };
  contactSheetPath?: string;
  clipStarts?: Array<{ clipId: string; start: Frames; dur: Frames }>;
  signal?: AbortSignal;
}
export type QcRunner = (args: QcArgs) => Promise<QcReport>;

export interface AssemblerDeps {
  tools: ToolPaths;
  env: Environment;
  ae: AeBackend;
  qc?: QcRunner;
  /** parallel segment encodes; default 2 when >= 3 GB RAM is free, else 1 */
  concurrency?: number;
}

export interface LoudnessMeasure {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
  targetOffset: number;
}

interface CacheEntry {
  file: string; // basename inside cacheSegments
  frames: Frames;
  kind: 'segment' | 'dissolve';
  mode: 'copy' | 'encode';
  clipId?: string;
  createdAt: string;
}
interface CacheManifest {
  schema: 1;
  entries: Record<string, CacheEntry>;
}

interface Source {
  assetId: string;
  kind: Asset['kind'];
  path: string;
  probe: ProbeInfo;
  identity: string; // file hash or comp fingerprint
}

interface SegmentPlan {
  clip: Clip;
  index: number;
  src: Source;
  key: string;
  srcIn: Frames; // first source frame of the segment body
  frames: Frames; // body length (dissolve halves excluded)
  trimStart: Frames; // frames given to the dissolve before this clip
  trimEnd: Frames; // frames given to the dissolve after this clip
}

interface DissolvePlan {
  a: SegmentPlan;
  b: SegmentPlan;
  n: Frames;
  half: { a: Frames; b: Frames };
  key: string;
  aSrcIn: Frames;
  bSrcIn: Frames;
}

type ConcatItem = { kind: 'segment'; plan: SegmentPlan } | { kind: 'dissolve'; plan: DissolvePlan };

// ---------- process helpers ----------

const FF_BASE = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
const PRORES_HQ_ARGS = ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le'];
const ALL_INTRA = new Set(['prores', 'dnxhd', 'mjpeg', 'png', 'tiff', 'bmp', 'rawvideo', 'v210', 'huffyuv', 'ffvhuff', 'cfhd', 'qtrle', 'ffv1', 'utvideo', 'magicyuv', 'dpx', 'exr']);
const MIN_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 60 * 60_000;

class AbortError extends Error {
  constructor(message = 'build aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortError();
}

function tail(s: string, lines = 12): string {
  const arr = s.trim().split(/\r?\n/);
  return arr.slice(-lines).join('\n');
}

async function run(bin: string, args: string[], o: { timeoutMs: number; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string }> {
  throwIfAborted(o.signal);
  const opts: ExecaOptions = {
    windowsHide: true,
    timeout: Math.min(MAX_TIMEOUT_MS, Math.max(1000, Math.round(o.timeoutMs))),
    forceKillAfterDelay: 3000,
    reject: false,
    stdin: 'ignore',
    maxBuffer: 64 * 1024 * 1024,
    cancelSignal: o.signal,
  };
  const r = await execa(bin, args, opts);
  const stdout = typeof r.stdout === 'string' ? r.stdout : '';
  const stderr = typeof r.stderr === 'string' ? r.stderr : '';
  if (r.isCanceled || o.signal?.aborted) throw new AbortError();
  const name = path.basename(bin);
  if (r.timedOut) throw new Error(`${name} timed out after ${opts.timeout} ms\n  args: ${args.join(' ')}`);
  if (r.exitCode !== 0) throw new Error(`${name} failed (exit ${r.exitCode}): ${tail(stderr)}\n  args: ${args.join(' ')}`);
  return { stdout, stderr };
}

/** Seconds budget for an encode of `frames` at `fps`: 30x realtime, floored at 2 min. */
function encodeTimeout(frames: Frames, fps: number): number {
  return Math.max(MIN_TIMEOUT_MS, Math.ceil((frames / fps) * 1000 * 30));
}

function sec(frames: Frames, fps: number): string {
  return (frames / fps).toFixed(6);
}

function msOf(frames: Frames, fps: number): number {
  return Math.round((frames / fps) * 1000);
}

/** mov timescale: 25 -> 25000, 29.97 -> 30000 (frame duration 1001). */
export function movTimescale(fps: number): number {
  return Number.isInteger(fps) ? fps * 1000 : Math.round(fps) * 1000;
}

function sanitizeName(s: string, fallback: string): string {
  const cleaned = s.replace(/[\\/:*?"<>|\p{Cc}]+/gu, '_').trim();
  return cleaned || fallback;
}

/** ASCII-only cache file stem; non-ASCII ids keep a short hash so distinct ids never collide. */
function asciiStem(id: string): string {
  const ascii = id.replace(/[^A-Za-z0-9_-]+/g, '_');
  return ascii === id ? id : `${ascii.replace(/^_+|_+$/g, '') || 'x'}_${hashString(id).slice(0, 6)}`;
}

/** `base` if free, else `base_2`, `base_3`, ... Outputs are never overwritten. */
function uniquePath(base: string): string {
  if (!existsSync(base)) return base;
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let n = 2; ; n++) {
    const cand = `${stem}_${n}${ext}`;
    if (!existsSync(cand)) return cand;
  }
}

function tmpFile(dir: string, ext: string): string {
  return path.join(dir, `${process.pid}_${randomBytes(4).toString('hex')}${ext}`);
}

async function moveInto(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true });
  try { await link(from, to); }
  catch (e) {
    if (!['EXDEV', 'EPERM', 'ENOTSUP'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
    await copyFile(from, to, constants.COPYFILE_EXCL);
  }
  await rm(from);
}

// ---------- probe ----------

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  codec_tag_string?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
  nb_read_packets?: string;
  duration?: string;
  sample_rate?: string;
  channels?: number;
  disposition?: { attached_pic?: number };
}
interface FfprobeOut {
  streams?: FfprobeStream[];
  format?: { format_name?: string; duration?: string };
}

function parseRate(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(s.trim());
  if (m) {
    const num = Number(m[1]);
    const den = Number(m[2]);
    if (!den || !num) return undefined;
    const v = num / den;
    return Number.isInteger(v) ? v : Math.round(v * 1000) / 1000;
  }
  const v = Number(s);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

async function ffprobeJson(tools: ToolPaths, file: string, signal?: AbortSignal): Promise<FfprobeOut> {
  const { stdout } = await run(tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 120_000, signal });
  return JSON.parse(stdout) as FfprobeOut;
}

/** fps as an ffmpeg rational where that is exact: 25 -> "25", 29.97 -> "30000/1001". */
function fpsExpr(fps: number): string {
  if (Number.isInteger(fps)) return String(fps);
  const n = Math.round((fps * 1001) / 1000);
  return Math.abs((n * 1000) / 1001 - fps) < 1e-3 ? `${n * 1000}/1001` : String(fps);
}

/**
 * ffprobe -> ProbeInfo. Duration uses project frames (`opts.fps`, default 25);
 * `fps` remains the source frame rate. Stills return 1 and are looped by the assembler.
 */
export async function probe(tools: ToolPaths, file: string, opts: { fps?: number; signal?: AbortSignal } = {}): Promise<ProbeInfo> {
  const data = await ffprobeJson(tools, file, opts.signal);
  const streams = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === 'audio');
  const formatName = data.format?.format_name ?? '';
  const isStill = !!v && (/image2|_pipe/.test(formatName) || v.nb_frames === '1');
  const info: ProbeInfo = { durationFrames: 0, hasVideo: !!v, hasAudio: !!a };
  if (a) {
    info.audioCodec = a.codec_name;
    if (a.sample_rate) info.sampleRate = Number(a.sample_rate);
    if (a.channels) info.channels = a.channels;
  }
  if (v) {
    info.videoCodec = v.codec_name;
    info.pixFmt = v.pix_fmt;
    if (v.width) info.width = v.width;
    if (v.height) info.height = v.height;
    if (isStill) {
      info.durationFrames = 1;
      info.allIntra = true;
      return info;
    }
    const fps = parseRate(v.r_frame_rate) ?? parseRate(v.avg_frame_rate);
    if (fps) info.fps = fps;
    info.allIntra = !!v.codec_name && ALL_INTRA.has(v.codec_name);
    let frames = Number(v.nb_frames);
    if (!(Number.isInteger(frames) && frames > 0)) {
      const dur = Number(v.duration ?? data.format?.duration);
      if (fps && Number.isFinite(dur) && dur > 0) frames = Math.round(dur * fps);
    }
    if (!(Number.isInteger(frames) && frames > 0)) frames = await countVideoPackets(tools, file, opts.signal);
    const duration = Number(v.duration ?? data.format?.duration);
    info.durationFrames = Number.isFinite(duration) && duration > 0
      ? Math.round(duration * (opts.fps ?? 25))
      : Math.round(frames * (opts.fps ?? 25) / (fps ?? opts.fps ?? 25));
    return info;
  }
  const dur = Number(a?.duration ?? data.format?.duration);
  info.durationFrames = Number.isFinite(dur) && dur > 0 ? Math.round(dur * (opts.fps ?? 25)) : 0;
  return info;
}

/** Number of video packets (== frames for every container/codec we write). Fast: no decode. */
export async function countVideoPackets(tools: ToolPaths, file: string, signal?: AbortSignal): Promise<number> {
  const { stdout } = await run(
    tools.ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file],
    { timeoutMs: 10 * 60_000, signal },
  );
  const n = parseInt(stdout.trim(), 10);
  if (!Number.isInteger(n)) throw new Error(`could not count frames of ${file}: ${stdout}`);
  return n;
}

async function firstVideoPtsSec(tools: ToolPaths, file: string, signal?: AbortSignal): Promise<number> {
  const { stdout } = await run(
    tools.ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-read_intervals', '%+#1', '-of', 'csv=p=0', file],
    { timeoutMs: 60_000, signal },
  );
  const v = Number(stdout.trim().split(/\r?\n/)[0]);
  return Number.isFinite(v) ? v : Number.NaN;
}

async function codecTag(tools: ToolPaths, file: string, signal?: AbortSignal): Promise<string> {
  const { stdout } = await run(
    tools.ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_tag_string', '-of', 'csv=p=0', file],
    { timeoutMs: 60_000, signal },
  );
  return stdout.trim();
}

// ---------- loudness ----------

/** loudnorm first pass. Returns undefined for digital silence. */
export async function measureLoudnorm(
  tools: ToolPaths,
  file: string,
  target: { integratedLufs: number; truePeakDb: number; lra: number },
  signal?: AbortSignal,
): Promise<LoudnessMeasure | undefined> {
  const { stderr } = await run(
    tools.ffmpeg,
    ['-hide_banner', '-nostdin', '-loglevel', 'info', '-i', file, '-vn', '-af', `loudnorm=I=${target.integratedLufs}:TP=${target.truePeakDb}:LRA=${target.lra}:print_format=json`, '-f', 'null', '-'],
    { timeoutMs: 20 * 60_000, signal },
  );
  const m = /\{[^{}]*"input_i"[^{}]*\}/.exec(stderr);
  if (!m) throw new Error(`loudnorm measurement produced no JSON:\n${tail(stderr)}`);
  const j = JSON.parse(m[0]) as Record<string, string>;
  const num = (k: string): number => Number(j[k]);
  const inputI = num('input_i');
  if (!Number.isFinite(inputI) || inputI < -70) return undefined;
  return { inputI, inputTp: num('input_tp'), inputLra: num('input_lra'), inputThresh: num('input_thresh'), targetOffset: num('target_offset') };
}

function loudnormPass2(m: LoudnessMeasure, target: { integratedLufs: number; truePeakDb: number; lra: number }): string {
  // Linear mode needs LRA target >= measured; raise it so loudnorm does not fall back to dynamic.
  const lra = Math.min(50, Math.max(target.lra, Math.ceil(m.inputLra)));
  const f = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '0');
  return `loudnorm=I=${target.integratedLufs}:TP=${target.truePeakDb}:LRA=${lra}:measured_I=${f(m.inputI)}:measured_TP=${f(m.inputTp)}:measured_LRA=${f(m.inputLra)}:measured_thresh=${f(m.inputThresh)}:offset=${f(m.targetOffset)}:linear=true:print_format=summary,aresample=48000`;
}

function sameLoudness(a: DeliveryPreset['loudness'], b: DeliveryPreset['loudness']): boolean {
  if (!a || !b) return !a && !b;
  return Math.abs(a.integratedLufs - b.integratedLufs) < 0.05 && Math.abs(a.truePeakDb - b.truePeakDb) < 0.05;
}

// ---------- picture fitting ----------

/** scale-to-fit x scale% then centre crop/pad to W x H. */
function fitFilters(srcW: number, srcH: number, W: number, H: number, scalePct: number): string[] {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const s = Math.min(W / srcW, H / srcH) * (scalePct / 100);
  const sw = even(srcW * s);
  const sh = even(srcH * s);
  const cw = Math.min(sw, W);
  const ch = Math.min(sh, H);
  const out: string[] = [];
  if (sw !== srcW || sh !== srcH) out.push(`scale=${sw}:${sh}:flags=lanczos`);
  if (cw !== sw || ch !== sh) out.push(`crop=${cw}:${ch}`);
  if (cw !== W || ch !== H) out.push(`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`);
  out.push('setsar=1');
  return out;
}

// ---------- audio graph ----------

interface AudioPiece {
  input: number;
  startSec: number;
  endSec?: number;
  atSec: number;
  gainDb: number;
  fadeIn?: { sec: number };
  fadeOut?: { startSec: number; sec: number };
}

class FilterGraph {
  private readonly parts: string[] = [];
  private n = 0;
  readonly inputs: string[] = [];
  private readonly inputIndex = new Map<string, number>();

  input(file: string): number {
    const key = process.platform === 'win32' ? file.toLowerCase() : file;
    const idx = this.inputIndex.get(key);
    if (idx !== undefined) return idx;
    const i = this.inputs.length;
    this.inputs.push(file);
    this.inputIndex.set(key, i);
    return i;
  }

  label(): string {
    return `n${this.n++}`;
  }

  add(chain: string): void {
    this.parts.push(chain);
  }

  piece(p: AudioPiece): string {
    const out = this.label();
    const f: string[] = [];
    const trim = [`start=${p.startSec.toFixed(6)}`];
    if (p.endSec !== undefined) trim.push(`end=${p.endSec.toFixed(6)}`);
    f.push(`atrim=${trim.join(':')}`, 'asetpts=PTS-STARTPTS', 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo');
    if (p.gainDb) f.push(`volume=${p.gainDb.toFixed(3)}dB`);
    if (p.fadeIn && p.fadeIn.sec > 0) f.push(`afade=t=in:st=0:d=${p.fadeIn.sec.toFixed(6)}`);
    if (p.fadeOut && p.fadeOut.sec > 0) f.push(`afade=t=out:st=${Math.max(0, p.fadeOut.startSec).toFixed(6)}:d=${p.fadeOut.sec.toFixed(6)}`);
    const ms = Math.round(p.atSec * 1000);
    if (ms > 0) f.push(`adelay=delays=${ms}:all=1`);
    this.add(`[${p.input}:a:0]${f.join(',')}[${out}]`);
    return out;
  }

  /** Sum (no normalisation) of labels; returns undefined for none. */
  mix(labels: string[]): string | undefined {
    if (labels.length === 0) return undefined;
    if (labels.length === 1) return labels[0];
    const out = this.label();
    this.add(`${labels.map((l) => `[${l}]`).join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0[${out}]`);
    return out;
  }

  toString(): string {
    return this.parts.join(';');
  }
}

// ---------- the assembler ----------

export class Assembler {
  private readonly tools: ToolPaths;
  private readonly env: Environment;
  private readonly ae: AeBackend;
  private readonly qc?: QcRunner;
  private readonly concurrency: number;
  private readonly loudnessCache = new Map<string, LoudnessMeasure | undefined>();

  constructor(deps: AssemblerDeps) {
    this.tools = deps.tools;
    this.env = deps.env;
    this.ae = deps.ae;
    this.qc = deps.qc;
    this.concurrency = Math.max(1, deps.concurrency ?? (deps.env.freeRamGb >= 3 ? 2 : 1));
  }

  private async encode(args: string[], videoArgs: string[], cpuArgs: string[], timeoutMs: number, signal?: AbortSignal): Promise<void> {
    try { await run(this.tools.ffmpeg, args, { timeoutMs, signal }); }
    catch (error) {
      throwIfAborted(signal);
      if (!videoArgs.includes('h264_nvenc') && !videoArgs.includes('hevc_nvenc')) throw error;
      // An encoder in ffmpeg's inventory may have no working GPU/driver on this host.
      const start = args.indexOf('-c:v');
      const retry = [...args.slice(0, start), ...cpuArgs, ...args.slice(start + videoArgs.length)];
      await run(this.tools.ffmpeg, retry, { timeoutMs, signal });
    }
  }

  // ----- build -----

  async build(p: Project, opts: BuildOptions = {}): Promise<BuildResult> {
    const t0 = performance.now();
    const signal = opts.signal;
    const fps = p.meta.fps;
    const paths = projectPaths(p);
    const report = (stage: string, done: number, total: number, message?: string) =>
      opts.onProgress?.({ stage, done, total, ...(message ? { message } : {}) });
    const stats: BuildStats = {
      segmentsTotal: 0, segmentsRendered: 0, segmentsReused: 0, dissolvesRendered: 0, compsRendered: 0, compsReused: 0, timingsMs: {},
    };
    const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const t = performance.now();
      try {
        return await fn();
      } finally {
        stats.timingsMs[name] = Math.round(performance.now() - t);
      }
    };

    if (p.timeline.video.length === 0) throw new Error('timeline.video is empty: nothing to build');

    // 1. AE comps
    await timed('comps', () => this.ensureCompRenders(p, paths.cacheRenders, stats, report, signal, opts.force));

    // 2. probe + hash file assets, then validate
    const sources = await timed('probe', () => this.resolveSources(p, report, signal));
    await saveProject(p);
    const errors = validateTimeline(p);
    if (errors.length) throw new Error(`timeline invalid:\n - ${errors.join('\n - ')}`);

    const totalFrames = timelineFrames(p);
    const { segments, dissolves, order } = planTimeline(p, sources);
    stats.segmentsTotal = segments.length;

    const manifest = await loadManifest(paths.cacheSegments);
    const saveManifest = () => writeManifest(paths.cacheSegments, manifest);

    // 3. segments
    await timed('segments', async () => {
      let done = 0;
      report('segments', 0, segments.length);
      await parallel(segments, this.concurrency, async (seg) => {
        const hit = !opts.force && (await this.cacheHit(manifest, paths.cacheSegments, seg.key, seg.frames, signal));
        if (hit) stats.segmentsReused++;
        else {
          await this.renderSegment(p, seg, paths, manifest, signal);
          stats.segmentsRendered++;
        }
        report('segments', ++done, segments.length, `${seg.clip.id}: ${hit ? 'cache' : 'rendered'}`);
      });
      await saveManifest();
    });

    // 4. dissolves
    await timed('dissolves', async () => {
      let done = 0;
      report('dissolves', 0, dissolves.length);
      await parallel(dissolves, this.concurrency, async (d) => {
        const hit = !opts.force && (await this.cacheHit(manifest, paths.cacheSegments, d.key, d.n, signal));
        if (!hit) {
          await this.renderDissolve(p, d, paths, manifest, signal);
          stats.dissolvesRendered++;
        }
        report('dissolves', ++done, dissolves.length, `${d.a.clip.id}->${d.b.clip.id} (${d.n}f): ${hit ? 'cache' : 'rendered'}`);
      });
      await saveManifest();
    });

    // version paths (decided late so a failed build leaves no empty version folder behind)
    const versionId = nextVersionId(p);
    const versionDir = path.join(paths.out, versionId);
    const baseName = `${sanitizeName(p.meta.name, 'master')}_${versionId}`;
    await mkdir(versionDir, { recursive: true });

    // 5. concat -> video-only master
    const videoOnly = await timed('concat', async () => {
      report('concat', 0, 1);
      const list = tmpFile(paths.tmp, '.txt');
      const lines = ['ffconcat version 1.0'];
      for (const item of order) {
        const entry = manifest.entries[item.plan.key];
        if (!entry) throw new Error(`internal: no cache entry for ${item.plan.key}`);
        lines.push(`file ${concatQuote(path.join(paths.cacheSegments, entry.file))}`);
      }
      await writeFile(list, `${lines.join('\n')}\n`, 'utf8');
      const out = tmpFile(paths.tmp, '.mov');
      try {
        await run(
          this.tools.ffmpeg,
          [...FF_BASE, '-y', '-f', 'concat', '-safe', '0', '-i', list, '-map', '0:v:0', '-c', 'copy', '-video_track_timescale', String(movTimescale(fps)), out],
          { timeoutMs: Math.max(5 * 60_000, encodeTimeout(totalFrames, fps)), signal },
        );
      } finally {
        await rm(list, { force: true });
      }
      const got = await countVideoPackets(this.tools, out, signal);
      if (got !== totalFrames) {
        await rm(out, { force: true });
        throw new Error(`stitched master has ${got} frames, timeline is ${totalFrames} (segments: ${order.map((i) => `${i.kind}:${manifest.entries[i.plan.key]?.frames}`).join(' ')})`);
      }
      report('concat', 1, 1, `${got} frames`);
      return out;
    });

    // 6. audio
    const masterLoud = resolvePreset(MASTER_PRESET_ID, p.delivery.overrides?.[MASTER_PRESET_ID]).loudness;
    const audio = await timed('audio', async () => {
      report('audio', 0, 1);
      const wav = await this.renderAudio(p, sources, totalFrames, paths.tmp, masterLoud, signal);
      report('audio', 1, 1);
      return wav;
    });

    // 7. mux
    const master = uniquePath(path.join(versionDir, `${baseName}.mov`));
    await timed('mux', async () => {
      report('mux', 0, 1);
      const out = tmpFile(paths.tmp, '.mov');
      await run(
        this.tools.ffmpeg,
        [...FF_BASE, '-y', '-i', videoOnly, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'pcm_s24le', '-ar', '48000', '-ac', '2', '-t', sec(totalFrames, fps), out],
        { timeoutMs: 10 * 60_000, signal },
      );
      await moveInto(out, master);
      await rm(videoOnly, { force: true });
      await rm(audio, { force: true });
      report('mux', 1, 1, master);
    });

    const version: Version = {
      id: versionId,
      createdAt: new Date().toISOString(),
      planHash: planHash(p),
      master,
      deliverables: {},
      stats,
    };
    p.versions.push(version);
    await saveProject(p);

    // 8. qc
    if (this.qc && !opts.skipQc) {
      const qc = this.qc;
      await timed('qc', async () => {
        report('qc', 0, 1);
        const starts = clipStartFrames(p);
        version.qc = await qc({
          tools: this.tools,
          signal,
          path: master,
          expectedFrames: totalFrames,
          fps,
          ...(masterLoud ? { loudness: { integratedLufs: masterLoud.integratedLufs, truePeakDb: masterLoud.truePeakDb } } : {}),
          contactSheetPath: uniquePath(path.join(versionDir, `${baseName}_contact.png`)),
          clipStarts: p.timeline.video.map((c) => ({ clipId: c.id, start: starts.get(c.id) ?? 0, dur: c.dur })),
        });
        await saveProject(p);
        report('qc', 1, 1, version.qc.ok ? 'ok' : `${version.qc.issues.length} issue(s)`);
      });
    }

    // 9. deliverables
    if (!opts.skipDeliver && p.delivery.targets.length) {
      await timed('deliver', () => this.deliver(p, versionId, p.delivery.targets, { ...(opts.onProgress ? { onProgress: opts.onProgress } : {}), ...(signal ? { signal } : {}) }));
    }

    stats.timingsMs['total'] = Math.round(performance.now() - t0);
    await saveProject(p);
    return { version, stats };
  }

  // ----- AE comps -----

  private async ensureCompRenders(
    p: Project,
    cacheRenders: string,
    stats: BuildStats,
    report: (stage: string, done: number, total: number, message?: string) => void,
    signal?: AbortSignal,
    force?: boolean,
  ): Promise<void> {
    const used = usedAssetIds(p);
    const comps = Object.values(p.assets).filter((a): a is Extract<Asset, { kind: 'aecomp' }> => a.kind === 'aecomp' && used.has(a.id));
    report('comps', 0, comps.length);
    const fingerprints = new Map<string, Record<string, string>>();
    for (const aep of new Set(comps.map((asset) => asset.aep))) {
      throwIfAborted(signal);
      fingerprints.set(aep, await this.ae.fingerprint(aep, [...new Set(comps.filter((asset) => asset.aep === aep).map((asset) => asset.comp))]));
    }
    let done = 0;
    for (const asset of comps) {
      throwIfAborted(signal);
      const fps = fingerprints.get(asset.aep)?.[asset.comp];
      if (!fps) throw new Error(`comp '${asset.comp}' not found in ${asset.aep}`);
      asset.fingerprint = fps;
      const cached = asset.render && asset.render.fingerprint === fps && existsSync(asset.render.path) && asset.probe;
      if (cached && !force) {
        stats.compsReused++;
        report('comps', ++done, comps.length, `${asset.id}: up to date`);
        continue;
      }
      const target = path.join(cacheRenders, `${asciiStem(asset.id)}_${fps.slice(0, 8)}.mov`);
      let rendered: { path: string; frames: Frames } | undefined;
      if (!force && existsSync(target)) {
        // Same fingerprint already rendered (e.g. project.json was rolled back): adopt it.
        const info = await probe(this.tools, target, { fps: p.meta.fps, signal });
        if (info.hasVideo && info.durationFrames > 0) rendered = { path: target, frames: info.durationFrames };
      }
      if (!rendered) {
        const res = await this.ae.render({ aep: asset.aep, comp: asset.comp, outPath: target, ...(signal ? { signal } : {}) });
        rendered = { path: res.path, frames: res.frames };
        stats.compsRendered++;
      } else {
        stats.compsReused++;
      }
      asset.probe = await probe(this.tools, rendered.path, { fps: p.meta.fps, signal });
      asset.render = { path: rendered.path, frames: asset.probe.durationFrames || rendered.frames, fingerprint: fps, renderedAt: new Date().toISOString() };
      report('comps', ++done, comps.length, `${asset.id}: rendered`);
    }
    if (comps.length) await saveProject(p);
  }

  // ----- sources -----

  private async resolveSources(
    p: Project,
    report: (stage: string, done: number, total: number, message?: string) => void,
    signal?: AbortSignal,
  ): Promise<Map<string, Source>> {
    const used = usedAssetIds(p);
    const out = new Map<string, Source>();
    const ids = [...used];
    report('probe', 0, ids.length);
    let done = 0;
    for (const id of ids) {
      throwIfAborted(signal);
      const a = p.assets[id];
      if (!a) throw new Error(`timeline refers to unknown asset '${id}'`);
      if (a.kind === 'aecomp') {
        if (!a.render || !a.probe) throw new Error(`internal: comp '${id}' has no render`);
        out.set(id, { assetId: id, kind: a.kind, path: a.render.path, probe: a.probe, identity: a.render.fingerprint });
      } else {
        if (!existsSync(a.path)) throw new Error(`asset '${id}' file missing: ${a.path}`);
        a.hash = await hashFile(a.path);
        a.probe = await probe(this.tools, a.path, { fps: p.meta.fps, signal });
        out.set(id, { assetId: id, kind: a.kind, path: a.path, probe: a.probe, identity: a.hash });
      }
      report('probe', ++done, ids.length, id);
    }
    return out;
  }

  // ----- cache -----

  private async cacheHit(manifest: CacheManifest, dir: string, key: string, frames: Frames, signal?: AbortSignal): Promise<boolean> {
    const entry = manifest.entries[key];
    if (entry) {
      if (entry.frames === frames && existsSync(path.join(dir, entry.file)) && await countVideoPackets(this.tools, path.join(dir, entry.file), signal).catch(() => { throwIfAborted(signal); return -1; }) === frames) return true;
      delete manifest.entries[key];
      return false;
    }
    // File present but manifest lost: adopt it when the frame count is right.
    const file = path.join(dir, `${key}.mov`);
    if (!existsSync(file)) return false;
    const n = await countVideoPackets(this.tools, file, signal).catch(() => -1);
    if (n !== frames) return false;
    manifest.entries[key] = { file: path.basename(file), frames, kind: 'segment', mode: 'encode', createdAt: new Date().toISOString() };
    return true;
  }

  // ----- segments -----

  private async renderSegment(p: Project, seg: SegmentPlan, paths: ReturnType<typeof projectPaths>, manifest: CacheManifest, signal?: AbortSignal): Promise<void> {
    const fps = p.meta.fps;
    const final = path.join(paths.cacheSegments, `${seg.key}.mov`);
    await rm(final, { force: true }); // stale/forced cache entry; cache files are regenerable
    const out = tmpFile(paths.tmp, '.mov');
    let mode: CacheEntry['mode'] = 'encode';

    if (await this.canStreamCopy(p, seg.src, seg.clip, signal)) {
      await run(
        this.tools.ffmpeg,
        [...FF_BASE, '-y', '-ss', sec(seg.srcIn, fps), '-i', seg.src.path, '-map', '0:v:0', '-c:v', 'copy', '-an', '-frames:v', String(seg.frames), '-video_track_timescale', String(movTimescale(fps)), out],
        { timeoutMs: encodeTimeout(seg.frames, fps), signal },
      );
      const n = await countVideoPackets(this.tools, out, signal);
      const pts = await firstVideoPtsSec(this.tools, out, signal);
      if (n === seg.frames && Number.isFinite(pts) && Math.abs(pts) < 0.25 / fps) mode = 'copy';
      else await rm(out, { force: true }); // not frame-accurate on this file: re-encode instead
    }
    if (mode === 'encode') {
      await run(this.tools.ffmpeg, this.encodeArgs(p, seg.src, seg.clip, seg.srcIn, seg.frames, out), { timeoutMs: encodeTimeout(seg.frames, fps), signal });
      const n = await countVideoPackets(this.tools, out, signal);
      if (n !== seg.frames) {
        await rm(out, { force: true });
        throw new Error(`segment ${seg.clip.id}: encoded ${n} frames, expected ${seg.frames} (source ${seg.src.path} may be shorter than the clip + handles)`);
      }
    }
    await moveInto(out, final);
    manifest.entries[seg.key] = { file: path.basename(final), frames: seg.frames, kind: 'segment', mode, clipId: seg.clip.id, createdAt: new Date().toISOString() };
  }

  /** Stream copy is frame-accurate only on all-intra ProRes 422 HQ at project size/fps (integer fps). */
  private async canStreamCopy(p: Project, src: Source, clip: Clip, signal?: AbortSignal): Promise<boolean> {
    const pr = src.probe;
    if (src.kind === 'still' || !pr.allIntra || pr.videoCodec !== 'prores') return false;
    if (pr.width !== p.meta.width || pr.height !== p.meta.height) return false;
    if (!Number.isInteger(p.meta.fps) || pr.fps === undefined || Math.abs(pr.fps - p.meta.fps) > 1e-3) return false;
    if ((clip.scale ?? 100) !== 100) return false;
    if (pr.pixFmt && pr.pixFmt !== 'yuv422p10le') return false;
    return (await codecTag(this.tools, src.path, signal)) === 'apch';
  }

  /** ffmpeg args for a ProRes 422 HQ video-only piece of `frames` frames starting at source frame `srcIn`. */
  private encodeArgs(p: Project, src: Source, clip: Clip, srcIn: Frames, frames: Frames, out: string): string[] {
    const fps = p.meta.fps;
    const W = p.meta.width;
    const H = p.meta.height;
    const sw = src.probe.width ?? W;
    const sh = src.probe.height ?? H;
    const fit = fitFilters(sw, sh, W, H, clip.scale ?? 100);
    const args = [...FF_BASE, '-y'];
    if (src.kind === 'still') {
      args.push('-loop', '1', '-framerate', String(fps), '-i', src.path);
      args.push('-vf', [...fit, 'format=yuv422p10le'].join(','));
    } else {
      // shortcut: decode from the start to preserve the fps sampling grid; optimize long-source seeking only with frame-equivalence tests.
      args.push('-i', src.path);
      args.push('-vf', ['setpts=PTS-STARTPTS', `fps=${fpsExpr(fps)}`, `trim=start_frame=${srcIn}:end_frame=${srcIn + frames}`, 'setpts=PTS-STARTPTS', ...fit, 'format=yuv422p10le'].join(','));
    }
    args.push('-map', '0:v:0', '-an', '-frames:v', String(frames), ...PRORES_HQ_ARGS, '-video_track_timescale', String(movTimescale(fps)), out);
    return args;
  }

  // ----- dissolves -----

  private async renderDissolve(p: Project, d: DissolvePlan, paths: ReturnType<typeof projectPaths>, manifest: CacheManifest, signal?: AbortSignal): Promise<void> {
    const fps = p.meta.fps;
    const W = p.meta.width;
    const H = p.meta.height;
    const final = path.join(paths.cacheSegments, `${d.key}.mov`);
    await rm(final, { force: true });
    const out = tmpFile(paths.tmp, '.mov');

    const args = [...FF_BASE, '-y'];
    const chains: string[] = [];
    const side = (src: Source, clip: Clip, srcIn: Frames, label: string) => {
      const fit = fitFilters(src.probe.width ?? W, src.probe.height ?? H, W, H, clip.scale ?? 100);
      const idx = args.filter((x) => x === '-i').length;
      if (src.kind === 'still') {
        args.push('-loop', '1', '-framerate', String(fps), '-i', src.path);
        chains.push(`[${idx}:v:0]${[...fit, 'format=yuv422p10le', `trim=end_frame=${d.n}`, 'setpts=PTS-STARTPTS'].join(',')}[${label}]`);
      } else {
        args.push('-i', src.path);
        chains.push(`[${idx}:v:0]${['setpts=PTS-STARTPTS', `fps=${fpsExpr(fps)}`, `trim=start_frame=${srcIn}:end_frame=${srcIn + d.n}`, 'setpts=PTS-STARTPTS', ...fit, 'format=yuv422p10le'].join(',')}[${label}]`);
      }
    };
    side(d.a.src, d.a.clip, d.aSrcIn, 'va');
    side(d.b.src, d.b.clip, d.bSrcIn, 'vb');
    // Both sides are exactly n frames; offset 0 + duration n -> frame k mixes a*(1-k/n) + b*(k/n).
    chains.push(`[va][vb]xfade=transition=fade:duration=${sec(d.n, fps)}:offset=0[v]`);
    args.push('-filter_complex', chains.join(';'), '-map', '[v]', '-an', '-frames:v', String(d.n), ...PRORES_HQ_ARGS, '-video_track_timescale', String(movTimescale(fps)), out);
    await run(this.tools.ffmpeg, args, { timeoutMs: encodeTimeout(d.n * 2, fps), signal });
    const n = await countVideoPackets(this.tools, out, signal);
    if (n !== d.n) {
      await rm(out, { force: true });
      throw new Error(`dissolve ${d.a.clip.id}->${d.b.clip.id}: got ${n} frames, expected ${d.n} (not enough handle in a source?)`);
    }
    await moveInto(out, final);
    manifest.entries[d.key] = { file: path.basename(final), frames: d.n, kind: 'dissolve', mode: 'encode', createdAt: new Date().toISOString() };
  }

  // ----- audio -----

  private async renderAudio(
    p: Project,
    sources: Map<string, Source>,
    totalFrames: Frames,
    tmpDir: string,
    loud: DeliveryPreset['loudness'],
    signal?: AbortSignal,
  ): Promise<string> {
    const fps = p.meta.fps;
    const D = totalFrames / fps;
    const t = p.timeline;

    // clip audio (camera sound), extended into the handles and cross-faded under dissolves
    const clipPieces = (g: FilterGraph): string[] => {
      if (t.audio.useClipAudio === false) return [];
      const starts = clipStartFrames(p);
      const cutAfter = new Map(t.cuts.map((c) => [c.after, c.dissolve]));
      const labels: string[] = [];
      t.video.forEach((clip, i) => {
        const src = sources.get(clip.src);
        if (!src || !src.probe.hasAudio) return;
        const prev = i > 0 ? t.video[i - 1] : undefined;
        const nPrev = prev ? cutAfter.get(prev.id) ?? 0 : 0;
        const nNext = i < t.video.length - 1 ? cutAfter.get(clip.id) ?? 0 : 0;
        const before = splitDissolve(nPrev); // this clip supplies `a` frames before its in-point
        const after = splitDissolve(nNext); // and `b` frames after its out-point
        const srcStart = Math.max(0, clip.in - before.a);
        const lead = clip.in - srcStart;
        const piece: AudioPiece = {
          input: g.input(src.path),
          startSec: srcStart / fps,
          endSec: (clip.in + clip.dur + after.b) / fps,
          atSec: ((starts.get(clip.id) ?? 0) - lead) / fps,
          gainDb: 0,
        };
        if (nPrev > 0) piece.fadeIn = { sec: nPrev / fps };
        if (nNext > 0) piece.fadeOut = { startSec: (lead + clip.dur - after.a) / fps, sec: nNext / fps };
        labels.push(g.piece(piece));
      });
      return labels;
    };

    const track = (g: FilterGraph, clips: AudioClip[]): string[] =>
      clips.map((c) => {
        const src = sources.get(c.src);
        if (!src) throw new Error(`audio clip '${c.id}' refers to unknown asset '${c.src}'`);
        const inF = c.in ?? 0;
        const srcLen = src.probe.durationFrames > 0 ? src.probe.durationFrames : undefined;
        let dur = c.dur ?? (srcLen !== undefined ? srcLen - inF : totalFrames - c.at);
        dur = Math.min(dur, totalFrames - c.at);
        const piece: AudioPiece = { input: g.input(src.path), startSec: inF / fps, endSec: (inF + dur) / fps, atSec: c.at / fps, gainDb: c.gainDb ?? 0 };
        if (c.fadeIn) piece.fadeIn = { sec: c.fadeIn / fps };
        if (c.fadeOut) piece.fadeOut = { startSec: (dur - c.fadeOut) / fps, sec: c.fadeOut / fps };
        return g.piece(piece);
      });

    const duck = t.audio.duck && t.audio.vo.length && t.audio.music.length ? t.audio.duck : undefined;
    let voLevelDb = -20;
    if (duck) {
      // Measure the VO premix on its own graph so the threshold lands `underDb` below the speech level.
      const gm = new FilterGraph();
      const voOnly = gm.mix(track(gm, t.audio.vo));
      if (voOnly) voLevelDb = await this.measureRms(gm, voOnly, signal);
    }

    const g = new FilterGraph();
    const clipMix = g.mix(clipPieces(g));
    const vo = g.mix(track(g, t.audio.vo));
    const music = g.mix(track(g, t.audio.music));
    const sfx = g.mix(track(g, t.audio.sfx));

    const finalInputs: string[] = [];
    if (clipMix) finalInputs.push(clipMix);
    if (sfx) finalInputs.push(sfx);
    if (duck && vo && music) {
      // Compressor: reduction ~= (level - threshold) * (1 - 1/ratio); solve threshold for the wanted dip.
      const ratio = 20;
      const thresholdDb = Math.max(-60, Math.min(-6, voLevelDb - Math.abs(duck.underDb) / (1 - 1 / ratio)));
      const threshold = Math.pow(10, thresholdDb / 20).toFixed(6);
      const voMain = g.label();
      const voSc = g.label();
      const voScPad = g.label();
      const musicPad = g.label();
      const ducked = g.label();
      const pad = `apad=whole_dur=${D.toFixed(6)},atrim=end=${D.toFixed(6)}`;
      g.add(`[${vo}]asplit=2[${voMain}][${voSc}]`);
      g.add(`[${voSc}]${pad}[${voScPad}]`);
      g.add(`[${music}]${pad}[${musicPad}]`);
      g.add(`[${musicPad}][${voScPad}]sidechaincompress=threshold=${threshold}:ratio=${ratio}:attack=${Math.max(0.01, duck.attackMs)}:release=${Math.max(0.01, duck.releaseMs)}:makeup=1:detection=rms[${ducked}]`);
      finalInputs.push(voMain, ducked);
    } else {
      if (vo) finalInputs.push(vo);
      if (music) finalInputs.push(music);
    }

    const raw = tmpFile(tmpDir, '.wav');
    const args = [...FF_BASE, '-y'];
    const mixed = g.mix(finalInputs);
    if (!mixed) {
      args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', D.toFixed(6));
    } else {
      for (const f of g.inputs) args.push('-i', f);
      g.add(`[${mixed}]apad=whole_dur=${D.toFixed(6)},atrim=end=${D.toFixed(6)}[out]`);
      args.push('-filter_complex', g.toString(), '-map', '[out]');
    }
    args.push('-c:a', 'pcm_s24le', '-ar', '48000', '-ac', '2', raw);
    await run(this.tools.ffmpeg, args, { timeoutMs: 20 * 60_000, signal });

    if (!loud) return raw;
    const target = { integratedLufs: loud.integratedLufs, truePeakDb: loud.truePeakDb, lra: loud.lra ?? 7 };
    const m = await measureLoudnorm(this.tools, raw, target, signal);
    if (!m) return raw; // silence: nothing to normalise
    const normalized = tmpFile(tmpDir, '.wav');
    await run(this.tools.ffmpeg, [...FF_BASE, '-y', '-i', raw, '-af', loudnormPass2(m, target), '-c:a', 'pcm_s24le', '-ar', '48000', '-ac', '2', normalized], { timeoutMs: 20 * 60_000, signal });
    await rm(raw, { force: true });
    return normalized;
  }

  /** Speech level estimate (dBFS) of one graph label: overall RMS, floored at RMS peak - 6 dB. */
  private async measureRms(g: FilterGraph, label: string, signal?: AbortSignal): Promise<number> {
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'info'];
    for (const f of g.inputs) args.push('-i', f);
    g.add(`[${label}]astats=measure_perchannel=none:measure_overall=RMS_level+RMS_peak[m]`);
    args.push('-filter_complex', g.toString(), '-map', '[m]', '-f', 'null', '-');
    const { stderr } = await run(this.tools.ffmpeg, args, { timeoutMs: 10 * 60_000, signal });
    const grab = (k: string): number => {
      const m = new RegExp(`${k}:\\s*(-?[\\d.]+|-inf)`).exec(stderr);
      return m && m[1] !== '-inf' ? Number(m[1]) : Number.NEGATIVE_INFINITY;
    };
    const v = Math.max(grab('RMS level dB'), grab('RMS peak dB') - 6);
    return Number.isFinite(v) ? v : -20;
  }

  // ----- deliver -----

  async deliver(
    p: Project,
    versionId: string,
    targets: DeliveryTargetId[],
    opts: { onProgress?: (p: Progress) => void; signal?: AbortSignal } = {},
  ): Promise<Record<string, string>> {
    const version = p.versions.find((v) => v.id === versionId);
    if (!version) throw new Error(`unknown version ${versionId}`);
    if (!existsSync(version.master)) throw new Error(`master missing: ${version.master}`);
    const paths = projectPaths(p);
    const fps = p.meta.fps;
    const masterLoud = resolvePreset(MASTER_PRESET_ID, p.delivery.overrides?.[MASTER_PRESET_ID]).loudness;
    const masterProbe = await probe(this.tools, version.master, { fps, signal: opts.signal });
    const mw = masterProbe.width ?? p.meta.width;
    const mh = masterProbe.height ?? p.meta.height;
    const out: Record<string, string> = {};
    const baseName = `${sanitizeName(p.meta.name, 'master')}_${versionId}`;
    let done = 0;
    opts.onProgress?.({ stage: 'deliver', done: 0, total: targets.length });

    for (const target of targets) {
      throwIfAborted(opts.signal);
      const preset = resolvePreset(target, p.delivery.overrides?.[target]);
      const tfps = preset.video.fps ?? fps;
      const W = preset.video.width;
      const H = preset.video.height;
      const enc = presetToFfmpegArgs(preset, this.env, { width: W, height: H, fps: tfps });

      const vf: string[] = [];
      // 50p master -> 25i: weave field pairs; 25p master -> 25i: PsF (flag fields, keep every frame).
      if (preset.video.interlaced && Math.abs(fps - tfps * 2) < 0.01) vf.push('tinterlace=interleave_top');
      else if (Math.abs(tfps - fps) > 1e-3) vf.push(`fps=${fpsExpr(tfps)}`);
      const sameAspect = Math.abs(W / H - mw / mh) < 0.01;
      if (W !== mw || H !== mh) {
        vf.push(sameAspect ? `scale=${W}:${H}:flags=lanczos` : `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}`);
      }
      if (preset.video.interlaced && !vf.includes('tinterlace=interleave_top')) vf.push('setfield=tff');
      vf.push('setsar=1');

      const args = [...FF_BASE, '-y', '-i', version.master, '-map', '0:v:0', '-map', '0:a:0?', '-vf', vf.join(','), ...enc.videoArgs];
      if (preset.loudness && !sameLoudness(preset.loudness, masterLoud)) {
        const t = { integratedLufs: preset.loudness.integratedLufs, truePeakDb: preset.loudness.truePeakDb, lra: preset.loudness.lra ?? 7 };
        const key = hashJson({ master: version.master, target: t });
        if (!this.loudnessCache.has(key)) this.loudnessCache.set(key, await measureLoudnorm(this.tools, version.master, t, opts.signal));
        const m = this.loudnessCache.get(key);
        if (m) args.push('-af', loudnormPass2(m, t));
      }
      args.push(...enc.audioArgs);
      const versionDir = path.join(paths.out, versionId);
      await mkdir(versionDir, { recursive: true });
      const final = uniquePath(path.join(versionDir, `${baseName}_${preset.id}.${enc.ext}`));
      const tmp = tmpFile(paths.tmp, `.${enc.ext}`);
      args.push(tmp);
      const cpu = presetToFfmpegArgs({ ...preset, video: { ...preset.video, useGpu: false } }, this.env, { width: W, height: H, fps: tfps });
      await this.encode(args, enc.videoArgs, cpu.videoArgs, encodeTimeout(masterProbe.durationFrames, fps), opts.signal);
      await moveInto(tmp, final);
      out[target] = final;
      version.deliverables[target] = final;
      await saveProject(p);
      opts.onProgress?.({ stage: 'deliver', done: ++done, total: targets.length, message: `${target}: ${final}` });
    }
    return out;
  }

  // ----- review proxy -----

  async reviewProxy(p: Project, versionId: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
    const version = p.versions.find((v) => v.id === versionId);
    if (!version) throw new Error(`unknown version ${versionId}`);
    const paths = projectPaths(p);
    const dir = path.join(paths.review, versionId);
    await mkdir(dir, { recursive: true });
    const final = uniquePath(path.join(dir, `${sanitizeName(p.meta.name, 'master')}_${versionId}_review.mp4`));
    const tmp = tmpFile(paths.tmp, '.mp4');
    const gpu = this.env.encoders.h264_nvenc;
    const vcodec = gpu ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '26', '-b:v', '0'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23'];
    const h = Math.min(540, p.meta.height);
    await this.encode(
      [...FF_BASE, '-y', '-i', version.master, '-map', '0:v:0', '-map', '0:a:0?', '-vf', `scale=-2:${h}:flags=bicubic,setsar=1`, ...vcodec, '-pix_fmt', 'yuv420p', '-g', String(Math.round(p.meta.fps) * 2), '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', tmp],
      vcodec, ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23'], encodeTimeout(timelineFrames(p), p.meta.fps), opts.signal,
    );
    await moveInto(tmp, final);
    version.reviewProxy = final;
    await saveProject(p);
    return final;
  }
}

// ---------- planning (pure) ----------

function usedAssetIds(p: Project): Set<string> {
  const used = new Set<string>();
  for (const c of p.timeline.video) used.add(c.src);
  for (const c of [...p.timeline.audio.vo, ...p.timeline.audio.music, ...p.timeline.audio.sfx]) used.add(c.src);
  return used;
}

/** Segment / dissolve plans + concat order. Exported for tests; pure. */
export function planTimeline(p: Project, sources: Map<string, Source>): { segments: SegmentPlan[]; dissolves: DissolvePlan[]; order: ConcatItem[] } {
  const t = p.timeline;
  const fps = p.meta.fps;
  const cutAfter = new Map(t.cuts.map((c) => [c.after, c.dissolve]));
  const segments: SegmentPlan[] = t.video.map((clip, i) => {
    const src = sources.get(clip.src);
    if (!src) throw new Error(`clip '${clip.id}': unknown asset '${clip.src}'`);
    if (!src.probe.hasVideo) throw new Error(`clip '${clip.id}': asset '${clip.src}' has no video`);
    const prev = i > 0 ? t.video[i - 1] : undefined;
    const nPrev = prev ? cutAfter.get(prev.id) ?? 0 : 0;
    const nNext = i < t.video.length - 1 ? cutAfter.get(clip.id) ?? 0 : 0;
    const trimStart = splitDissolve(nPrev).b; // the dissolve before us owns our first b frames
    const trimEnd = splitDissolve(nNext).a; // the dissolve after us owns our last a frames
    const frames = clip.dur - trimStart - trimEnd;
    if (frames <= 0) throw new Error(`clip '${clip.id}': dissolves (${trimStart}+${trimEnd}) leave no body in ${clip.dur} frames`);
    const key = hashJson({
      schema: 2, // Invalidate old midpoint-seek segments after fixing the project-frame sampling grid.
      src: src.identity, in: clip.in, dur: clip.dur, scale: clip.scale ?? 100,
      w: p.meta.width, h: p.meta.height, fps, handlesBefore: trimStart, handlesAfter: trimEnd,
    });
    return { clip, index: i, src, key, srcIn: clip.in + trimStart, frames, trimStart, trimEnd };
  });

  const dissolves: DissolvePlan[] = [];
  const order: ConcatItem[] = [];
  segments.forEach((seg, i) => {
    order.push({ kind: 'segment', plan: seg });
    const next = segments[i + 1];
    if (!next) return;
    const n = cutAfter.get(seg.clip.id) ?? 0;
    if (n <= 0) return;
    const half = splitDissolve(n);
    const d: DissolvePlan = {
      a: seg, b: next, n, half,
      key: hashJson({ a: seg.key, b: next.key, n }),
      aSrcIn: seg.clip.in + seg.clip.dur - half.a,
      bSrcIn: next.clip.in - half.a,
    };
    if (d.bSrcIn < 0 && next.src.kind !== 'still') throw new Error(`cut ${seg.clip.id}->${next.clip.id}: dissolve ${n} needs ${half.a} frame(s) before '${next.clip.id}' in`);
    dissolves.push(d);
    order.push({ kind: 'dissolve', plan: d });
  });
  return { segments, dissolves, order };
}

/** concat demuxer path: forward slashes, single-quoted, embedded quotes escaped. */
function concatQuote(file: string): string {
  return `'${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
}

// ---------- manifest ----------

async function loadManifest(dir: string): Promise<CacheManifest> {
  try {
    const raw = await readFile(path.join(dir, 'manifest.json'), 'utf8');
    const m = JSON.parse(raw) as Partial<CacheManifest>;
    if (m.schema === 1 && m.entries && typeof m.entries === 'object') return { schema: 1, entries: m.entries };
  } catch { /* missing or corrupt: start fresh; files are re-adopted by frame count */ }
  return { schema: 1, entries: {} };
}

async function writeManifest(dir: string, m: CacheManifest): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.manifest.${process.pid}.${randomBytes(3).toString('hex')}.tmp`);
  await writeFile(tmp, `${JSON.stringify(m, null, 2)}\n`, 'utf8');
  await rename(tmp, path.join(dir, 'manifest.json'));
}

// ---------- small async pool ----------

async function parallel<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed: unknown;
  const worker = async () => {
    while (next < items.length && failed === undefined) {
      const item = items[next++] as T;
      try {
        await fn(item);
      } catch (e) {
        failed = e ?? new Error('unknown failure');
        throw e;
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  const results = await Promise.allSettled(workers);
  const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (rejected) throw rejected.reason;
}
