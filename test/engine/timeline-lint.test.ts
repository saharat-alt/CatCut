import { beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverTools } from '../../src/core/tools.js';
import { detectShots } from '../../src/engine/shots.js';
import { consumedFrames, lintTimeline, snapToShots, type ShotData } from '../../src/engine/timeline-lint.js';
import type { Clip, Cut, Project } from '../../src/core/types.js';

const FPS = 25;
/** source "src": shots [0,30) [30,60) [60,90) */
const SHOTS: ShotData = { frames: 90, cuts: [30, 60] };

function project(video: Clip[], cuts: Cut[] = [], extraAssets: Project['assets'] = {}): Project {
  return {
    meta: { name: 't', fps: FPS, width: 320, height: 180, createdAt: '2026-10-11T00:00:00Z', schema: 1 },
    dir: 'X:/nowhere',
    assets: {
      src: { id: 'src', kind: 'camera', path: 'X:/src.mov' },
      other: { id: 'other', kind: 'camera', path: 'X:/other.mov' },
      still: { id: 'still', kind: 'still', path: 'X:/card.png' },
      ...extraAssets,
    },
    timeline: { video, cuts, audio: { vo: [], music: [], sfx: [] } },
    delivery: { targets: [] },
    versions: [],
  };
}

const clip = (id: string, src: string, inF: number, dur: number, extra: Partial<Clip> = {}): Clip => ({ id, src, in: inF, dur, ...extra });
const kinds = (issues: Array<{ kind: string }>) => issues.map((i) => i.kind);

describe('lintTimeline', () => {
  it('reports a clip crossing a source shot change with frame, TC and side', () => {
    const p = project([clip('pad', 'other', 0, 50), clip('c1', 'src', 10, 40)]);
    const issues = lintTimeline(p, { src: SHOTS });
    expect(kinds(issues)).toEqual(['cutcross']);
    const i = issues[0]!;
    expect(i.clipId).toBe('c1');
    expect(i.sourceFrame).toBe(30);
    expect(i.startFrame).toBe(50 + 20);
    expect(i.tc).toBe('00:00:02:20');
    expect(i.side).toBe('head');
    expect(i.message).toContain('00:00:02:20');
  });

  it('flags a 3-frame flash at the head and at the tail', () => {
    const head = lintTimeline(project([clip('h', 'src', 27, 20)]), { src: SHOTS });
    expect(kinds(head)).toEqual(['flash']);
    expect(head[0]).toMatchObject({ side: 'head', startFrame: 0, endFrame: 3, sourceFrame: 30, clipId: 'h' });

    const tail = lintTimeline(project([clip('t', 'src', 35, 28)]), { src: SHOTS });
    expect(kinds(tail)).toEqual(['flash']);
    expect(tail[0]).toMatchObject({ side: 'tail', startFrame: 25, endFrame: 28, sourceFrame: 60 });

    // configurable threshold: 3 frames is fine when N = 3
    expect(lintTimeline(project([clip('h', 'src', 27, 20)]), { src: SHOTS }, { flashFrames: 3 }).map((x) => x.kind)).toEqual(['cutcross']);
  });

  it('sees a flash hidden in a dissolve handle (b frames after the outgoing out-point)', () => {
    // A ends at source 25; a 12-frame dissolve gives b = 6 tail frames → source 25..31 crosses the cut at 30.
    const p = project([clip('A', 'src', 5, 20), clip('B', 'other', 40, 30)], [{ after: 'A', dissolve: 12 }]);
    const issues = lintTimeline(p, { src: SHOTS });
    expect(kinds(issues)).toEqual(['flash']);
    expect(issues[0]).toMatchObject({ clipId: 'A', side: 'tail', sourceFrame: 30 });
    expect(issues[0]!.message).toContain('handle');
    // without the dissolve there is nothing to report
    expect(lintTimeline(project([clip('A', 'src', 5, 20), clip('B', 'other', 40, 30)]), { src: SHOTS })).toEqual([]);
  });

  it('reports repeats of overlapping source ranges within 3 clips only', () => {
    const adj = lintTimeline(project([clip('c1', 'src', 0, 20), clip('c2', 'src', 10, 20)]), {});
    expect(kinds(adj)).toEqual(['repeat']);
    expect(adj[0]).toMatchObject({ clipId: 'c2', startFrame: 20, endFrame: 30, sourceFrame: 10 });

    const near = lintTimeline(project([clip('c1', 'src', 0, 20), clip('x', 'other', 0, 10), clip('y', 'other', 50, 10), clip('c4', 'src', 5, 10)]), {});
    expect(kinds(near)).toEqual(['repeat']);
    expect(near[0]!.clipId).toBe('c4');

    const far = lintTimeline(project([clip('c1', 'src', 0, 20), clip('x', 'other', 0, 10), clip('y', 'other', 10, 10), clip('z', 'other', 20, 10), clip('c5', 'src', 5, 10)]), {});
    expect(far).toEqual([]);

    // continuation (no overlap) and stills are fine
    expect(lintTimeline(project([clip('c1', 'src', 0, 20), clip('c2', 'src', 20, 20), clip('s1', 'still', 0, 10), clip('s2', 'still', 0, 10)]), {})).toEqual([]);
  });

  it('suggests a push-in for long static footage (advisory)', () => {
    const still: ShotData = { frames: 300, cuts: [], motion: new Array<number>(300).fill(0.05) };
    const issues = lintTimeline(project([clip('s', 'src', 0, 150)]), { src: still });
    expect(kinds(issues)).toEqual(['lowmotion']);
    expect(issues[0]!.severity).toBe('warn');
    expect(issues[0]!.suggestion).toMatch(/pushIn 6–8/);
    expect(issues[0]!.endFrame! - issues[0]!.startFrame!).toBe(150);

    expect(lintTimeline(project([clip('s', 'src', 0, 150, { pushIn: 8 })]), { src: still })).toEqual([]);
    expect(lintTimeline(project([clip('s', 'src', 0, 75)]), { src: still })).toEqual([]); // 3 s < 4 s
    expect(lintTimeline(project([clip('s', 'src', 0, 150)]), { src: still }, { maxStaticSec: 10 })).toEqual([]);
    const p = project([clip('s', 'src', 0, 150)]);
    p.styleRules = { maxStaticSec: 8 };
    expect(lintTimeline(p, { src: still })).toEqual([]);
    // 50% slow motion stretches 75 source frames over 150 timeline frames → 6 s on screen
    expect(kinds(lintTimeline(project([clip('s', 'src', 0, 150, { speed: { rate: 0.5 } })]), { src: still }))).toEqual(['lowmotion']);

    const moving: ShotData = { frames: 300, cuts: [], motion: new Array<number>(300).fill(3) };
    expect(lintTimeline(project([clip('m', 'src', 0, 150)]), { src: moving })).toEqual([]);
  });

  it('accounts for Clip.speed when mapping source cuts to the timeline', () => {
    expect(consumedFrames(clip('a', 'src', 0, 40, { speed: { rate: 0.5 } }))).toBe(20);
    expect(consumedFrames(clip('a', 'src', 0, 20, { speed: { rate: 2 } }))).toBe(40);
    expect(consumedFrames(clip('a', 'src', 0, 33))).toBe(33);

    const slow = lintTimeline(project([clip('s', 'src', 20, 40, { speed: { rate: 0.5 } })]), { src: SHOTS });
    expect(kinds(slow)).toEqual(['cutcross']);
    expect(slow[0]!.startFrame).toBe(20); // source 30 is shown 20 timeline frames in

    const fast = lintTimeline(project([clip('f', 'src', 0, 30, { speed: { rate: 2 } })]), { src: SHOTS });
    expect(kinds(fast)).toEqual(['cutcross']);
    expect(fast[0]!.startFrame).toBe(15);

    // at 50% speed, 25 source frames past the in-point stay inside shot [0,30)
    expect(lintTimeline(project([clip('s', 'src', 0, 50, { speed: { rate: 0.5 } })]), { src: SHOTS })).toEqual([]);
  });

  it('flags clips shorter than N frames and can limit checks', () => {
    const issues = lintTimeline(project([clip('a', 'other', 0, 50), clip('tiny', 'other', 100, 3)]), {});
    expect(kinds(issues)).toEqual(['flash']);
    expect(lintTimeline(project([clip('c1', 'src', 0, 20), clip('c2', 'src', 10, 20)]), {}, { checks: ['flash'] })).toEqual([]);
  });
});

describe('snapToShots', () => {
  it('slides a head leak onto the shot start, keeping the duration', () => {
    const s = snapToShots(clip('h', 'src', 27, 20), SHOTS, 5);
    expect(s).toMatchObject({ changed: true, in: 30, dur: 20 });
    expect(lintTimeline(project([clip('h', 'src', s.in, s.dur)]), { src: SHOTS })).toEqual([]);
  });

  it('slides a tail leak back so the clip ends on the boundary', () => {
    const s = snapToShots(clip('t', 'src', 35, 28), SHOTS, 5);
    expect(s).toMatchObject({ changed: true, in: 32, dur: 28 });
  });

  it('leaves clean clips and far boundaries alone', () => {
    expect(snapToShots(clip('a', 'src', 30, 30), SHOTS, 5).changed).toBe(false);
    expect(snapToShots(clip('a', 'src', 10, 40), SHOTS, 5).changed).toBe(false); // mid-clip crossing: not a snap
  });

  it('needs allowDurChange when both ends leak or the source would be overrun', () => {
    const both = snapToShots(clip('b', 'src', 28, 34), SHOTS, 5);
    expect(both.changed).toBe(false);
    expect(both.warnings.length).toBe(1);
    expect(snapToShots(clip('b', 'src', 28, 34), SHOTS, 5, { allowDurChange: true })).toMatchObject({ changed: true, in: 30, dur: 30 });

    const short: ShotData = { frames: 50, cuts: [30] };
    const end = snapToShots(clip('e', 'src', 28, 22), short, 5);
    expect(end.changed).toBe(false); // sliding forward would run past the source end
    expect(snapToShots(clip('e', 'src', 28, 22), short, 5, { allowDurChange: true })).toMatchObject({ in: 30, dur: 20 });
  });

  it('includes dissolve handles and speed', () => {
    // tail handle of 6 makes source 25..31 visible → the cut at 30 leaks 1 frame → slide back by 1
    expect(snapToShots(clip('A', 'src', 5, 20), SHOTS, 5, { tailHandle: 6 })).toMatchObject({ changed: true, in: 4, dur: 20 });
    // 200%: in 26, dur 10 consumes 20 → head leak of 4 source frames = 2 timeline frames
    expect(snapToShots(clip('f', 'src', 26, 10, { speed: { rate: 2 } }), SHOTS, 3)).toMatchObject({ changed: true, in: 30, dur: 10 });
  });
});

describe('lint with a detected shot index', () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const DIR = join(ROOT, 'tmp', 'test-media', 'lint', 'ลินต์');
  const SRC = join(DIR, 'three.mov');
  let shots: ShotData;

  beforeAll(async () => {
    const tools = discoverTools();
    await rm(join(ROOT, 'tmp', 'test-media', 'lint'), { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    const r = await execa(tools.ffmpeg, [
      '-hide_banner', '-nostats', '-nostdin', '-y',
      '-f', 'lavfi', '-i', 'color=red:size=320x180:rate=25:duration=1.2',
      '-f', 'lavfi', '-i', 'color=green:size=320x180:rate=25:duration=1.2',
      '-f', 'lavfi', '-i', 'color=blue:size=320x180:rate=25:duration=1.2',
      '-filter_complex', '[0:v]trim=end_frame=30[a];[1:v]trim=end_frame=30[b];[2:v]trim=end_frame=30[c];[a][b][c]concat=n=3:v=1:a=0[v]',
      '-map', '[v]', '-c:v', 'mjpeg', '-q:v', '3', SRC,
    ], { reject: false, windowsHide: true });
    if (r.exitCode !== 0) throw new Error(r.stderr);
    shots = await detectShots(tools, SRC, { fps: FPS });
  });

  it('cutcross and flash from real media', () => {
    const p = project([clip('cross', 'src', 50, 20), clip('flash', 'src', 28, 10)]);
    const issues = lintTimeline(p, new Map([['src', shots]]));
    expect(issues.find((i) => i.clipId === 'cross')?.kind).toBe('cutcross');
    expect(issues.find((i) => i.clipId === 'flash')?.kind).toBe('flash');
  });
});
