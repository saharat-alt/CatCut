import { beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverTools } from '../../src/core/tools.js';
import { applyAliases, fixMojibake, scanFootage, slotOf } from '../../src/engine/scan.js';
import type { ToolPaths } from '../../src/core/types.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = join(ROOT, 'tmp', 'test-media', 'scan');
const DIR = join(BASE, 'ฟุตเทจ');
const PROJECT = join(BASE, 'project');
/** 'คลิป' as UTF-8 bytes shown through cp437 (what a zip tool without the UTF-8 flag produces). */
const MOJI = 'α╕äα╕Ñα╕┤α╕¢';

let tools: ToolPaths;

async function ff(args: string[]): Promise<void> {
  const r = await execa(tools.ffmpeg, ['-hide_banner', '-nostats', '-nostdin', '-y', ...args], { reject: false, windowsHide: true });
  if (r.exitCode !== 0) throw new Error(r.stderr.split(/\r?\n/).slice(-5).join('\n'));
}

beforeAll(async () => {
  tools = discoverTools();
  await rm(BASE, { recursive: true, force: true });
  await mkdir(join(DIR, 'sub'), { recursive: true });
  const x264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=1', '-f', 'lavfi', '-i', 'sine=duration=1', ...x264, '-c:a', 'aac', '-ac', '2', join(DIR, `01_${MOJI}.mp4`)]);
  // 4:3 picture pillarboxed inside 16:9
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=960x720:rate=25:duration=2', '-vf', 'pad=1280:720:160:0:black', ...x264, join(DIR, '02_pillar.mp4')]);
  // 12 fps: odd for a 25 fps project
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12:duration=1', ...x264, join(DIR, '03 odd.mp4')]);
  // variable frame rate: first second at 12.5 fps, then 25 fps
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=2', '-vf', "setpts='if(lt(N,25),N*2,N+25)/25/TB'", '-fps_mode', 'vfr', ...x264, join(DIR, 'vfr.mp4')]);
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=1', ...x264, join(DIR, 'sub', '05a_deep.mp4')]);
  await writeFile(join(DIR, 'readme.txt'), 'not media', 'utf8');
});

describe('fixMojibake', () => {
  it('recovers Thai from cp437-misdecoded UTF-8', () => {
    expect(fixMojibake(MOJI)).toBe('คลิป');
    expect(fixMojibake(`01_${MOJI}.mp4`)).toBe('01_คลิป.mp4');
  });

  it('recovers Thai from cp1252/latin1-misdecoded UTF-8 and from TIS-620 bytes', () => {
    expect(fixMojibake('à¸„à¸¥à¸´à¸›')).toBe('คลิป'); // cp1252 view of the UTF-8 bytes
    expect(fixMojibake('ñ┼╘╗.mov')).toBe('คลิป.mov'); // TIS-620 bytes A4 C5 D4 BB through cp437
  });

  it('leaves correct names alone', () => {
    expect(fixMojibake('คลิป.mp4')).toBeUndefined();
    expect(fixMojibake('clip_01.mov')).toBeUndefined();
    expect(fixMojibake('Café.mov')).toBeUndefined(); // é alone is not valid UTF-8 bytes
  });
});

describe('slotOf', () => {
  it('reads leading digits (+ letter) for board matching', () => {
    expect(slotOf('01_a.mov')).toBe('01');
    expect(slotOf('28r_x.mov')).toBe('28r');
    expect(slotOf('03 odd.mp4')).toBe('03');
    expect(slotOf('clip.mov')).toBeUndefined();
  });
});

describe('scanFootage', () => {
  it('inventories media, flags problems and proposes fixed names without renaming', async () => {
    const r = await scanFootage(tools, DIR, { projectFps: 25 });
    expect(r.files.map((f) => f.name).sort()).toEqual([`01_${MOJI}.mp4`, '02_pillar.mp4', '03 odd.mp4', 'vfr.mp4']);

    const moji = r.files.find((f) => f.name.startsWith('01_'))!;
    expect(moji.flags).toContain('mojibake');
    expect(moji.fixedRel).toBe('01_คลิป.mp4');
    expect(moji.slot).toBe('01');
    expect(moji.probe).toMatchObject({ width: 320, height: 180, fps: 25, videoCodec: 'h264', audioChannels: 2, vfr: false });
    expect(moji.flags).toContain('low-res');
    expect(r.renamePlan).toEqual([{ from: `01_${MOJI}.mp4`, to: '01_คลิป.mp4' }]);
    expect(existsSync(join(DIR, `01_${MOJI}.mp4`))).toBe(true); // user file untouched

    const pil = r.files.find((f) => f.name === '02_pillar.mp4')!;
    expect(pil.flags).toContain('pillarbox');
    expect(pil.flags).not.toContain('letterbox');
    expect(pil.flags).not.toContain('low-res');
    expect(Math.abs(pil.activeArea!.w - 960)).toBeLessThanOrEqual(4);
    expect(Math.abs(pil.activeArea!.x - 160)).toBeLessThanOrEqual(4);

    const odd = r.files.find((f) => f.name === '03 odd.mp4')!;
    expect(odd.flags).toEqual(expect.arrayContaining(['odd-fps', 'fps-mismatch']));

    const vfr = r.files.find((f) => f.name === 'vfr.mp4')!;
    expect(vfr.flags).toContain('vfr');
    expect(vfr.slot).toBeUndefined();

    expect(r.slots['01']).toEqual(['01_คลิป.mp4']);
    expect(r.slots['02']).toEqual(['02_pillar.mp4']);
    expect(r.unslotted).toEqual(['vfr.mp4']);
    expect(r.summary['files']).toBe(4);
  });

  it('recurses on request', async () => {
    const r = await scanFootage(tools, DIR, { recursive: true, crop: false });
    const deep = r.files.find((f) => f.name === '05a_deep.mp4');
    expect(deep?.slot).toBe('05a');
    expect(r.files.every((f) => f.activeArea === undefined)).toBe(true);
  });

  it('creates correctly named aliases inside the project only, never overwriting', async () => {
    const r = await scanFootage(tools, DIR, { crop: false });
    const aliasDir = join(PROJECT, 'media-aliases');
    const a = await applyAliases(r, aliasDir);
    expect(a.created).toHaveLength(1);
    expect(a.created[0]!.alias).toBe(join(aliasDir, '01_คลิป.mp4'));
    expect(existsSync(join(aliasDir, '01_คลิป.mp4'))).toBe(true);
    expect(existsSync(join(DIR, `01_${MOJI}.mp4`))).toBe(true);
    const index = JSON.parse(await readFile(a.index, 'utf8')) as Record<string, string>;
    expect(index[join(aliasDir, '01_คลิป.mp4')]).toBe(join(DIR, `01_${MOJI}.mp4`));

    const again = await applyAliases(r, aliasDir);
    expect(again.created).toHaveLength(0);
    expect(again.skipped[0]!.reason).toBe('exists');
  });
});
