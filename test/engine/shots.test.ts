import { beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverTools } from '../../src/core/tools.js';
import { detectShots, loadCachedShots, shotCachePath } from '../../src/engine/shots.js';
import type { ToolPaths } from '../../src/core/types.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Thai folder + file name: the path must only ever be an -i argument.
const MEDIA = join(ROOT, 'tmp', 'test-media', 'shots', 'ช็อต');
const CACHE = join(ROOT, 'tmp', 'test-media', 'shots', 'cache');
/** 90 frames @25, 320x180 H.264 long-GOP: testsrc2 (moving) f0–29, blue f30–59, yellow f60–89. */
const THREE = join(MEDIA, 'สามช็อต.mp4');

let tools: ToolPaths;

beforeAll(async () => {
  tools = discoverTools();
  await rm(join(ROOT, 'tmp', 'test-media', 'shots'), { recursive: true, force: true });
  await mkdir(MEDIA, { recursive: true });
  const r = await execa(tools.ffmpeg, [
    '-hide_banner', '-nostats', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=1.2',
    '-f', 'lavfi', '-i', 'color=0x2040c0:size=320x180:rate=25:duration=1.2',
    '-f', 'lavfi', '-i', 'color=0xe0d020:size=320x180:rate=25:duration=1.2',
    '-filter_complex',
    '[0:v]trim=end_frame=30,setpts=PTS-STARTPTS[a];[1:v]trim=end_frame=30,setpts=PTS-STARTPTS[b];[2:v]trim=end_frame=30,setpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=1:a=0,format=yuv420p[v]',
    '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '250', THREE,
  ], { reject: false, windowsHide: true });
  if (r.exitCode !== 0) throw new Error(r.stderr.split(/\r?\n/).slice(-5).join('\n'));
});

describe('detectShots', () => {
  it('finds the two cuts within ±1 frame and scores motion per shot', async () => {
    const idx = await detectShots(tools, THREE, { fps: 25, cacheDir: CACHE });
    expect(idx.cached).toBe(false);
    expect(idx.frames).toBe(90);
    expect(idx.cuts).toHaveLength(2);
    expect(Math.abs(idx.cuts[0]! - 30)).toBeLessThanOrEqual(1);
    expect(Math.abs(idx.cuts[1]! - 60)).toBeLessThanOrEqual(1);
    expect(idx.shots).toHaveLength(3);
    expect(idx.shots[0]!.motion).toBeGreaterThan(0.5); // testsrc2 moves
    expect(idx.shots[1]!.motion).toBeLessThan(0.1); // solid colour
    expect(idx.shots[2]!.motion).toBeLessThan(0.1);
    expect(idx.motion).toHaveLength(90);
    expect(existsSync(shotCachePath(CACHE, idx.fileHash))).toBe(true);
  });

  it('reuses the cache keyed by file hash + threshold + ffmpeg version + fps', async () => {
    const a = await detectShots(tools, THREE, { fps: 25, cacheDir: CACHE });
    expect(a.cached).toBe(true);
    expect(a.cuts.length).toBe(2);
    expect(a.motion).toHaveLength(90);
    // quantised motion survives the round trip closely
    expect(a.shots[0]!.motion).toBeGreaterThan(0.5);

    const other = await detectShots(tools, THREE, { fps: 25, cacheDir: CACHE, threshold: 20 });
    expect(other.cached).toBe(false);
    const file = JSON.parse(await readFile(shotCachePath(CACHE, a.fileHash), 'utf8')) as { entries: unknown[] };
    expect(file.entries).toHaveLength(2); // both thresholds kept side by side

    const hit = await loadCachedShots(CACHE, a.fileHash, { fps: 25, ffmpegVersion: a.ffmpegVersion });
    expect(hit?.cuts).toEqual(a.cuts);
    expect(await loadCachedShots(CACHE, a.fileHash, { fps: 25, ffmpegVersion: 'other' })).toBeUndefined();
  });

  it('expresses frames at the project fps', async () => {
    const idx = await detectShots(tools, THREE, { fps: 50 });
    expect(idx.frames).toBeGreaterThanOrEqual(179);
    expect(Math.abs(idx.cuts[0]! - 60)).toBeLessThanOrEqual(2);
    expect(Math.abs(idx.cuts[1]! - 120)).toBeLessThanOrEqual(2);
  });

  it('aborts through the signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(detectShots(tools, THREE, { fps: 25, signal: ac.signal, timeoutMs: 30_000 })).rejects.toThrow(/cancel/i);
  });
});
