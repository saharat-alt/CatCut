/**
 * Premiere Pro handoff over the CatCut bridge (premiere/catcut-bridge, a CEP extension that starts
 * by itself inside Premiere): no computer use, no panel clicks. Premiere must be running with its
 * Windows session logged in; the screen may be off or locked.
 *
 * Queue protocol 1 (see premiere/catcut-bridge/bridge-core.js) in an ASCII temp folder:
 * CatCut writes <id>.req.json, the bridge answers <id>.res.json and keeps bridge.json fresh.
 * Files Premiere reads or writes are staged in that folder, so Thai project paths never reach it.
 */
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isAscii, type SpawnFn } from './aerender.js';

export const BRIDGE_ID = 'com.catcut.bridge';
const PROTOCOL = 1;

export interface PremiereProjectRef { name: string; path: string }
export interface PremiereSequenceRef { name: string; id: string; active?: boolean }

export interface PremiereBridgeStatus {
  /** extension folder present under %APPDATA%\Adobe\CEP\extensions */
  installed: boolean;
  installDir: string;
  /** a bridge heartbeat younger than staleMs */
  connected: boolean;
  queueDir: string;
  premiere?: string;
  bridge?: string;
  project?: PremiereProjectRef | null;
  heartbeatAgeMs?: number;
}

export interface PremiereClient {
  status(): Promise<PremiereBridgeStatus>;
  /** Run one bridge action; rejects with Premiere's error text. */
  call<T>(action: string, args?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T>;
  /** Folder both sides can read and write (ASCII). */
  readonly queueDir: string;
}

export function defaultQueueDir(): string {
  return process.env['CATCUT_PREMIERE_BRIDGE_DIR'] ?? join(os.tmpdir(), 'catcut-premiere-bridge');
}

export function cepExtensionsDir(): string {
  return join(process.env['APPDATA'] ?? join(os.homedir(), 'AppData', 'Roaming'), 'Adobe', 'CEP', 'extensions');
}

export function createPremiereClient(opts: { queueDir?: string; staleMs?: number; pollMs?: number; installDir?: string } = {}): PremiereClient {
  const queueDir = opts.queueDir ?? defaultQueueDir();
  const staleMs = opts.staleMs ?? 10_000;
  const pollMs = opts.pollMs ?? 100;
  const installDir = opts.installDir ?? join(cepExtensionsDir(), BRIDGE_ID);
  let chain: Promise<unknown> = Promise.resolve();

  async function status(): Promise<PremiereBridgeStatus> {
    const base: PremiereBridgeStatus = { installed: existsSync(join(installDir, 'CSXS', 'manifest.xml')), installDir, connected: false, queueDir };
    let hb: { protocol?: number; bridge?: string; premiere?: string; project?: PremiereProjectRef | null; ts?: number } | undefined;
    try { hb = JSON.parse((await readFile(join(queueDir, 'bridge.json'), 'utf8')).replace(/^﻿/, '')) as typeof hb; } catch { return base; }
    if (!hb || typeof hb.ts !== 'number') return base;
    const age = Date.now() - hb.ts;
    return {
      ...base, connected: age < staleMs && hb.protocol === PROTOCOL, heartbeatAgeMs: Math.max(0, age),
      ...(hb.premiere ? { premiere: hb.premiere } : {}), ...(hb.bridge ? { bridge: hb.bridge } : {}), project: hb.project ?? null,
    };
  }

  async function callOnce<T>(action: string, args: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const st = await status();
    if (!st.connected) {
      throw new Error(st.installed
        ? 'Premiere bridge is not running: open Premiere Pro (it starts by itself), or Window > Extensions > CatCut Bridge / ยังไม่ได้เปิด Premiere หรือ bridge ยังไม่ทำงาน'
        : 'Premiere bridge is not installed: run `catcut premiere-bridge install`, then restart Premiere / ยังไม่ได้ติดตั้ง bridge');
    }
    // time-ordered ids keep the bridge's queue FIFO
    const id = `${Date.now().toString(36).padStart(9, '0')}-${randomUUID().slice(0, 8)}`;
    const req = join(queueDir, `${id}.req.json`);
    const res = join(queueDir, `${id}.res.json`);
    await writeFile(`${req}.tmp`, JSON.stringify({ id, action, args, deadline: Date.now() + timeoutMs }), 'utf8');
    await rename(`${req}.tmp`, req);
    const until = Date.now() + timeoutMs;
    for (;;) {
      let raw: string | undefined;
      try { raw = await readFile(res, 'utf8'); } catch { /* not yet */ }
      if (raw !== undefined) {
        await unlink(res).catch(() => undefined);
        const r = JSON.parse(raw.replace(/^﻿/, '')) as { ok?: boolean; data?: T; error?: string };
        if (r.ok !== true) throw new Error(`Premiere: ${r.error ?? 'request failed'}`);
        return r.data as T;
      }
      if (Date.now() > until) {
        // still unclaimed: withdraw it so a late Premiere never runs a stale request
        const withdrawn = await unlink(req).then(() => true, () => false);
        throw new Error(withdrawn
          ? `Premiere did not pick up '${action}' within ${Math.round(timeoutMs / 1000)} s (busy with a dialog?)`
          : `Premiere is still working on '${action}' after ${Math.round(timeoutMs / 1000)} s; check Premiere before retrying`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  return {
    queueDir,
    status,
    // one request at a time from this process
    call: <T>(action: string, args: Record<string, unknown> = {}, o: { timeoutMs?: number } = {}) => {
      const run = chain.then(() => callOnce<T>(action, args, o.timeoutMs ?? 120_000));
      chain = run.catch(() => undefined);
      return run;
    },
  };
}

/** A unique ASCII file in the queue folder for Premiere to read or write. */
export async function stagePath(client: PremiereClient, ext: string): Promise<string> {
  if (!isAscii(client.queueDir)) throw new Error(`Premiere bridge folder must be an ASCII path: ${client.queueDir} (set TEMP/TMP to an ASCII folder)`);
  const dir = join(client.queueDir, 'files');
  await mkdir(dir, { recursive: true });
  return join(dir, `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}${ext}`);
}

// ---------- install (run by the user via `catcut premiere-bridge install`) ----------

export function bridgeSourceDir(): string {
  return fileURLToPath(new URL('../../premiere/catcut-bridge', import.meta.url));
}

/** CEP runtimes Premiere 2020 → 2026 load (CSXS.9 … CSXS.12). */
const CSXS_VERSIONS = [9, 10, 11, 12];

export interface InstallResult { installedTo: string; debugModeKeys: string[] }

/**
 * Copies the extension into the user's CEP folder (replacing an older CatCut bridge only) and sets
 * PlayerDebugMode=1 for the CEP runtimes, which lets Premiere load an unsigned extension.
 */
export async function installBridge(opts: { spawn?: SpawnFn; source?: string; extensionsDir?: string } = {}): Promise<InstallResult> {
  const spawn = opts.spawn ?? execa;
  const source = opts.source ?? bridgeSourceDir();
  if (!existsSync(join(source, 'CSXS', 'manifest.xml'))) throw new Error(`bridge sources not found: ${source}`);
  const dest = join(opts.extensionsDir ?? cepExtensionsDir(), BRIDGE_ID);
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  await cp(source, dest, { recursive: true });
  const keys: string[] = [];
  for (const v of CSXS_VERSIONS) {
    const key = `HKCU\\Software\\Adobe\\CSXS.${v}`;
    const r = await spawn('reg', ['add', key, '/v', 'PlayerDebugMode', '/t', 'REG_SZ', '/d', '1', '/f'], { reject: false, windowsHide: true, timeout: 15_000 });
    if (r.exitCode !== 0) throw new Error(`could not set ${key}\\PlayerDebugMode: ${String(r.stderr ?? '').trim()}`);
    keys.push(key);
  }
  return { installedTo: dest, debugModeKeys: keys };
}

/** Removes the extension folder (PlayerDebugMode stays: other unsigned extensions may need it). */
export async function uninstallBridge(opts: { extensionsDir?: string } = {}): Promise<string> {
  const dest = join(opts.extensionsDir ?? cepExtensionsDir(), BRIDGE_ID);
  await rm(dest, { recursive: true, force: true });
  return dest;
}
