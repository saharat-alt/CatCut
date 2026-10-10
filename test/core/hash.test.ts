import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, utimes, writeFile, stat, open } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, hashJson, hashString } from '../../src/core/hash.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP_ROOT = path.join(ROOT, 'tmp');

describe('hashString', () => {
  it('is deterministic sha1 hex', () => {
    expect(hashString('hello')).toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
    expect(hashString('hello')).toBe(hashString('hello'));
    expect(hashString('hello')).not.toBe(hashString('hellp'));
    expect(hashString('สวัสดี')).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('hashJson', () => {
  it('ignores object key order at every level', () => {
    const a = { z: 1, a: { d: [1, { y: 2, x: 3 }], c: 'x' }, m: null };
    const b = { m: null, a: { c: 'x', d: [1, { x: 3, y: 2 }] }, z: 1 };
    expect(hashJson(a)).toBe(hashJson(b));
  });

  it('is sensitive to array order and values', () => {
    expect(hashJson([1, 2])).not.toBe(hashJson([2, 1]));
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: 2 }));
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: '1' }));
  });

  it('treats undefined members like JSON.stringify (dropped)', () => {
    expect(hashJson({ a: 1, b: undefined })).toBe(hashJson({ a: 1 }));
    expect(hashJson({ a: 1, b: null })).not.toBe(hashJson({ a: 1 }));
    expect(hashJson([1, undefined])).toBe(hashJson([1, null]));
  });

  it('handles primitives and toJSON', () => {
    expect(hashJson(1)).toBe(hashString('1'));
    expect(hashJson('x')).toBe(hashString('"x"'));
    expect(hashJson(null)).toBe(hashString('null'));
    expect(hashJson(undefined)).toBe(hashString('null'));
    const d = new Date('2026-01-01T00:00:00.000Z');
    expect(hashJson({ d })).toBe(hashJson({ d: '2026-01-01T00:00:00.000Z' }));
  });
});

describe('hashFile', () => {
  let dir: string;
  beforeEach(async () => {
    mkdirSync(TMP_ROOT, { recursive: true });
    dir = await mkdtemp(path.join(TMP_ROOT, 'test-core-hash-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is stable for the same file and differs between files', async () => {
    const f1 = path.join(dir, 'a.bin');
    const f2 = path.join(dir, 'b.bin');
    await writeFile(f1, Buffer.from('abc'));
    await writeFile(f2, Buffer.from('abd'));
    const h1 = await hashFile(f1);
    expect(h1).toMatch(/^[0-9a-f]{40}$/);
    expect(await hashFile(f1)).toBe(h1);
    expect(await hashFile(f2)).not.toBe(h1);
  });

  it('handles an empty file and rejects directories', async () => {
    const f = path.join(dir, 'empty.bin');
    await writeFile(f, Buffer.alloc(0));
    expect(await hashFile(f)).toMatch(/^[0-9a-f]{40}$/);
    await expect(hashFile(dir)).rejects.toThrow(/not a file/);
    await expect(hashFile(path.join(dir, 'missing.bin'))).rejects.toThrow();
  });

  it('changes with mtime even when bytes are identical', async () => {
    const f = path.join(dir, 'm.bin');
    await writeFile(f, Buffer.from('same'));
    const h1 = await hashFile(f);
    const st = await stat(f);
    const later = new Date(st.mtimeMs + 5000);
    await utimes(f, later, later);
    expect(await hashFile(f)).not.toBe(h1);
  });

  it('reads head and tail of large files but not the middle (fast path)', async () => {
    const size = 3 * 1024 * 1024; // 3 MiB: head 1 MiB, 1 MiB gap, tail 1 MiB
    const f = path.join(dir, 'big.bin');
    const buf = Buffer.alloc(size, 0x41);
    await writeFile(f, buf);
    const st = await stat(f);
    const keepMtime = async () => utimes(f, st.atime, st.mtime);
    await keepMtime();
    const base = await hashFile(f);

    const poke = async (pos: number) => {
      const fh = await open(f, 'r+');
      try { await fh.write(Buffer.from([0x42]), 0, 1, pos); } finally { await fh.close(); }
      await keepMtime();
      return hashFile(f);
    };
    expect(await poke(Math.floor(size / 2))).toBe(base); // middle byte: not sampled, same size+mtime
    expect(await poke(0)).not.toBe(base); // first byte
    const afterHead = await hashFile(f);
    expect(await poke(size - 1)).not.toBe(afterHead); // last byte
  });

  it('supports non-ASCII (Thai) file names', async () => {
    const f = path.join(dir, 'คลิป01.mov');
    await writeFile(f, Buffer.from('thai'));
    expect(await hashFile(f)).toMatch(/^[0-9a-f]{40}$/);
  });
});
