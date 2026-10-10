import { execa } from 'execa';
import { constants, existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { AeBackend, AeEditRequest, CompDetail, CompInfo, RenderRequest, ToolPaths } from '../core/types.js';
import { hashFile, hashJson } from '../core/hash.js';
import { aerender, isAscii, killTree, moveFile, uniqueOutputPath, type SpawnFn } from './aerender.js';

interface AeOptions { spawn?: SpawnFn; timeoutMs?: number; minFreeRamGb?: number }
interface Detail extends CompInfo { layers: CompDetail['layers']; snapshot: unknown }
interface Result<T> { ok: boolean; data: T; log?: string[]; error?: string }
// One Adobe process at a time, including renders, across backend instances.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn);
  queue = result.catch(() => undefined);
  return result;
}

export function createAeBackend(tools: ToolPaths, opts: AeOptions = {}): AeBackend {
  const spawn = opts.spawn ?? execa;
  const runner = fileURLToPath(new URL('../../jsx/runner.jsx', import.meta.url));

  async function run<T>(action: string, payload: Record<string, unknown> = {}): Promise<Result<T>> {
    if (!tools.afterfx) throw new Error('AfterFX not found; install After Effects or set EDITMCP_AE_DIR');
    const minRam = opts.minFreeRamGb ?? 0.75;
    if (os.freemem() / 2 ** 30 < minRam) throw new Error(`not enough free RAM for After Effects (need ${minRam} GB)`);
    const tempRoot = os.tmpdir();
    if (!isAscii(tempRoot)) throw new Error('After Effects needs an ASCII TEMP directory; set TEMP/TMP to an ASCII path');
    const dir = await mkdtemp(join(tempRoot, 'editmcp-ae-'));
    try {
      const jobPath = join(dir, 'job.json');
      const resultPath = join(dir, 'result.json');
      await writeFile(jobPath, JSON.stringify({ ...payload, action, result: resultPath }).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'), 'utf8');
      const launcher = join(dir, 'launch.jsx');
      // Only generated paths are embedded in JSX; user values go through the UTF-8 JSON job.
      await writeFile(launcher, `var EDITMCP_JOB = ${JSON.stringify(jobPath)};\n$.evalFile(new File(${JSON.stringify(runner)}));\n`, 'utf8');
      const child = spawn(tools.afterfx, ['-m', '-noui', '-r', launcher], { reject: false, windowsHide: true, timeout: 0 });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; void killTree(child.pid, spawn, child); }, opts.timeoutMs ?? 120_000);
      let output;
      try { output = await child; } finally { clearTimeout(timer); }
      if (timedOut) throw new Error('AfterFX timed out (process tree killed)');
      if (output.exitCode !== 0) {
        const report = await readFile(resultPath, 'utf8').catch(() => '');
        throw new Error(`AfterFX failed (${output.exitCode}): ${report || String(output.stderr).slice(-2000)}`);
      }
      const result = JSON.parse((await readFile(resultPath, 'utf8')).replace(/^\uFEFF/, '')) as Result<T>;
      if (result.ok !== true) throw new Error(`AfterFX: ${result.error ?? 'job failed'}`);
      return result;
    } finally { await rm(dir, { recursive: true, force: true }); }
  }

  async function fingerprintSnapshot(snapshot: unknown, aep: string): Promise<string> {
    const files = new Set<string>();
    const sequences = new Set<string>();
    let projectDependency = false;
    function collect(v: unknown): void {
      if (Array.isArray(v)) { v.forEach(collect); return; }
      if (v && typeof v === 'object') {
        const obj = v as Record<string, unknown>;
        if (typeof obj.file === 'string') files.add(obj.file);
        if (typeof obj.file === 'string' && obj.sequence === true) sequences.add(obj.file);
        if (obj.projectDependency === true) projectDependency = true;
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
    // Expressions and opaque plugin values can reference any comp; conservatively track the saved project.
    if (projectDependency) media.project = await hashFile(aep);
    return hashJson({ snapshot, media });
  }

  async function edit(req: AeEditRequest) {
    const source = resolve(req.aep);
    const savedTo = req.saveAs ? resolve(req.saveAs) : source;
    if (req.saveAs && savedTo.toLowerCase() === source.toLowerCase()) throw new Error('saveAs must differ from the source; omit it for an in-place edit with backup');
    if (req.saveAs && existsSync(savedTo)) throw new Error(`refusing to overwrite ${savedTo}`);
    const before = await hashFile(source);
    const working = join(dirname(source), `.editmcp-${randomUUID()}${extname(source) || '.aep'}`);
    await copyFile(source, working, constants.COPYFILE_EXCL);
    try {
      const result = await run<Detail>('edit', { aep: working, comp: req.comp, ops: req.ops });
      const fingerprint = await fingerprintSnapshot(result.data.snapshot, working);
      if (await hashFile(source) !== before) throw new Error('source .aep changed during edit; original preserved, retry against the new version');
      const log = result.log ?? [];
      if (req.saveAs) {
        await copyFile(working, savedTo, constants.COPYFILE_EXCL);
      } else {
        const backup = uniqueOutputPath(join(dirname(source), `${basename(source, extname(source))}_backup_${Date.now()}.aep`));
        await copyFile(source, backup, constants.COPYFILE_EXCL);
        log.push(`backup: ${backup}`);
        await rename(working, source);
      }
      return { ok: true, savedTo, fingerprint, log };
    } finally { await rm(working, { force: true }); }
  }

  async function render(req: RenderRequest) {
    try {
      return await aerender(tools, { ...req, omTemplate: req.outputModule ?? 'EDITMCP ProRes 422 HQ', rsTemplate: req.renderSettings ?? 'Best Settings', strictRam: true, minFreeRamGb: opts.minFreeRamGb }, { spawn });
    } catch (error) {
      // Fall back only for a missing ProRes template, never for an arbitrary render failure.
      if (req.outputModule || !/template.*(not|missing|invalid)|(?:not|missing|invalid).*template/i.test(String(error))) throw error;
      return aerender(tools, { ...req, omTemplate: 'Lossless', rsTemplate: req.renderSettings ?? 'Best Settings', fallback: true, strictRam: true, minFreeRamGb: opts.minFreeRamGb }, { spawn });
    }
  }

  return {
    kind: 'extendscript-headless',
    listComps: (aep) => serial(async () => (await run<CompInfo[]>('list', { aep: resolve(aep) })).data),
    inspectComp: (aep, comp, atFrame = 0) => serial(async () => {
      if (!Number.isInteger(atFrame) || atFrame < 0) throw new Error('atFrame must be a non-negative integer');
      const { data } = await run<Detail>('inspect', { aep: resolve(aep), comp, atFrame });
      const { snapshot, ...detail } = data;
      return { ...detail, fingerprint: await fingerprintSnapshot(snapshot, aep) };
    }),
    fingerprint: (aep, comps) => serial(async () => {
      const { data } = await run<Record<string, unknown>>('fingerprint', { aep: resolve(aep), comps });
      const hashes: Record<string, string> = {};
      for (const [name, snapshot] of Object.entries(data)) hashes[name] = await fingerprintSnapshot(snapshot, aep);
      return hashes;
    }),
    edit: (req) => serial(() => edit(req)),
    render: (req) => serial(() => render(req)),
    previewFrame: (aep, comp, frame, outPng) => serial(async () => {
      if (!Number.isInteger(frame) || frame < 0) throw new Error('frame must be a non-negative integer');
      // Lossless is universally available; extract PNG with ffmpeg rather than relying on image templates.
      const out = uniqueOutputPath(resolve(outPng));
      const tempRoot = os.tmpdir();
      if (!isAscii(tempRoot)) throw new Error('After Effects needs an ASCII TEMP directory');
      const dir = await mkdtemp(join(tempRoot, 'editmcp-preview-'));
      try {
        const clip = await aerender(tools, { aep, comp, startFrame: frame, endFrame: frame, outPath: join(dir, 'frame.mov'), omTemplate: 'Lossless', rsTemplate: 'Best Settings', strictRam: true, minFreeRamGb: opts.minFreeRamGb }, { spawn });
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
