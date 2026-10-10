/**
 * aerender wrapper. Renders a comp (or a single frame) through Adobe's aerender.exe
 * WITHOUT ever touching a running After Effects GUI.
 *
 * - Output goes to an ASCII temp name first (AE 25.2–26.x mangles non-ASCII output
 *   file names set from scripts/CLI), then is renamed to the requested path.
 * - Never overwrites: an existing target gets a `_2`, `_3`… suffix.
 * - Every process spawn goes through an injectable `spawn` (default: execa) so tests
 *   can fake aerender while still running real ffmpeg/ffprobe.
 * - Timeout / abort → the whole process tree is killed (taskkill /T /F on Windows).
 */
import { execa } from 'execa';
import { constants, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { copyFile, link, unlink } from 'node:fs/promises';
import os from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Frames, Progress, RenderRequest, RenderResult, ToolPaths } from '../core/types.js';
import { tcToFrames } from '../core/timecode.js';

export type SpawnFn = typeof execa;

export interface AerenderRequest extends RenderRequest {
  omTemplate: string;
  rsTemplate: string;
  /**
   * Comp displayStartFrame. startFrame/endFrame are 0-based comp frames; aerender's -s/-e are
   * numbered from the comp's display start, so the offset is added when building args.
   */
  frameOffset?: Frames;
  /** omTemplate is a non-ProRes fallback ('Lossless'): transcode the result to ProRes 422 HQ with ffmpeg. */
  fallback?: boolean;
  timeoutMs?: number;
  /** Warn (default) or refuse (`strictRam`) when free RAM is below this many GB. */
  minFreeRamGb?: number;
  strictRam?: boolean;
}

export interface AerenderOptions {
  spawn?: SpawnFn;
  /** Max parallel aerender processes (default 1, or EDITMCP_AE_PARALLEL). */
  maxParallel?: number;
}

export type AerenderFailure = 'exit' | 'timeout' | 'abort' | 'output' | 'frames';

/** Structured aerender failure: callers decide on fallbacks from `reason` + aerender's own error lines. */
export class AerenderError extends Error {
  constructor(message: string, readonly reason: AerenderFailure, readonly errors: string[]) {
    super(message);
    this.name = 'AerenderError';
  }
}

/**
 * True only when aerender exited reporting that the requested output-module template does not exist.
 * Matches aerender's ERROR lines (never the echoed command line), with quoted text and the given
 * user strings (comp name, project path, template name) removed first so names cannot trigger it.
 */
export function isMissingOmTemplate(error: unknown, userStrings: string[] = []): boolean {
  if (!(error instanceof AerenderError) || error.reason !== 'exit') return false;
  return error.errors.some((line) => {
    let l = line;
    for (const s of userStrings) if (s) l = l.split(s).join(' ');
    l = l.replace(/"[^"]*"|'[^']*'|“[^”]*”/g, ' ');
    return /output[- ]module template/i.test(l)
      && /\bno output[- ]module template\b|\b(?:not|never) (?:been )?found\b|could not be found|does not exist|unable to find/i.test(l);
  });
}

/** -mfr percentage for builds: 90 per the design, scaled down when free RAM is low. */
export function defaultMfrPercent(freeGb: number = os.freemem() / 2 ** 30): number {
  if (freeGb >= 16) return 90;
  if (freeGb >= 8) return 70;
  if (freeGb >= 4) return 50;
  return 25;
}

const IMAGE_EXT = new Set(['.png', '.tif', '.tiff', '.jpg', '.jpeg', '.psd', '.exr', '.dpx', '.tga', '.bmp']);
const MAX_LOG_LINES = 4000;

// ---------- small helpers (exported for ae.ts and tests) ----------

export function isAscii(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7f]*$/.test(s);
}

/** `path` if it does not exist, else `base_2.ext`, `base_3.ext`… — never overwrite. */
export function uniqueOutputPath(path: string): string {
  if (!existsSync(path)) return path;
  const dir = dirname(path);
  const ext = extname(path);
  const stem = basename(path, ext);
  for (let n = 2; n < 10_000; n++) {
    const cand = join(dir, `${stem}_${n}${ext}`);
    if (!existsSync(cand)) return cand;
  }
  throw new Error(`cannot find a free output name for ${path}`);
}

/**
 * ASCII temp path for an AE render. Same directory when that directory is ASCII,
 * otherwise the OS temp dir. For image outputs the name carries the `[#####]` sequence token.
 */
export function asciiTempPath(outPath: string): { tmp: string; sequence: boolean; prefix: string; dir: string } {
  const ext = extname(outPath).toLowerCase() || '.mov';
  const dir = isAscii(dirname(outPath)) ? dirname(outPath) : join(os.tmpdir(), 'editmcp-ae');
  if (!isAscii(dir)) throw new Error('After Effects requires an ASCII TEMP directory');
  mkdirSync(dir, { recursive: true });
  const safeStem = basename(outPath, extname(outPath)).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'render';
  const prefix = `aer_${randomBytes(4).toString('hex')}_${safeStem}`;
  const sequence = IMAGE_EXT.has(ext);
  const tmp = sequence ? join(dir, `${prefix}_[#####]${ext}`) : join(dir, `${prefix}${ext}`);
  return { tmp, sequence, prefix, dir };
}

/** rename, falling back to copy+unlink across volumes. Target must not exist. */
export async function moveFile(from: string, to: string): Promise<void> {
  if (existsSync(to)) throw new Error(`refusing to overwrite ${to}`);
  mkdirSync(dirname(to), { recursive: true });
  try {
    await link(from, to);
    await unlink(from);
  } catch (e) {
    if (!['EXDEV', 'EPERM', 'ENOTSUP'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
    await copyFile(from, to, constants.COPYFILE_EXCL);
    await unlink(from);
  }
}

/** Kill a process and all its children. */
export async function killTree(pid: number | undefined, spawn: SpawnFn, child?: { kill?: (s?: 'SIGKILL') => unknown }): Promise<void> {
  if (pid && process.platform === 'win32') {
    try {
      await spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { reject: false, windowsHide: true, timeout: 10_000 });
    } catch { /* already gone */ }
  }
  try { child?.kill?.('SIGKILL'); } catch { /* ignore */ }
}

/** Video frame count via ffprobe (packets; for all-intra codecs packets == frames). */
export async function probeFrameCount(tools: ToolPaths, path: string, spawn: SpawnFn = execa, signal?: AbortSignal): Promise<Frames> {
  const r = await spawn(tools.ffprobe, [
    '-v', 'error', '-select_streams', 'v:0', '-count_packets',
    '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', path,
  ], { reject: false, windowsHide: true, timeout: 120_000, cancelSignal: signal });
  const n = parseInt(String(r.stdout).trim(), 10);
  if (r.exitCode !== 0 || !Number.isFinite(n)) throw new Error(`ffprobe could not count frames of ${path}: ${r.stderr}`);
  return n;
}

/**
 * Full comp render: ProRes 422 HQ with optional PCM audio; segment assembly strips audio later.
 * AE's Lossless output is RGB: convert with the BT.709 matrix into limited range and tag the stream,
 * otherwise swscale defaults to BT.601 and players shift every hue.
 */
export async function transcodeToProres(tools: ToolPaths, src: string, dst: string, spawn: SpawnFn = execa, signal?: AbortSignal): Promise<void> {
  const r = await spawn(tools.ffmpeg, [
    '-hide_banner', '-nostdin', '-n', '-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-c:a', 'pcm_s24le', '-ar', '48000', '-ac', '2',
    // setparams tags the frames themselves; newer ffmpeg takes stream color info from frames over -color_* flags.
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv422p10le,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
    '-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    dst,
  ], { reject: false, windowsHide: true, timeout: 4 * 60 * 60_000, cancelSignal: signal });
  if (r.exitCode !== 0 || !existsSync(dst)) throw new Error(`ffmpeg ProRes transcode failed: ${r.stderr}`);
}

// ---------- concurrency gate ----------

class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private readonly max: number) {}
  async acquire(): Promise<() => void> {
    if (this.active < this.max) { this.active++; return () => this.release(); }
    await new Promise<void>((res) => this.queue.push(res));
    return () => this.release();
  }
  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }
}
const gates = new Map<number, Semaphore>();
function gate(max: number): Semaphore {
  let g = gates.get(max);
  if (!g) { g = new Semaphore(max); gates.set(max, g); }
  return g;
}

// ---------- progress parsing ----------

const RE_FRAME = /^PROGRESS:\s+(-?\d+:\d+:\d+:\d+)\s+\((\d+)\)/;
const RE_DURATION = /^PROGRESS:\s+Duration:\s+(\d+:\d+:\d+:\d+)/;
const RE_FPS = /^PROGRESS:\s+Frame Rate:\s+([\d.]+)/;

export interface ProgressParser {
  feed(line: string): Progress | undefined;
  readonly total: number | undefined;
  readonly done: number;
  readonly errors: string[];
}

export function createProgressParser(knownTotal?: number): ProgressParser {
  let fps: number | undefined;
  let durationTc: string | undefined;
  let total = knownTotal;
  let done = 0;
  const errors: string[] = [];
  return {
    get total() { return total; },
    get done() { return done; },
    errors,
    feed(line: string): Progress | undefined {
      const l = line.trim();
      if (!l) return undefined;
      if (/aerender ERROR/i.test(l) || /^ERROR:/i.test(l)) errors.push(l);
      let m = RE_FPS.exec(l);
      if (m) { fps = parseFloat(m[1]!); if (durationTc && total === undefined) total = tcToFrames(durationTc, fps); return undefined; }
      m = RE_DURATION.exec(l);
      if (m) { durationTc = m[1]!; if (fps && total === undefined) total = tcToFrames(durationTc, fps); return undefined; }
      m = RE_FRAME.exec(l);
      if (m) {
        done = parseInt(m[2]!, 10);
        return { stage: 'aerender', done, total: total ?? Math.max(done, 1), message: m[1] };
      }
      return undefined;
    },
  };
}

// ---------- main ----------

function buildArgs(req: AerenderRequest, tmpOut: string): string[] {
  // Always an explicit range: otherwise the RS template's time span (often "Work Area Only") decides.
  const offset = req.frameOffset ?? 0;
  const args = ['-project', req.aep, '-comp', req.comp, '-RStemplate', req.rsTemplate, '-OMtemplate', req.omTemplate, '-output', tmpOut,
    '-s', String(offset + req.startFrame!), '-e', String(offset + req.endFrame!)];
  if (req.mfrPercent !== undefined) args.push('-mfr', 'ON', String(Math.max(1, Math.min(100, Math.round(req.mfrPercent)))));
  args.push('-close', 'DO_NOT_SAVE_CHANGES', '-sound', 'OFF');
  return args;
}

function findSequenceFiles(dir: string, prefix: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.startsWith(prefix) && !f.includes('[')).map((f) => join(dir, f)).sort();
  } catch { return []; }
}

/** AE may change the extension to match the OM format (e.g. Lossless → .avi). Find what it wrote. */
function findRenderedFile(tmp: string, prefix: string, dir: string): string | undefined {
  if (existsSync(tmp)) return tmp;
  const cands = findSequenceFiles(dir, prefix);
  return cands[0];
}

/** Delete every partial aer_<random>_* file of a failed render (AE may still hold it briefly). */
async function removeTempOutputs(dir: string, prefix: string): Promise<void> {
  let names: string[];
  try { names = readdirSync(dir).filter((f) => f.startsWith(prefix)); } catch { return; }
  for (const name of names) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try { await unlink(join(dir, name)); break; } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || attempt === 4) break;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
}

/**
 * Render with aerender. Resolves to the final (renamed) path; rejects loudly when the exit code,
 * the output file or the frame count is not what was asked for.
 * startFrame/endFrame (0-based, inclusive) are required: the expected frame count comes from the
 * caller's comp duration, never from aerender's own "Duration" line.
 */
export async function aerender(tools: ToolPaths, req: AerenderRequest, opts: AerenderOptions = {}): Promise<RenderResult> {
  const spawn: SpawnFn = opts.spawn ?? execa;
  if (!tools.aerender) throw new Error('aerender.exe not found (ToolPaths.aerender). Install After Effects or set EDITMCP_AE_DIR.');
  if (!existsSync(req.aep)) throw new Error(`project not found: ${req.aep}`);
  const { startFrame, endFrame } = req;
  if (startFrame === undefined || endFrame === undefined || !Number.isInteger(startFrame) || !Number.isInteger(endFrame) || startFrame < 0) {
    throw new Error('aerender needs an explicit non-negative integer startFrame/endFrame (0-based comp frames)');
  }
  if (endFrame < startFrame) throw new Error(`endFrame ${endFrame} < startFrame ${startFrame}`);

  const maxParallel = opts.maxParallel ?? Math.max(1, parseInt(process.env['EDITMCP_AE_PARALLEL'] ?? '1', 10) || 1);
  const release = await gate(maxParallel).acquire();
  const t0 = Date.now();
  const log: string[] = [];
  const pushLog = (l: string) => { if (log.length < MAX_LOG_LINES) log.push(l); };
  let temp: { dir: string; prefix: string } | undefined;

  try {
    req.signal?.throwIfAborted();
    const freeGb = os.freemem() / 2 ** 30;
    const minFree = req.minFreeRamGb ?? 0.75;
    if (freeGb < minFree) {
      const msg = `low free RAM: ${freeGb.toFixed(2)} GB (< ${minFree} GB)`;
      if (req.strictRam) throw new Error(msg);
      pushLog(`WARN ${msg}`);
    }

    const { tmp, sequence, prefix, dir } = asciiTempPath(req.outPath);
    temp = { dir, prefix };
    const args = buildArgs(req, tmp);
    pushLog(`$ aerender ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);

    const expected: Frames = endFrame - startFrame + 1;
    const parser = createProgressParser(expected);
    const onLine = (line: string) => {
      pushLog(line);
      const p = parser.feed(line);
      if (p) req.onProgress?.(p);
    };

    // Arguments are an array and no shell is used, so Thai comp names / project paths pass through verbatim.
    const child = spawn(tools.aerender, args, {
      reject: false, windowsHide: true, timeout: 0, stripFinalNewline: false,
    }) as unknown as PromiseLike<{ exitCode?: number; stdout?: unknown; stderr?: unknown; timedOut?: boolean; isCanceled?: boolean }>
      & { pid?: number; kill?: (s?: string) => unknown; stdout?: NodeJS.ReadableStream | null; stderr?: NodeJS.ReadableStream | null };

    // Stream stdout lines when the spawn gives us a stream (execa does; fakes may not).
    let streamed = false;
    for (const s of [child.stdout, child.stderr]) {
      if (s && typeof (s as NodeJS.ReadableStream).on === 'function') {
        streamed = true;
        let buf = '';
        s.on('data', (chunk: Buffer | string) => {
          buf += chunk.toString();
          let i: number;
          while ((i = buf.search(/\r\n|\n|\r/)) >= 0) {
            onLine(buf.slice(0, i));
            buf = buf.slice(i + (buf[i] === '\r' && buf[i + 1] === '\n' ? 2 : 1));
          }
        });
        s.on('end', () => { if (buf) onLine(buf); });
      }
    }

    let killed: 'timeout' | 'abort' | undefined;
    const timeoutMs = req.timeoutMs ?? 4 * 60 * 60 * 1000;
    const timer = timeoutMs > 0 ? setTimeout(() => { killed = 'timeout'; void killTree(child.pid, spawn, child); }, timeoutMs) : undefined;
    const onAbort = () => { killed = 'abort'; void killTree(child.pid, spawn, child); };
    req.signal?.addEventListener('abort', onAbort, { once: true });

    let res: { exitCode?: number; stdout?: unknown; stderr?: unknown };
    try {
      res = await child;
    } finally {
      if (timer) clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }
    if (!streamed) {
      for (const text of [res.stdout, res.stderr]) {
        if (typeof text === 'string') for (const line of text.split(/\r?\n/)) onLine(line);
      }
    }
    if (killed) {
      throw new AerenderError(`aerender ${killed === 'timeout' ? `timed out after ${timeoutMs} ms` : 'aborted'} (process tree killed)\n${tail(log)}`, killed, parser.errors);
    }
    if (res.exitCode !== 0) {
      throw new AerenderError(`aerender exited with code ${res.exitCode}${parser.errors.length ? ': ' + parser.errors.join(' | ') : ''}\n${tail(log)}`, 'exit', parser.errors);
    }

    // Locate what AE wrote.
    let produced: string | undefined;
    let frames: Frames;
    if (sequence) {
      const files = findSequenceFiles(dir, prefix);
      if (files.length === 0) throw new AerenderError(`aerender produced no frames in ${dir}\n${tail(log)}`, 'output', parser.errors);
      if (files.length !== expected) throw new AerenderError(`aerender frame count mismatch: got ${files.length} images, expected ${expected} (${req.comp})\n${tail(log)}`, 'frames', parser.errors);
      if (files.length > 1) throw new AerenderError('image-sequence output supports a single frame only', 'output', parser.errors);
      produced = files[0]!;
      frames = 1;
    } else {
      produced = findRenderedFile(tmp, prefix, dir);
      if (!produced) throw new AerenderError(`aerender produced no output file (${tmp})${parser.errors.length ? ': ' + parser.errors.join(' | ') : ''}\n${tail(log)}`, 'output', parser.errors);
      if (req.fallback) {
        const prores = join(dir, `${prefix}_prores.mov`);
        pushLog(`fallback: transcoding ${basename(produced)} → ProRes 422 HQ (BT.709)`);
        await transcodeToProres(tools, produced, prores, spawn, req.signal);
        await unlink(produced).catch(() => undefined);
        produced = prores;
      }
      frames = await probeFrameCount(tools, produced, spawn, req.signal);
      if (frames !== expected) {
        throw new AerenderError(`aerender frame count mismatch: got ${frames}, expected ${expected} (${req.comp})\n${tail(log)}`, 'frames', parser.errors);
      }
    }

    // Final name: requested path (may be Thai), never overwriting.
    const finalPath = uniqueOutputPath(req.outPath);
    if (sequence && extname(produced).toLowerCase() !== extname(finalPath).toLowerCase()) {
      // Format differs (e.g. TIFF template asked to produce .png): caller converts; keep AE's extension.
      const alt = uniqueOutputPath(finalPath.slice(0, -extname(finalPath).length) + extname(produced));
      await moveFile(produced, alt);
      return { path: alt, frames, elapsedMs: Date.now() - t0, usedFallback: !!req.fallback, log: log.join('\n') };
    }
    await moveFile(produced, finalPath);
    pushLog(`→ ${finalPath} (${frames} frames, ${statSync(finalPath).size} bytes)`);
    return { path: finalPath, frames, elapsedMs: Date.now() - t0, usedFallback: !!req.fallback, log: log.join('\n') };
  } catch (error) {
    if (temp) await removeTempOutputs(temp.dir, temp.prefix);
    throw error;
  } finally {
    release();
  }
}

function tail(log: string[], n = 15): string {
  return log.slice(-n).join('\n');
}
