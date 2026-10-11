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
import { isAscii } from './aerender.js';
export const BRIDGE_ID = 'com.catcut.bridge';
const PROTOCOL = 1;
export function defaultQueueDir() {
    return process.env['CATCUT_PREMIERE_BRIDGE_DIR'] ?? join(os.tmpdir(), 'catcut-premiere-bridge');
}
export function cepExtensionsDir() {
    return join(process.env['APPDATA'] ?? join(os.homedir(), 'AppData', 'Roaming'), 'Adobe', 'CEP', 'extensions');
}
export function createPremiereClient(opts = {}) {
    const queueDir = opts.queueDir ?? defaultQueueDir();
    const staleMs = opts.staleMs ?? 10_000;
    const pollMs = opts.pollMs ?? 100;
    const installDir = opts.installDir ?? join(cepExtensionsDir(), BRIDGE_ID);
    let chain = Promise.resolve();
    async function status() {
        const base = { installed: existsSync(join(installDir, 'CSXS', 'manifest.xml')), installDir, connected: false, queueDir };
        let hb;
        try {
            hb = JSON.parse((await readFile(join(queueDir, 'bridge.json'), 'utf8')).replace(/^﻿/, ''));
        }
        catch {
            return base;
        }
        if (!hb || typeof hb.ts !== 'number')
            return base;
        const age = Date.now() - hb.ts;
        return {
            ...base, connected: age < staleMs && hb.protocol === PROTOCOL, heartbeatAgeMs: Math.max(0, age),
            ...(hb.premiere ? { premiere: hb.premiere } : {}), ...(hb.bridge ? { bridge: hb.bridge } : {}), project: hb.project ?? null,
        };
    }
    async function callOnce(action, args, timeoutMs) {
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
            let raw;
            try {
                raw = await readFile(res, 'utf8');
            }
            catch { /* not yet */ }
            if (raw !== undefined) {
                await unlink(res).catch(() => undefined);
                const r = JSON.parse(raw.replace(/^﻿/, ''));
                if (r.ok !== true)
                    throw new Error(`Premiere: ${r.error ?? 'request failed'}`);
                return r.data;
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
        call: (action, args = {}, o = {}) => {
            const run = chain.then(() => callOnce(action, args, o.timeoutMs ?? 120_000));
            chain = run.catch(() => undefined);
            return run;
        },
    };
}
/** A unique ASCII file in the queue folder for Premiere to read or write. */
export async function stagePath(client, ext) {
    if (!isAscii(client.queueDir))
        throw new Error(`Premiere bridge folder must be an ASCII path: ${client.queueDir} (set TEMP/TMP to an ASCII folder)`);
    const dir = join(client.queueDir, 'files');
    await mkdir(dir, { recursive: true });
    return join(dir, `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}${ext}`);
}
// ---------- install (run by the user via `catcut premiere-bridge install`) ----------
export function bridgeSourceDir() {
    return fileURLToPath(new URL('../../premiere/catcut-bridge', import.meta.url));
}
/** CEP runtimes Premiere 2020 → 2026 load (CSXS.9 … CSXS.12). */
const CSXS_VERSIONS = [9, 10, 11, 12];
/**
 * Copies the extension into the user's CEP folder (replacing an older CatCut bridge only) and sets
 * PlayerDebugMode=1 for the CEP runtimes, which lets Premiere load an unsigned extension.
 */
export async function installBridge(opts = {}) {
    const spawn = opts.spawn ?? execa;
    const source = opts.source ?? bridgeSourceDir();
    if (!existsSync(join(source, 'CSXS', 'manifest.xml')))
        throw new Error(`bridge sources not found: ${source}`);
    const dest = join(opts.extensionsDir ?? cepExtensionsDir(), BRIDGE_ID);
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    await cp(source, dest, { recursive: true });
    const keys = [];
    for (const v of CSXS_VERSIONS) {
        const key = `HKCU\\Software\\Adobe\\CSXS.${v}`;
        const r = await spawn('reg', ['add', key, '/v', 'PlayerDebugMode', '/t', 'REG_SZ', '/d', '1', '/f'], { reject: false, windowsHide: true, timeout: 15_000 });
        if (r.exitCode !== 0)
            throw new Error(`could not set ${key}\\PlayerDebugMode: ${String(r.stderr ?? '').trim()}`);
        keys.push(key);
    }
    return { installedTo: dest, debugModeKeys: keys };
}
/** Removes the extension folder (PlayerDebugMode stays: other unsigned extensions may need it). */
export async function uninstallBridge(opts = {}) {
    const dest = join(opts.extensionsDir ?? cepExtensionsDir(), BRIDGE_ID);
    await rm(dest, { recursive: true, force: true });
    return dest;
}
//# sourceMappingURL=premiere.js.map