import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

const CHUNK = 1024 * 1024; // 1 MiB

async function readExact(fh: FileHandle, length: number, position: number): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(length);
  let off = 0;
  while (off < length) {
    const { bytesRead } = await fh.read(buf, off, length - off, position + off);
    if (bytesRead === 0) break; // file shrank underneath us; hash what we got
    off += bytesRead;
  }
  return off === length ? buf : buf.subarray(0, off);
}

/**
 * Fast content fingerprint: sha1 of size + mtime + first 1 MiB + last 1 MiB.
 * Deliberately does not read the middle of large media files, so a same-size
 * in-place edit that preserves mtime is not detected.
 */
export async function hashFile(path: string): Promise<string> {
  const st = await stat(path);
  if (!st.isFile()) throw new Error(`not a file: ${path}`);
  const h = createHash('sha1');
  h.update(`${st.size}:${Math.floor(st.mtimeMs)}\n`);
  const fh = await open(path, 'r');
  try {
    const headLen = Math.min(CHUNK, st.size);
    if (headLen > 0) h.update(await readExact(fh, headLen, 0));
    if (st.size > CHUNK) {
      const tailStart = Math.max(headLen, st.size - CHUNK);
      h.update(await readExact(fh, st.size - tailStart, tailStart));
    }
  } finally {
    await fh.close();
  }
  return h.digest('hex');
}

export function hashString(s: string): string {
  return createHash('sha1').update(s, 'utf8').digest('hex');
}

/** JSON serialisation with object keys sorted at every level; undefined members dropped like JSON.stringify. */
function canonicalJson(v: unknown): string {
  if (v === undefined || typeof v === 'function' || typeof v === 'symbol') return 'null';
  if (typeof v === 'bigint') return JSON.stringify(v.toString());
  if (v === null || typeof v !== 'object') return JSON.stringify(v); // numbers (NaN -> null), strings, booleans
  const withToJson = v as { toJSON?: unknown };
  if (typeof withToJson.toJSON === 'function') return canonicalJson((withToJson as { toJSON(): unknown }).toJSON());
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x)).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined && typeof o[k] !== 'function' && typeof o[k] !== 'symbol')
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** Stable hash of any JSON-like value: key order never matters, array order does. */
export function hashJson(v: unknown): string {
  return hashString(canonicalJson(v));
}
