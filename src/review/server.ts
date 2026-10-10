import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Project, Version } from '../core/types.js';
import { comparableVersions, findComparable, mapFrame, mapFrames } from './compare.js';
import { INTENT_COLORS, readReviewDraft, readReviewSession, ReviewError, saveReviewDraft, saveReviewSession, submitReview, versionPlan } from './session.js';

export interface ReviewServer { url: string; close(): Promise<void> }

async function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new ReviewError('Expected JSON');
  if (Number(req.headers['content-length']) > 1024 * 1024) throw new ReviewError('Request too large', 413);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new ReviewError('Request too large', 413);
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ReviewError('Invalid JSON'); }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function media(req: IncomingMessage, res: ServerResponse, file: string): Promise<void> {
  const size = (await stat(file)).size;
  let start = 0, end = size - 1;
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) throw new ReviewError('Invalid range', 416);
    if (!match[1]) start = Math.max(0, size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      res.setHeader('Content-Range', `bytes */${size}`);
      throw new ReviewError('Invalid range', 416);
    }
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = createReadStream(file, { start, end });
  res.on('close', () => stream.destroy());
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/** Notes of the latest earlier comparable version, with frames mapped onto this version (for "ก่อน/หลัง"). */
async function history(p: Project, v: Version, plan: ReturnType<typeof versionPlan>, previous: Awaited<ReturnType<typeof comparableVersions>>[number] | undefined) {
  const prev = previous && p.versions.find(x => x.id === previous.id);
  if (!previous || !prev) return null;
  try {
    const s = await readReviewSession(p, prev);
    if (!s.notes.length) return null;
    const map = mapFrames(previous.plan, plan, { from: previous.id, to: v.id });
    return { version: previous.id, notes: s.notes.map(n => ({ id: n.id, frame: mapFrame(map, n.frame), sourceFrame: n.frame, intent: n.intent, color: n.color, text: n.text, status: n.status })) };
  } catch { return null; }
}

/** Serves a single immutable version on loopback (plus read-only proxies of comparable versions); no arbitrary file or command routes. */
export async function openReview(p: Project, v: Version): Promise<ReviewServer> {
  const plan = structuredClone(versionPlan(p, v));
  const proxy = v.reviewProxy;
  if (!proxy) throw new ReviewError('Create a review proxy first');
  await stat(proxy);
  const frozenVersion = { ...v, reviewPlan: plan };
  const prefix = `/review/${randomBytes(24).toString('hex')}/`;
  const assets = new Map<string, { body: Buffer; type: string }>();
  for (const [route, file, type] of [
    ['', 'index.html', 'text/html'], ['app.js', 'app.js', 'text/javascript'], ['style.css', 'style.css', 'text/css'],
    ['fonts/NotoSansThai.ttf', 'fonts/NotoSansThai.ttf', 'font/ttf'],
  ]) assets.set(route!, { body: await readFile(new URL(`../../web/review/${file}`, import.meta.url)), type: type! });
  // Optional brand mark; served only when the file ships.
  const logo = new URL('../../web/review/logo.svg', import.meta.url);
  if (existsSync(logo)) assets.set('logo.svg', { body: await readFile(logo), type: 'image/svg+xml' });
  let origin = '';
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; media-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    void (async () => {
      if (req.headers.host !== new URL(origin).host) throw new ReviewError('Invalid host', 403);
      const url = new URL(req.url ?? '/', origin);
      if (!url.pathname.startsWith(prefix)) throw new ReviewError('Not found', 404);
      const route = url.pathname.slice(prefix.length);
      if (req.method === 'PUT' || req.method === 'POST') {
        if (req.headers.origin !== origin) throw new ReviewError('Invalid origin', 403);
        if (route === 'session' && req.method === 'PUT') return json(res, 200, await saveReviewSession(p, frozenVersion, await body(req)));
        if (route === 'draft' && req.method === 'PUT') return json(res, 200, { draft: await saveReviewDraft(p, frozenVersion, await body(req)) });
        if (route === 'submit' && req.method === 'POST') {
          const input = await body(req);
          if (!input || typeof input !== 'object' || !('revision' in input) || Object.keys(input).length !== 1 || typeof input.revision !== 'number') throw new ReviewError('Invalid revision');
          return json(res, 200, await submitReview(p, frozenVersion, input.revision));
        }
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new ReviewError('Method not allowed', 405);
      if (route === 'data') {
        const [session, draft, others] = await Promise.all([readReviewSession(p, frozenVersion), readReviewDraft(p, frozenVersion), comparableVersions(p, frozenVersion)]);
        const index = p.versions.findIndex(x => x.id === v.id);
        const previous = others.filter(o => p.versions.findIndex(x => x.id === o.id) < index).pop();
        return json(res, 200, {
          name: p.meta.name, version: v.id, plan, qc: v.qc ?? null, intents: INTENT_COLORS, session, draft, brand: { logo: assets.has('logo.svg') },
          compare: { versions: others.map(o => ({ id: o.id, createdAt: o.createdAt, frames: o.frames })), previous: previous?.id ?? null },
          history: await history(p, frozenVersion, plan, previous),
        });
      }
      if (route === 'media') return media(req, res, proxy);
      const compare = /^compare\/([^/]+)\/(data|media)$/.exec(route);
      if (compare) {
        const other = await findComparable(p, frozenVersion, compare[1]!);
        if (compare[2] === 'media') return media(req, res, other.proxy);
        const map = mapFrames(plan, other.plan, { from: v.id, to: other.id });
        return json(res, 200, { version: other.id, fps: other.plan.fps, width: other.plan.width, height: other.plan.height, frames: other.plan.frames, shots: other.plan.shots, ...map });
      }
      if (route === 'contact' && v.qc?.contactSheet) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(await readFile(v.qc.contactSheet));
      }
      const asset = assets.get(route);
      if (!asset) throw new ReviewError('Not found', 404);
      res.writeHead(200, { 'Content-Type': asset.type + (asset.type.startsWith('font/') ? '' : '; charset=utf-8') });
      res.end(req.method === 'HEAD' ? undefined : asset.body);
    })().catch(error => {
      if (res.headersSent) { res.destroy(); return; }
      json(res, error instanceof ReviewError ? error.status : 500, { error: error instanceof ReviewError ? error.message : 'Could not read or save this review' });
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No review port');
  origin = `http://127.0.0.1:${address.port}`;
  return { url: origin + prefix, close: () => new Promise((resolve, reject) => {
    if (!server.listening) { resolve(); return; }
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  }) };
}
