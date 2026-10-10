import { execa } from 'execa';
import { constants, existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { AeBackend, AeEditRequest, AeEditResult, CompDetail, CompInfo, Frames, RenderRequest, ToolPaths } from '../core/types.js';
import { hashFile, hashJson } from '../core/hash.js';
import { aerender, defaultMfrPercent, isAscii, isMissingOmTemplate, killTree, moveFile, uniqueOutputPath, type SpawnFn } from './aerender.js';

export interface AeProcess { name: string; pid: number; title: string }

interface AeOptions {
  spawn?: SpawnFn;
  /** Per-call AfterFX timeout for list/version (default 2 min). */
  timeoutMs?: number;
  /** Timeout for jobs that snapshot whole comps: fingerprint, inspect, edit (default 10 min; big projects are slow). */
  fingerprintTimeoutMs?: number;
  minFreeRamGb?: number;
  /** Running processes named AfterFX.exe (injectable for tests; default: tasklist on Windows). */
  listProcesses?: () => Promise<AeProcess[]>;
}
interface Detail extends CompInfo { layers: CompDetail['layers']; snapshot: unknown }
interface Result<T> { ok: boolean; data: T; log?: string[]; error?: string }
/** Comp timing as the runner reports it; displayStartFrame offsets aerender's -s/-e. */
interface CompTiming { durationFrames: Frames; displayStartFrame: Frames }

export interface FingerprintDetail {
  hash: string;
  /** The comp contains values scripting cannot read (Curves/Levels custom data, per-character text styles). */
  opaque: boolean;
}

export interface AeEditOutcome extends AeEditResult {
  /** An After Effects GUI was running during an in-place edit; its next save may revert this edit. */
  aeGuiRunning: boolean;
  warning?: string;
}

export interface HeadlessAeBackend extends AeBackend {
  edit(req: AeEditRequest): Promise<AeEditOutcome>;
  /** Like fingerprint, plus which comps contain values that cannot be fingerprinted. */
  fingerprintDetailed(aep: string, comps?: string[]): Promise<Record<string, FingerprintDetail>>;
}

// One Adobe process at a time, including renders, across backend instances.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn);
  queue = result.catch(() => undefined);
  return result;
}

/** AfterFX.exe processes via `tasklist /V` (window title separates a GUI from -noui instances). */
export async function listAfterFxProcesses(spawn: SpawnFn = execa): Promise<AeProcess[]> {
  if (process.platform !== 'win32') return [];
  const r = await spawn('tasklist', ['/V', '/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq AfterFX.exe'], { reject: false, windowsHide: true, timeout: 15_000 });
  const out: AeProcess[] = [];
  for (const line of String(r.stdout ?? '').split(/\r?\n/)) {
    const cells = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"'));
    if (cells.length < 2 || !/^afterfx\.exe$/i.test(cells[0]!)) continue;
    out.push({ name: cells[0]!, pid: Number(cells[1]), title: cells.length >= 9 ? cells[cells.length - 1]! : '' });
  }
  return out;
}

function guiWindows(procs: AeProcess[]): AeProcess[] {
  return procs.filter((p) => p.title && !/^n\/a$/i.test(p.title.trim()));
}

export function createAeBackend(tools: ToolPaths, opts: AeOptions = {}): HeadlessAeBackend {
  const spawn = opts.spawn ?? execa;
  const runner = fileURLToPath(new URL('../../jsx/runner.jsx', import.meta.url));
  const listProcesses = opts.listProcesses ?? (() => listAfterFxProcesses(spawn));
  const shortTimeout = opts.timeoutMs ?? 120_000;
  const longTimeout = opts.fingerprintTimeoutMs ?? Math.max(shortTimeout, 600_000);
  // Comp timing per project, valid while the .aep hash is unchanged (filled by every job that reads comps).
  const timings = new Map<string, { stamp: string; comps: Map<string, CompTiming | 'ambiguous'> }>();

  async function run<T>(action: string, payload: Record<string, unknown> = {}): Promise<Result<T>> {
    if (!tools.afterfx) throw new Error('AfterFX not found; install After Effects or set EDITMCP_AE_DIR');
    const minRam = opts.minFreeRamGb ?? 0.75;
    if (os.freemem() / 2 ** 30 < minRam) throw new Error(`not enough free RAM for After Effects (need ${minRam} GB)`);
    const tempRoot = os.tmpdir();
    if (!isAscii(tempRoot)) throw new Error('After Effects needs an ASCII TEMP directory; set TEMP/TMP to an ASCII path');
    const dir = await mkdtemp(join(tempRoot, 'editmcp-ae-'));
    try {
      const jobPath = join(dir, 'job.json');
      // Same name the runner derives from the job path when the job itself cannot be read.
      const resultPath = join(dir, 'job.result.json');
      await writeFile(jobPath, JSON.stringify({ ...payload, action, result: resultPath }).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'), 'utf8');
      const launcher = join(dir, 'launch.jsx');
      // Only generated paths are embedded in JSX; user values go through the UTF-8 JSON job.
      await writeFile(launcher, `var EDITMCP_JOB = ${JSON.stringify(jobPath)};\n$.evalFile(new File(${JSON.stringify(runner)}));\n`, 'utf8');
      const timeoutMs = action === 'list' || action === 'version' ? shortTimeout : longTimeout;
      const child = spawn(tools.afterfx, ['-m', '-noui', '-r', launcher], { reject: false, windowsHide: true, timeout: 0 });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; void killTree(child.pid, spawn, child); }, timeoutMs);
      let output;
      try { output = await child; } finally { clearTimeout(timer); }
      if (timedOut) throw new Error(`AfterFX ${action} timed out after ${timeoutMs} ms (process tree killed)`);
      if (output.exitCode !== 0) {
        const report = await readFile(resultPath, 'utf8').catch(() => '');
        throw new Error(`AfterFX failed (${output.exitCode}): ${report || String(output.stderr).slice(-2000)}`);
      }
      const result = JSON.parse((await readFile(resultPath, 'utf8')).replace(/^\uFEFF/, '')) as Result<T>;
      if (result.ok !== true) throw new Error(`AfterFX: ${result.error ?? 'job failed'}`);
      return result;
    } finally { await rm(dir, { recursive: true, force: true }); }
  }

  function timingOf(v: unknown): CompTiming | undefined {
    const o = v as { durationFrames?: unknown; displayStartFrame?: unknown } | null;
    if (!o || typeof o.durationFrames !== 'number') return undefined;
    return { durationFrames: o.durationFrames, displayStartFrame: typeof o.displayStartFrame === 'number' ? o.displayStartFrame : 0 };
  }

  function remember(aep: string, stamp: string, entries: Array<[string, unknown]>, complete: boolean): void {
    const key = resolve(aep).toLowerCase();
    let slot = timings.get(key);
    if (!slot || slot.stamp !== stamp || complete) { slot = { stamp, comps: new Map() }; timings.set(key, slot); }
    for (const [name, v] of entries) {
      const t = timingOf(v);
      if (!t) continue;
      slot.comps.set(name, complete && slot.comps.has(name) ? 'ambiguous' : t);
    }
  }

  /** Duration and display start of a comp; reuses the last job's data while the .aep is unchanged. */
  async function compTiming(aep: string, comp: string): Promise<CompTiming> {
    const stamp = await hashFile(aep);
    let hit = timings.get(resolve(aep).toLowerCase());
    if (!hit || hit.stamp !== stamp || !hit.comps.has(comp)) {
      const { data } = await run<CompInfo[]>('list', { aep: resolve(aep) });
      remember(aep, stamp, data.map((c) => [c.name, c]), true);
      hit = timings.get(resolve(aep).toLowerCase());
    }
    const t = hit?.comps.get(comp);
    if (!t) throw new Error(`comp not found: ${comp}`);
    if (t === 'ambiguous') throw new Error(`ambiguous comp name: ${comp}`);
    if (!(t.durationFrames > 0)) throw new Error(`comp has no frames: ${comp}`);
    return t;
  }

  async function fingerprintSnapshot(snapshot: unknown): Promise<FingerprintDetail> {
    const files = new Set<string>();
    const sequences = new Set<string>();
    let opaque = false;
    function collect(v: unknown): void {
      if (Array.isArray(v)) { v.forEach(collect); return; }
      if (v && typeof v === 'object') {
        const obj = v as Record<string, unknown>;
        if (typeof obj.file === 'string') files.add(obj.file);
        if (typeof obj.file === 'string' && obj.sequence === true) sequences.add(obj.file);
        if (obj.opaque === true) opaque = true;
        Object.values(obj).forEach(collect);
      }
    }
    collect(snapshot);
    for (const file of sequences) {
      const stem = basename(file, extname(file));
      const prefix = stem.replace(/\d+$/, '');
      for (const entry of await readdir(dirname(file), { withFileTypes: true })) {
        if (entry.isFile() && entry.name.startsWith(prefix) && extname(entry.name).toLowerCase() === extname(file).toLowerCase()) files.add(join(dirname(file), entry.name));
      }
    }
    const media: Record<string, string> = {};
    for (const file of files) media[file] = await hashFile(file);
    // No .aep hash: expressions are fingerprinted by text + sampled values, opaque values are only
    // flagged (see jsx/README.md), so merely re-saving the project does not re-render every comp.
    return { hash: hashJson({ snapshot, media }), opaque };
  }

  async function fingerprintDetailed(aep: string, comps?: string[]): Promise<Record<string, FingerprintDetail>> {
    const stamp = await hashFile(aep);
    const { data } = await run<Record<string, unknown>>('fingerprint', { aep: resolve(aep), comps });
    remember(aep, stamp, Object.entries(data), false);
    const out: Record<string, FingerprintDetail> = {};
    for (const [name, snapshot] of Object.entries(data)) out[name] = await fingerprintSnapshot(snapshot);
    return out;
  }

  async function edit(req: AeEditRequest): Promise<AeEditOutcome> {
    const source = resolve(req.aep);
    const savedTo = req.saveAs ? resolve(req.saveAs) : source;
    if (req.saveAs && savedTo.toLowerCase() === source.toLowerCase()) throw new Error('saveAs must differ from the source; omit it for an in-place edit with backup');
    if (req.saveAs && existsSync(savedTo)) throw new Error(`refusing to overwrite ${savedTo}`);
    const before = await hashFile(source);
    const working = join(dirname(source), `.editmcp-${randomUUID()}${extname(source) || '.aep'}`);
    await copyFile(source, working, constants.COPYFILE_EXCL);
    try {
      const result = await run<Detail>('edit', { aep: working, comp: req.comp, ops: req.ops });
      const { hash: fingerprint } = await fingerprintSnapshot(result.data.snapshot);
      const changed = 'source .aep changed during edit; original preserved, retry against the new version';
      if (await hashFile(source) !== before) throw new Error(changed);
      const log = result.log ?? [];
      let aeGuiRunning = false;
      let warning: string | undefined;
      if (req.saveAs) {
        await copyFile(working, savedTo, constants.COPYFILE_EXCL);
      } else {
        // A GUI holding this project in memory would silently revert the edit on its next save.
        const gui = guiWindows(await listProcesses().catch(() => []));
        if (gui.length) {
          aeGuiRunning = true;
          const name = basename(source).toLowerCase();
          const showing = gui.some((p) => p.title.toLowerCase().includes(name));
          warning = `After Effects GUI is running${showing ? ' with this project open' : ''} (PID ${gui.map((p) => p.pid).join(', ')}): `
            + 'saving there will overwrite this edit. Close it without saving and reopen, or use saveAs to write a new .aep. '
            + '/ After Effects เปิดอยู่ ถ้ากด save ในโปรแกรม การแก้ไขนี้จะหาย ให้ปิดแล้วเปิดใหม่ หรือใช้ saveAs';
          log.push(`WARNING: ${warning}`);
        }
        const backup = uniqueOutputPath(join(dirname(source), `${basename(source, extname(source))}_backup_${Date.now()}.aep`));
        await copyFile(source, backup, constants.COPYFILE_EXCL);
        log.push(`backup: ${backup}`);
        // Re-check right before replacing so a save during the backup copy is never lost.
        if (await hashFile(source) !== before) { await rm(backup, { force: true }); throw new Error(changed); }
        await rename(working, source);
        timings.delete(source.toLowerCase());
      }
      return { ok: true, savedTo, fingerprint, log, aeGuiRunning, ...(warning ? { warning } : {}) };
    } finally { await rm(working, { force: true }); }
  }

  async function render(req: RenderRequest) {
    const aep = resolve(req.aep);
    const t = await compTiming(aep, req.comp);
    const startFrame = req.startFrame ?? 0;
    const endFrame = req.endFrame ?? t.durationFrames - 1;
    if (endFrame >= t.durationFrames) throw new Error(`endFrame ${endFrame} is past the end of ${req.comp} (${t.durationFrames} frames)`);
    const base = {
      ...req, aep, startFrame, endFrame, frameOffset: t.displayStartFrame,
      mfrPercent: req.mfrPercent ?? defaultMfrPercent(),
      rsTemplate: req.renderSettings ?? 'Best Settings', strictRam: true, minFreeRamGb: opts.minFreeRamGb,
    };
    const omTemplate = req.outputModule ?? 'EDITMCP ProRes 422 HQ';
    try {
      return await aerender(tools, { ...base, omTemplate }, { spawn });
    } catch (error) {
      // Fall back only when aerender itself says the ProRes OM template is missing.
      if (req.outputModule || !isMissingOmTemplate(error, [req.comp, aep, omTemplate])) throw error;
      return aerender(tools, { ...base, omTemplate: 'Lossless', fallback: true }, { spawn });
    }
  }

  return {
    kind: 'extendscript-headless',
    listComps: (aep) => serial(async () => {
      const stamp = await hashFile(aep);
      const { data } = await run<CompInfo[]>('list', { aep: resolve(aep) });
      remember(aep, stamp, data.map((c) => [c.name, c]), true);
      return data;
    }),
    inspectComp: (aep, comp, atFrame = 0) => serial(async () => {
      if (!Number.isInteger(atFrame) || atFrame < 0) throw new Error('atFrame must be a non-negative integer');
      const stamp = await hashFile(aep);
      const { data } = await run<Detail>('inspect', { aep: resolve(aep), comp, atFrame });
      const { snapshot, ...detail } = data;
      remember(aep, stamp, [[comp, detail]], false);
      return { ...detail, fingerprint: (await fingerprintSnapshot(snapshot)).hash };
    }),
    fingerprint: (aep, comps) => serial(async () => {
      const hashes: Record<string, string> = {};
      for (const [name, d] of Object.entries(await fingerprintDetailed(aep, comps))) hashes[name] = d.hash;
      return hashes;
    }),
    fingerprintDetailed: (aep, comps) => serial(() => fingerprintDetailed(aep, comps)),
    edit: (req) => serial(() => edit(req)),
    render: (req) => serial(() => render(req)),
    previewFrame: (aep, comp, frame, outPng) => serial(async () => {
      if (!Number.isInteger(frame) || frame < 0) throw new Error('frame must be a non-negative integer');
      const t = await compTiming(aep, comp);
      if (frame >= t.durationFrames) throw new Error(`frame ${frame} is past the end of ${comp} (${t.durationFrames} frames)`);
      // Lossless is universally available; extract PNG with ffmpeg rather than relying on image templates.
      const out = uniqueOutputPath(resolve(outPng));
      const tempRoot = os.tmpdir();
      if (!isAscii(tempRoot)) throw new Error('After Effects needs an ASCII TEMP directory');
      const dir = await mkdtemp(join(tempRoot, 'editmcp-preview-'));
      try {
        const clip = await aerender(tools, { aep: resolve(aep), comp, startFrame: frame, endFrame: frame, frameOffset: t.displayStartFrame, outPath: join(dir, 'frame.mov'), omTemplate: 'Lossless', rsTemplate: 'Best Settings', strictRam: true, minFreeRamGb: opts.minFreeRamGb }, { spawn });
        const png = join(dir, 'frame.png');
        const r = await spawn(tools.ffmpeg, ['-hide_banner', '-nostdin', '-n', '-i', clip.path, '-frames:v', '1', png], { reject: false, windowsHide: true, timeout: 60_000 });
        if (r.exitCode !== 0) throw new Error(`PNG conversion failed: ${r.stderr}`);
        await moveFile(png, out);
        return out;
      } finally { await rm(dir, { recursive: true, force: true }); }
    }),
    version: () => serial(async () => (await run<string>('version')).data),
  };
}
