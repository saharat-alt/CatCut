import { describe, expect, it } from 'vitest';
import { XMLParser } from 'fast-xml-parser';
import type { Project, Timeline } from '../../src/core/types.js';
import { pathFromUrl, pathToUrl, readXmeml, writeXmeml } from '../../src/io/xmeml.js';

function makeProject(timeline: Timeline): Project {
  return {
    meta: { name: 'rt', fps: 25, width: 1920, height: 1080, createdAt: '2026-01-01T00:00:00.000Z', schema: 1 },
    dir: 'D:\\EDITMCP\\tmp\\xmeml-proj',
    assets: {
      cam: {
        id: 'cam',
        kind: 'camera',
        path: 'D:\\งาน\\ฟุตเทจ\\คลิป 01.mp4',
        probe: { durationFrames: 1000, width: 1920, height: 1080, fps: 25, hasVideo: true, hasAudio: true, channels: 2, sampleRate: 48000 },
      },
      title: {
        id: 'title',
        kind: 'aecomp',
        aep: 'D:\\งาน\\title.aep',
        comp: 'Title 01',
        fingerprint: 'abc',
        render: { path: 'D:\\EDITMCP\\tmp\\cache\\title_abcdef12.mov', frames: 400, fingerprint: 'abc', renderedAt: '2026-01-01T00:00:00.000Z' },
        probe: { durationFrames: 400, width: 1920, height: 1080, fps: 25, hasVideo: true, hasAudio: false, allIntra: true },
      },
      still: { id: 'still', kind: 'still', path: 'D:\\งาน\\logo.png', probe: { durationFrames: 1, width: 800, height: 600, hasVideo: true, hasAudio: false } },
      vo: {
        id: 'vo',
        kind: 'audio',
        path: 'D:\\งาน\\vo\\เสียงบรรยาย.wav',
        probe: { durationFrames: 300, hasVideo: false, hasAudio: true, channels: 1, sampleRate: 48000 },
      },
      mus: { id: 'mus', kind: 'audio', path: 'D:\\งาน\\music\\bed.wav', probe: { durationFrames: 2000, hasVideo: false, hasAudio: true, channels: 2 } },
    },
    timeline,
    delivery: { targets: [] },
    versions: [],
  };
}

/** Canonical timeline: explicit cuts for every pair, `in`/`dur` on audio, defaults omitted. */
function richTimeline(): Timeline {
  return {
    video: [
      { id: 'c1', src: 'cam', in: 10, dur: 100, marker: 'เปิดเรื่อง' },
      { id: 'c2', src: 'title', in: 0, dur: 120, scale: 110 },
      { id: 'c3', src: 'cam', in: 300, dur: 80, marker: 'Scene 3' },
      { id: 'c4', src: 'still', in: 10, dur: 50 },
    ],
    cuts: [
      { after: 'c1', dissolve: 0 },
      { after: 'c2', dissolve: 10 },
      { after: 'c3', dissolve: 13 },
    ],
    audio: {
      vo: [{ id: 'vo1', src: 'vo', at: 20, dur: 150, gainDb: -3, fadeIn: 5, fadeOut: 10 }],
      music: [{ id: 'm1', src: 'mus', at: 0, in: 100, dur: 350, gainDb: -12 }],
      sfx: [
        { id: 's1', src: 'vo', at: 200, dur: 25 },
        { id: 's2', src: 'vo', at: 210, dur: 20 }, // overlaps s1 -> overflow lane A6
      ],
      duck: { underDb: -12, attackMs: 50, releaseMs: 300 },
    },
  };
}

const parse = (xml: string): Record<string, unknown> =>
  new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: true, isArray: (n) => ['track', 'clipitem', 'transitionitem', 'marker', 'link', 'keyframe'].includes(n) }).parse(xml) as Record<string, unknown>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const get = (o: unknown, ...ks: Array<string | number>): any => ks.reduce<any>((cur, k) => (cur == null ? undefined : cur[k]), o);

describe('writeXmeml', () => {
  const p = makeProject(richTimeline());
  const xml = writeXmeml(p, { sequenceName: 'ตัดต่อ v1' });
  const doc = parse(xml);
  const seq = get(doc, 'xmeml', 'sequence');
  const v1 = get(seq, 'media', 'video', 'track', 0);

  it('is deterministic and declares UTF-8 xmeml v5', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5">')).toBe(true);
    expect(writeXmeml(p, { sequenceName: 'ตัดต่อ v1' })).toBe(xml);
    expect(get(seq, 'name')).toBe('ตัดต่อ v1');
    expect(get(seq, 'duration')).toBe(350);
    expect(get(seq, 'rate', 'timebase')).toBe(25);
    expect(get(seq, 'rate', 'ntsc')).toBe('FALSE');
    expect(get(seq, 'media', 'video', 'format', 'samplecharacteristics', 'width')).toBe(1920);
  });

  it('writes centered transitions with -1 touching edges and extended in/out (even 10, odd 13)', () => {
    const items = v1.clipitem;
    const trans = v1.transitionitem;
    expect(items).toHaveLength(4);
    expect(trans).toHaveLength(2);
    // c1: hard cut after
    expect([get(items, 0, 'start'), get(items, 0, 'end'), get(items, 0, 'in'), get(items, 0, 'out')]).toEqual([0, 100, 10, 110]);
    // c2 -> c3 dissolve 10 at C=220: a=5, b=5 -> [215, 225)
    expect([get(trans, 0, 'start'), get(trans, 0, 'end'), get(trans, 0, 'alignment')]).toEqual([215, 225, 'center']);
    expect([get(items, 1, 'start'), get(items, 1, 'end'), get(items, 1, 'in'), get(items, 1, 'out')]).toEqual([100, -1, 0, 125]);
    // c3 -> c4 dissolve 13 at C=300: a=6, b=7 -> [294, 307)
    expect([get(trans, 1, 'start'), get(trans, 1, 'end')]).toEqual([294, 307]);
    expect([get(items, 2, 'start'), get(items, 2, 'end'), get(items, 2, 'in'), get(items, 2, 'out')]).toEqual([-1, -1, 295, 387]);
    expect([get(items, 3, 'start'), get(items, 3, 'end'), get(items, 3, 'in'), get(items, 3, 'out')]).toEqual([-1, 350, 4, 60]);
    const eff = get(trans, 0, 'effect');
    expect(eff.name).toBe('Cross Dissolve');
    expect(eff.effectid).toBe('Cross Dissolve');
    expect(eff.effecttype).toBe('transition');
    expect(eff.mediatype).toBe('video');
    expect(eff.reverse).toBe('FALSE');
    expect(eff.endratio).toBe(1);
  });

  it('references files by stable ids after the first full definition and percent-encodes Thai pathurls', () => {
    const items = v1.clipitem;
    expect(get(items, 0, 'file', '@_id')).toBe('file-cam');
    expect(get(items, 0, 'file', 'pathurl')).toBe('file://localhost/D%3a/%E0%B8%87%E0%B8%B2%E0%B8%99/%E0%B8%9F%E0%B8%B8%E0%B8%95%E0%B9%80%E0%B8%97%E0%B8%88/%E0%B8%84%E0%B8%A5%E0%B8%B4%E0%B8%9B%2001.mp4');
    expect(get(items, 0, 'file', 'name')).toBe('คลิป 01.mp4');
    expect(get(items, 0, 'file', 'duration')).toBe(1000);
    expect(get(items, 0, 'file', 'media', 'audio', 'channelcount')).toBe(2);
    expect(get(items, 2, 'file')).toEqual({ '@_id': 'file-cam' }); // second use of cam: id only
    expect(get(items, 1, 'file', 'pathurl')).toBe('file://localhost/D%3a/EDITMCP/tmp/cache/title_abcdef12.mov'); // aecomp -> render path
    expect(get(items, 1, 'file', 'media', 'audio')).toBeUndefined();
    expect(get(items, 3, 'file', 'duration')).toBe(60); // still: duration covers the furthest out
    expect(get(items, 0, '@_id')).toBe('clipitem-c1');
    expect(get(items, 0, 'name')).toBe('c1');
  });

  it('writes Basic Motion scale only when != 100 and sequence markers at clip starts', () => {
    const items = v1.clipitem;
    expect(get(items, 0, 'filter')).toBeUndefined();
    const motion = get(items, 1, 'filter', 'effect');
    expect(motion.name).toBe('Basic Motion');
    expect(motion.effectid).toBe('basic');
    expect(get(motion, 'parameter', 'parameterid')).toBe('scale');
    expect(get(motion, 'parameter', 'value')).toBe(110);
    const markers = get(seq, 'marker');
    expect(markers.map((m: Record<string, unknown>) => [m.name, m.in, m.out])).toEqual([
      ['เปิดเรื่อง', 0, -1],
      ['Scene 3', 220, -1],
    ]);
  });

  it('lays out audio as exploded stereo pairs: A1/A2 clip audio, A3/A4 vo, A5/A6 music, A7/A8 sfx, A9/A10 overflow', () => {
    const tracks = get(seq, 'media', 'audio', 'track');
    expect(tracks).toHaveLength(10);
    const attrs = (i: number) => [get(tracks, i, '@_currentExplodedTrackIndex'), get(tracks, i, '@_totalExplodedTrackCount'), get(tracks, i, '@_premiereTrackType'), get(tracks, i, '@_MZ.TrackName'), get(tracks, i, 'outputchannelindex')];
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(attrs)).toEqual([
      ['0', '2', 'Stereo', 'Clip Audio', 1], ['1', '2', 'Stereo', 'Clip Audio', 2],
      ['0', '2', 'Stereo', 'VO', 1], ['1', '2', 'Stereo', 'VO', 2],
      ['0', '2', 'Stereo', 'Music', 1], ['1', '2', 'Stereo', 'Music', 2],
      ['0', '2', 'Stereo', 'SFX', 1], ['1', '2', 'Stereo', 'SFX', 2],
      ['0', '2', 'Stereo', 'SFX 2', 1], ['1', '2', 'Stereo', 'SFX 2', 2],
    ]);
    // A1: c1 and c3 (cam has audio); hard cut at C=220 because the title has no audio
    const a1 = get(tracks, 0, 'clipitem');
    expect(a1.map((c: Record<string, unknown>) => [c.name, c.start, c.end, c.in, c.out])).toEqual([
      ['c1', 0, 100, 10, 110],
      ['c3', 220, 300, 300, 380],
    ]);
    expect(get(a1, 0, '@_premiereChannelType')).toBe('stereo');
    expect(get(a1, 0, 'sourcetrack', 'trackindex')).toBe(1);
    expect(get(tracks, 1, 'clipitem', 0, 'sourcetrack', 'trackindex')).toBe(2);
    expect(get(tracks, 0, 'transitionitem')).toBeUndefined();
    // links: video item lists itself + both audio channels; clipindex counts clipitems on that track
    const vLinks = get(v1, 'clipitem', 2, 'link');
    expect(vLinks.map((l: Record<string, unknown>) => [l.linkclipref, l.mediatype, l.trackindex, l.clipindex])).toEqual([
      ['clipitem-c3', 'video', 1, 3],
      ['clipitem-c3-a1', 'audio', 1, 2],
      ['clipitem-c3-a2', 'audio', 2, 2],
    ]);
    expect(get(v1, 'clipitem', 1, 'link')).toBeUndefined();
    // A3/A4 vo pair with levels + fades; the source is mono so both sides read channel 1
    const vo1 = get(tracks, 2, 'clipitem', 0);
    const vo1r = get(tracks, 3, 'clipitem', 0);
    expect([vo1.name, vo1.start, vo1.end, vo1.in, vo1.out]).toEqual(['vo1', 20, 170, 0, 150]);
    expect([vo1r.name, vo1r.start, vo1r.end, vo1r.in, vo1r.out]).toEqual(['vo1', 20, 170, 0, 150]);
    expect([get(vo1, 'sourcetrack', 'trackindex'), get(vo1r, 'sourcetrack', 'trackindex')]).toEqual([1, 1]);
    expect(vo1['@_id']).toBe('clipitem-vo1');
    expect(vo1r['@_id']).toBe('clipitem-vo1-r');
    for (const it of [vo1, vo1r]) {
      expect(it.link.map((l: Record<string, unknown>) => [l.linkclipref, l.mediatype, l.trackindex, l.clipindex, l.groupindex])).toEqual([
        ['clipitem-vo1', 'audio', 3, 1, 1],
        ['clipitem-vo1-r', 'audio', 4, 1, 1],
      ]);
    }
    const level = get(vo1, 'filter', 'effect', 'parameter');
    expect(get(vo1, 'filter', 'effect', 'effectid')).toBe('audiolevels');
    expect(level.value).toBeCloseTo(0.707946, 5);
    expect(level.keyframe.map((k: Record<string, unknown>) => [k.when, k.value])).toEqual([
      [0, 0],
      [5, 0.707946],
      [140, 0.707946],
      [150, 0],
    ]);
    expect(get(vo1r, 'filter', 'effect', 'parameter', 'value')).toBeCloseTo(0.707946, 5);
    // A5/A6 music: stereo source -> sourcetrack 1 and 2
    const m1 = get(tracks, 4, 'clipitem', 0);
    expect([m1.name, m1.start, m1.end, m1.in, m1.out]).toEqual(['m1', 0, 350, 100, 450]);
    expect([get(m1, 'sourcetrack', 'trackindex'), get(tracks, 5, 'clipitem', 0, 'sourcetrack', 'trackindex')]).toEqual([1, 2]);
    expect(get(m1, 'filter', 'effect', 'parameter', 'value')).toBeCloseTo(0.251189, 5);
    expect(get(m1, 'filter', 'effect', 'parameter', 'keyframe')).toBeUndefined();
    expect(get(tracks, 5, 'clipitem', 0, 'link', 1, 'trackindex')).toBe(6);
    // A7/A8 sfx, A9/A10 overflow
    expect(get(tracks, 6, 'clipitem', 0, 'name')).toBe('s1');
    expect(get(tracks, 6, 'clipitem')).toHaveLength(1);
    expect(get(tracks, 7, 'clipitem', 0, 'name')).toBe('s1');
    expect(get(tracks, 8, 'clipitem', 0, 'name')).toBe('s2');
    expect(get(tracks, 9, 'clipitem', 0, 'link', 1, 'trackindex')).toBe(10);
    expect(get(tracks, 6, 'clipitem', 0, 'filter')).toBeUndefined();
  });

  it('adds an audio cross fade when both sides of a dissolve carry clip audio', () => {
    const t: Timeline = {
      video: [
        { id: 'a', src: 'cam', in: 0, dur: 50 },
        { id: 'b', src: 'cam', in: 500, dur: 50 },
      ],
      cuts: [{ after: 'a', dissolve: 8 }],
      audio: { vo: [], music: [], sfx: [] },
    };
    const d = parse(writeXmeml(makeProject(t), { sequenceName: 'xf' }));
    const a1 = get(d, 'xmeml', 'sequence', 'media', 'audio', 'track', 0);
    expect(a1.clipitem.map((c: Record<string, unknown>) => [c.start, c.end, c.in, c.out])).toEqual([
      [0, -1, 0, 54],
      [-1, 100, 496, 550],
    ]);
    expect([get(a1, 'transitionitem', 0, 'start'), get(a1, 'transitionitem', 0, 'end')]).toEqual([46, 54]);
    expect(get(a1, 'transitionitem', 0, 'effect', 'name')).toBe('Cross Fade (+3dB)');
    expect(get(a1, 'transitionitem', 0, 'effect', 'effectid')).toBe('KGAudioTransCrossFade3dB');
    expect(get(a1, 'transitionitem', 0, 'effect', 'mediatype')).toBe('audio');
  });

  it('honours useClipAudio=false and a custom resolvePath', () => {
    const t = richTimeline();
    t.audio.useClipAudio = false;
    const d = parse(writeXmeml(makeProject(t), { sequenceName: 's', resolvePath: (a) => (a.id === 'cam' ? 'E:\\proxy\\cam.mov' : undefined) || (a.kind === 'aecomp' ? a.render?.path : a.path) }));
    const tracks = get(d, 'xmeml', 'sequence', 'media', 'audio', 'track');
    expect(get(tracks, 0, 'clipitem')).toBeUndefined();
    expect(get(tracks, 1, 'clipitem')).toBeUndefined();
    expect(get(d, 'xmeml', 'sequence', 'media', 'video', 'track', 0, 'clipitem', 0, 'file', 'pathurl')).toBe('file://localhost/E%3a/proxy/cam.mov');
  });

  it('fails loudly on an unrendered aecomp, unknown asset, or missing dissolve handle', () => {
    const t: Timeline = { video: [{ id: 'x', src: 'title', in: 0, dur: 10 }], cuts: [], audio: { vo: [], music: [], sfx: [] } };
    const p2 = makeProject(t);
    delete (p2.assets.title as { render?: unknown }).render;
    expect(() => writeXmeml(p2, { sequenceName: 's' })).toThrow(/no file path/);
    expect(() => writeXmeml(makeProject({ ...t, video: [{ id: 'x', src: 'nope', in: 0, dur: 10 }] }), { sequenceName: 's' })).toThrow(/unknown asset 'nope'/);
    const noHandle: Timeline = {
      video: [
        { id: 'a', src: 'cam', in: 0, dur: 50 },
        { id: 'b', src: 'cam', in: 2, dur: 50 },
      ],
      cuts: [{ after: 'a', dissolve: 10 }],
      audio: { vo: [], music: [], sfx: [] },
    };
    expect(() => writeXmeml(makeProject(noHandle), { sequenceName: 's' })).toThrow(/handle/);
  });
});

describe('round trip', () => {
  it('write -> read gives the identical timeline (dissolves 0/10/13, markers, scale 110, audio levels, overflow lane)', () => {
    const p = makeProject(richTimeline());
    const xml = writeXmeml(p, { sequenceName: 'rt' });
    const r = readXmeml(xml, p);
    expect(r.fps).toBe(25);
    expect(r.width).toBe(1920);
    expect(r.height).toBe(1080);
    expect(r.unresolvedPaths).toEqual([]);
    expect(r.timeline).toEqual(richTimeline());
    expect(r.warnings).toEqual([]); // the overflow pair is named 'SFX 2', so its role is not guessed
  });

  it('round-trips useClipAudio=false and sources without audio', () => {
    const t = richTimeline();
    t.audio.useClipAudio = false;
    const p = makeProject(t);
    expect(readXmeml(writeXmeml(p, { sequenceName: 'rt' }), p).timeline.audio.useClipAudio).toBe(false);
    const silent: Timeline = { video: [{ id: 'only', src: 'title', in: 5, dur: 30 }], cuts: [], audio: { vo: [], music: [], sfx: [] } };
    const p2 = makeProject(silent);
    expect(readXmeml(writeXmeml(p2, { sequenceName: 'rt' }), p2).timeline).toEqual(silent);
  });

  it('round-trips 29.97 (ntsc TRUE) rates', () => {
    const p = makeProject({ video: [{ id: 'a', src: 'cam', in: 0, dur: 30 }], cuts: [], audio: { vo: [], music: [], sfx: [] } });
    p.meta.fps = 29.97;
    const xml = writeXmeml(p, { sequenceName: 'ntsc' });
    expect(xml).toContain('<timebase>30</timebase>');
    expect(xml).toContain('<ntsc>TRUE</ntsc>');
    expect(readXmeml(xml).fps).toBe(29.97);
  });

  it('lists unresolved paths and keeps the decoded path as src when no project is given', () => {
    const p = makeProject(richTimeline());
    const r = readXmeml(writeXmeml(p, { sequenceName: 'rt' }));
    expect(r.unresolvedPaths).toEqual(['D:\\งาน\\ฟุตเทจ\\คลิป 01.mp4', 'D:\\EDITMCP\\tmp\\cache\\title_abcdef12.mov', 'D:\\งาน\\logo.png', 'D:\\งาน\\vo\\เสียงบรรยาย.wav', 'D:\\งาน\\music\\bed.wav']);
    expect(r.timeline.video.map((c) => c.src)).toEqual(['D:\\งาน\\ฟุตเทจ\\คลิป 01.mp4', 'D:\\EDITMCP\\tmp\\cache\\title_abcdef12.mov', 'D:\\งาน\\ฟุตเทจ\\คลิป 01.mp4', 'D:\\งาน\\logo.png']);
    expect(r.timeline.audio.duck).toBeUndefined();
    // the caller can map paths itself
    const r2 = readXmeml(writeXmeml(p, { sequenceName: 'rt' }), undefined, { resolveAsset: (abs) => (abs.endsWith('.mp4') ? 'cam' : undefined) });
    expect(r2.timeline.video[0]?.src).toBe('cam');
    expect(r2.unresolvedPaths).not.toContain('D:\\งาน\\ฟุตเทจ\\คลิป 01.mp4');
  });
});

/** Shaped like a Premiere "Final Cut Pro XML" export: version 4, %3a drive, -1 edges, center transition, id-only file refs, pproTicks noise. */
const PREMIERE_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-1" TL.SQAudioVisibleBase="0" explodedTracks="true">
    <uuid>5a1d6c2e-0000-4000-8000-000000000001</uuid>
    <duration>300</duration>
    <rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>
    <name>ตัดต่อ v1</name>
    <media>
      <video>
        <format>
          <samplecharacteristics>
            <rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>
            <codec><name>Apple ProRes 422</name></codec>
            <width>1920</width><height>1080</height>
            <anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance><colordepth>24</colordepth>
          </samplecharacteristics>
        </format>
        <track TL.SQTrackShy="0" MZ.TrackTargeted="1">
          <clipitem id="clipitem-1">
            <masterclipid>masterclip-1</masterclipid>
            <name>คลิป 01.mp4</name>
            <enabled>TRUE</enabled>
            <duration>1000</duration>
            <rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>
            <start>0</start>
            <end>-1</end>
            <in>0</in>
            <out>110</out>
            <pproTicksIn>0</pproTicksIn>
            <pproTicksOut>1117432320000</pproTicksOut>
            <alphatype>none</alphatype>
            <pixelaspectratio>square</pixelaspectratio>
            <anamorphic>FALSE</anamorphic>
            <file id="file-1">
              <name>คลิป 01.mp4</name>
              <pathurl>file://localhost/D%3a/%E0%B8%87%E0%B8%B2%E0%B8%99/%E0%B8%84%E0%B8%A5%E0%B8%B4%E0%B8%9B%2001.mp4</pathurl>
              <rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>
              <duration>1000</duration>
              <timecode><rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate><string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>
              <media>
                <video><samplecharacteristics><rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate><width>1920</width><height>1080</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video>
                <audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>
              </media>
            </file>
            <filter>
              <effect>
                <name>Basic Motion</name>
                <effectid>basic</effectid>
                <effectcategory>motion</effectcategory>
                <effecttype>motion</effecttype>
                <mediatype>video</mediatype>
                <pproBypass>false</pproBypass>
                <parameter authoringApp="PremierePro"><parameterid>scale</parameterid><name>Scale</name><valuemin>0</valuemin><valuemax>1000</valuemax><value>100</value></parameter>
                <parameter authoringApp="PremierePro"><parameterid>rotation</parameterid><name>Rotation</name><valuemin>-8640</valuemin><valuemax>8640</valuemax><value>0</value></parameter>
                <parameter authoringApp="PremierePro"><parameterid>center</parameterid><name>Center</name><value><horiz>0</horiz><vert>0</vert></value></parameter>
              </effect>
            </filter>
            <link><linkclipref>clipitem-1</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>1</clipindex></link>
            <link><linkclipref>clipitem-3</linkclipref><mediatype>audio</mediatype><trackindex>1</trackindex><clipindex>1</clipindex><groupindex>1</groupindex></link>
          </clipitem>
          <transitionitem>
            <start>90</start>
            <end>110</end>
            <alignment>center</alignment>
            <cutPointTicks>1016064000000</cutPointTicks>
            <rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>
            <effect>
              <name>Cross Dissolve</name>
              <effectid>Cross Dissolve</effectid>
              <effectcategory>Dissolve</effectcategory>
              <effecttype>transition</effecttype>
              <mediatype>video</mediatype>
              <wipecode>0</wipecode>
              <wipeaccuracy>100</wipeaccuracy>
              <startratio>0</startratio>
              <endratio>1</endratio>
              <reverse>FALSE</reverse>
            </effect>
          </transitionitem>
          <clipitem id="clipitem-2">
            <name>B.mov</name>
            <enabled>TRUE</enabled>
            <duration>900</duration>
            <rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>
            <start>-1</start>
            <end>300</end>
            <in>190</in>
            <out>390</out>
            <file id="file-2">
              <name>B.mov</name>
              <pathurl>file://localhost/D%3a/other/B.mov</pathurl>
              <rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>
              <duration>900</duration>
              <media><video><samplecharacteristics><width>1920</width><height>1080</height></samplecharacteristics></video></media>
            </file>
            <filter>
              <effect>
                <name>Basic Motion</name>
                <effectid>basic</effectid>
                <parameter><parameterid>scale</parameterid><name>Scale</name><value>120.5</value></parameter>
              </effect>
            </filter>
            <marker><comment></comment><name>clip marker</name><in>250</in><out>250</out></marker>
          </clipitem>
          <enabled>TRUE</enabled>
          <locked>FALSE</locked>
        </track>
        <track><enabled>TRUE</enabled><locked>FALSE</locked></track>
      </video>
      <audio>
        <numOutputChannels>2</numOutputChannels>
        <format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>
        <outputs><group><index>1</index><numchannels>1</numchannels><downmix>0</downmix><channel><index>1</index></channel></group><group><index>2</index><numchannels>1</numchannels><downmix>0</downmix><channel><index>2</index></channel></group></outputs>
        <track currentExplodedTrackIndex="0" totalExplodedTrackCount="2" premiereTrackType="Stereo">
          <clipitem id="clipitem-3" premiereChannelType="stereo">
            <name>คลิป 01.mp4</name>
            <enabled>TRUE</enabled>
            <duration>1000</duration>
            <rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>
            <start>0</start>
            <end>100</end>
            <in>0</in>
            <out>100</out>
            <file id="file-1"/>
            <sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>
            <filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype><mediatype>audio</mediatype><parameter><parameterid>level</parameterid><name>Level</name><valuemin>0</valuemin><valuemax>3.98109</valuemax><value>1</value></parameter></effect></filter>
            <link><linkclipref>clipitem-1</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>1</clipindex></link>
            <link><linkclipref>clipitem-3</linkclipref><mediatype>audio</mediatype><trackindex>1</trackindex><clipindex>1</clipindex><groupindex>1</groupindex></link>
          </clipitem>
          <enabled>TRUE</enabled>
          <locked>FALSE</locked>
          <outputchannelindex>1</outputchannelindex>
        </track>
        <track><enabled>TRUE</enabled><locked>FALSE</locked><outputchannelindex>2</outputchannelindex></track>
        <track>
          <clipitem id="clipitem-4">
            <name>vo_take3.wav</name>
            <enabled>TRUE</enabled>
            <duration>500</duration>
            <rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>
            <start>30</start>
            <end>180</end>
            <in>12</in>
            <out>162</out>
            <file id="file-3"><name>vo_take3.wav</name><pathurl>file://localhost/D%3a/%E0%B8%87%E0%B8%B2%E0%B8%99/vo/vo_take3.wav</pathurl><media><audio><channelcount>1</channelcount></audio></media></file>
            <sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>
            <filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><parameter><parameterid>level</parameterid><name>Level</name><value>0.5</value><keyframe><when>12</when><value>0</value></keyframe><keyframe><when>37</when><value>0.5</value></keyframe><keyframe><when>162</when><value>0.5</value></keyframe></parameter></effect></filter>
          </clipitem>
          <enabled>TRUE</enabled>
          <locked>FALSE</locked>
        </track>
      </audio>
    </media>
    <timecode><rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate><string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>
    <marker><comment></comment><name>Cut</name><in>100</in><out>-1</out></marker>
    <marker><comment></comment><name>late</name><in>500</in><out>-1</out></marker>
  </sequence>
</xmeml>
`;

describe('readXmeml on a Premiere-style export', () => {
  const p = makeProject({ video: [], cuts: [], audio: { vo: [], music: [], sfx: [] } });
  (p.assets.cam as { path: string }).path = 'D:\\งาน\\คลิป 01.mp4';
  (p.assets.vo as { path: string }).path = 'd:/งาน/VO/vo_take3.wav'; // case/separator-insensitive match
  const r = readXmeml(PREMIERE_SAMPLE, p);

  it('rebuilds clips from -1 edges and a centered transition (cut = start + floor(N/2))', () => {
    expect(r.fps).toBe(25);
    expect(r.timeline.video).toEqual([
      { id: 'คลิป 01.mp4', src: 'cam', in: 0, dur: 100, marker: 'Cut' === 'never' ? undefined : undefined },
      { id: 'B.mov', src: 'D:\\other\\B.mov', in: 200, dur: 200, scale: 120.5, marker: 'Cut' },
    ]);
    expect(r.timeline.cuts).toEqual([{ after: 'คลิป 01.mp4', dissolve: 20 }]);
    expect(r.unresolvedPaths).toEqual(['D:\\other\\B.mov']);
  });

  it('ignores linked clip audio, reads vo with gain and fade keyframes, and keeps warnings for what it dropped', () => {
    expect(r.timeline.audio).toEqual({
      vo: [{ id: 'vo_take3.wav', src: 'vo', at: 30, in: 12, dur: 150, gainDb: -6.02, fadeIn: 25 }],
      music: [],
      sfx: [],
    });
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("marker 'late' at 500 is outside every clip"),
        // Timeline 100 + source marker 250 - normalized source in 200 = 150.
        expect.stringContaining("marker 'clip marker' at 150 dropped: clip 'B.mov' already has marker 'Cut'"),
      ]),
    );
    expect(r.warnings.some((w) => w.includes('gap'))).toBe(false);
  });

  it('snaps a sequence marker that is inside a clip to that clip and warns about gaps and off-center transitions', () => {
    const xml = PREMIERE_SAMPLE.replace('<in>100</in><out>-1</out>', '<in>130</in><out>-1</out>')
      .replace('<alignment>center</alignment>', '<alignment>start</alignment>')
      .replace('<start>-1</start>\n            <end>300</end>', '<start>-1</start>\n            <end>320</end>')
      .replace('<out>390</out>', '<out>410</out>');
    const r2 = readXmeml(xml);
    expect(r2.timeline.video.map((c) => [c.in, c.dur, c.marker])).toEqual([
      [0, 90, undefined],
      [190, 230, 'Cut'],
    ]);
    expect(r2.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('start-aligned'), expect.stringContaining("snapped to start of clip 'B.mov'")]),
    );
  });

  it('throws on garbage or a document without a sequence', () => {
    expect(() => readXmeml('<xmeml version="5"><project/></xmeml>')).toThrow(/no <sequence>/);
    expect(() => readXmeml('not xml at all')).toThrow(/sequence|parse/);
  });
});

describe('path <-> url', () => {
  it('encodes Windows, UNC and posix paths and decodes Premiere %3a forms back', () => {
    expect(pathToUrl('D:\\งาน\\a b.mov')).toBe('file://localhost/D%3a/%E0%B8%87%E0%B8%B2%E0%B8%99/a%20b.mov');
    expect(pathToUrl('\\\\nas\\share\\x#1.mov')).toBe('file://nas/share/x%231.mov');
    expect(pathToUrl('/Volumes/RAID/clip.mov')).toBe('file://localhost/Volumes/RAID/clip.mov');
    expect(pathFromUrl('file:///D:/%E0%B8%87%E0%B8%B2%E0%B8%99/a%20b.mov')).toBe('D:\\งาน\\a b.mov');
    expect(pathFromUrl('file://localhost/D%3a/x/y.mp4')).toBe('D:\\x\\y.mp4');
    expect(pathFromUrl('file://nas/share/x%231.mov')).toBe('\\\\nas\\share\\x#1.mov');
    expect(pathFromUrl('file://localhost/Volumes/RAID/clip.mov')).toBe('/Volumes/RAID/clip.mov');
    expect(pathFromUrl('D:\\plain\\path.mov')).toBe('D:\\plain\\path.mov');
    expect(pathFromUrl('file:///D:/bad%zz')).toBe('D:\\bad%zz');
    for (const p of ['D:\\งาน\\ฟุตเทจ\\คลิป 01.mp4', 'C:\\a&b\\c\'d\\e.mov', '\\\\srv\\s\\ไทย.wav']) expect(pathFromUrl(pathToUrl(p))).toBe(p);
  });
});

// ---------- stereo audio (Premiere exports one clipitem per channel on "exploded" tracks) ----------

const R = '<rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>';
function aItem(id: string, name: string, file: string, at: [number, number, number, number], srcTrack: number, links: Array<[string, string, number]>): string {
  const [start, end, inF, outF] = at;
  return `<clipitem id="${id}" premiereChannelType="stereo"><name>${name}</name><enabled>TRUE</enabled>${R}<start>${start}</start><end>${end}</end><in>${inF}</in><out>${outF}</out>${file}`
    + `<sourcetrack><mediatype>audio</mediatype><trackindex>${srcTrack}</trackindex></sourcetrack>`
    + links.map(([ref, mt, ti], k) => `<link><linkclipref>${ref}</linkclipref><mediatype>${mt}</mediatype><trackindex>${ti}</trackindex><clipindex>${k + 1}</clipindex><groupindex>1</groupindex></link>`).join('')
    + '</clipitem>';
}
const track = (attrs: string, items: string, ch?: number): string => `<track${attrs}>${items}<enabled>TRUE</enabled><locked>FALSE</locked>${ch ? `<outputchannelindex>${ch}</outputchannelindex>` : ''}</track>`;
const ex = (i: number, type = 'Stereo', total = 2): string => ` currentExplodedTrackIndex="${i}" totalExplodedTrackCount="${total}" premiereTrackType="${type}"`;
const fdef = (id: string, url: string): string => `<file id="${id}"><name>${id}</name><pathurl>${url}</pathurl>${R}<media><audio><channelcount>2</channelcount></audio></media></file>`;
const fref = (id: string): string => `<file id="${id}"/>`;
function stereoDoc(audioTracks: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE xmeml><xmeml version="4"><sequence id="sequence-1" explodedTracks="true"><name>stereo</name><duration>200</duration>${R}<media>`
    + `<video><format><samplecharacteristics>${R}<width>1920</width><height>1080</height></samplecharacteristics></format>`
    + `<track><clipitem id="v1"><name>shot</name><enabled>TRUE</enabled>${R}<start>0</start><end>200</end><in>0</in><out>200</out>`
    + `<file id="f-cam"><name>cam</name><pathurl>file://localhost/D%3a/%E0%B8%87%E0%B8%B2%E0%B8%99/%E0%B8%84%E0%B8%A5%E0%B8%B4%E0%B8%9B%2001.mp4</pathurl>${R}<media><video><samplecharacteristics><width>1920</width><height>1080</height></samplecharacteristics></video><audio><channelcount>2</channelcount></audio></media></file>`
    + '<link><linkclipref>v1</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>1</clipindex></link>'
    + '<link><linkclipref>ca1</linkclipref><mediatype>audio</mediatype><trackindex>1</trackindex><clipindex>1</clipindex><groupindex>1</groupindex></link>'
    + '<link><linkclipref>ca2</linkclipref><mediatype>audio</mediatype><trackindex>2</trackindex><clipindex>1</clipindex><groupindex>1</groupindex></link>'
    + '</clipitem><enabled>TRUE</enabled><locked>FALSE</locked></track></video>'
    + `<audio><numOutputChannels>2</numOutputChannels>${audioTracks.join('')}</audio></media></sequence></xmeml>`;
}
const camAudio = (side: 0 | 1): string => track(ex(side), aItem(`ca${side + 1}`, 'shot', fref('f-cam'), [0, 200, 0, 200], side + 1, [['v1', 'video', 1], ['ca1', 'audio', 1], ['ca2', 'audio', 2]]), side + 1);
const VO_URL = 'file://localhost/D%3a/%E0%B8%87%E0%B8%B2%E0%B8%99/vo/%E0%B9%80%E0%B8%AA%E0%B8%B5%E0%B8%A2%E0%B8%87%E0%B8%9A%E0%B8%A3%E0%B8%A3%E0%B8%A2%E0%B8%B2%E0%B8%A2.wav';
const MUS_URL = 'file://localhost/D%3a/%E0%B8%87%E0%B8%B2%E0%B8%99/music/bed.wav';

describe('stereo audio', () => {
  const p = makeProject({ video: [], cuts: [], audio: { vo: [], music: [], sfx: [] } });
  (p.assets.cam as { path: string }).path = 'D:\\งาน\\คลิป 01.mp4';

  it('reads a hand-written Premiere stereo export: linked L/R pairs become one clip, roles follow the logical stereo tracks', () => {
    const xml = stereoDoc([
      camAudio(0), camAudio(1),
      // VO pair (A3/A4) and music pair (A5/A6): same file, same span, linked only to each other
      track(ex(0), aItem('vo-l', 'vo take', fdef('f-vo', VO_URL), [20, 120, 5, 105], 1, [['vo-l', 'audio', 3], ['vo-r', 'audio', 4]]), 1),
      track(ex(1), aItem('vo-r', 'vo take', fref('f-vo'), [20, 120, 5, 105], 2, [['vo-l', 'audio', 3], ['vo-r', 'audio', 4]]), 2),
      track(ex(0), aItem('m-l', 'bed', fdef('f-mus', MUS_URL), [0, 200, 0, 200], 1, [['m-l', 'audio', 5], ['m-r', 'audio', 6]]), 1),
      track(ex(1), aItem('m-r', 'bed', fref('f-mus'), [0, 200, 0, 200], 2, [['m-l', 'audio', 5], ['m-r', 'audio', 6]]), 2),
      // a mono track added in Premiere is the 4th logical track -> sfx
      track(ex(0, 'Mono', 1), aItem('fx', 'whoosh', fref('f-vo'), [150, 160, 0, 10], 1, [])),
      // a 5th unnamed logical track cannot be placed by position
      track(ex(0, 'Mono', 1), aItem('fx2', 'boom', fref('f-vo'), [170, 180, 0, 10], 1, [])),
    ]);
    const r = readXmeml(xml, p);
    expect(r.timeline.video).toEqual([{ id: 'shot', src: 'cam', in: 0, dur: 200 }]);
    expect(r.timeline.audio.vo).toEqual([{ id: 'vo take', src: 'vo', at: 20, in: 5, dur: 100 }]);
    expect(r.timeline.audio.music).toEqual([{ id: 'bed', src: 'mus', at: 0, dur: 200 }]);
    expect(r.timeline.audio.sfx.map((c) => [c.id, c.at])).toEqual([['whoosh', 150], ['boom', 170]]);
    expect(r.timeline.audio.useClipAudio).toBeUndefined(); // camera audio stays linked
    expect(r.warnings).toEqual([expect.stringMatching(/^A8: 'boom' is on an extra track .*ambiguous/)]);
  });

  it('track names win over positions', () => {
    const named = (i: number, name: string): string => `${ex(i)} MZ.TrackName="${name}"`;
    const xml = stereoDoc([
      camAudio(0), camAudio(1),
      track(named(0, 'เพลง Music'), aItem('m-l', 'bed', fdef('f-mus', MUS_URL), [0, 200, 0, 200], 1, [['m-l', 'audio', 3], ['m-r', 'audio', 4]]), 1),
      track(named(1, 'เพลง Music'), aItem('m-r', 'bed', fref('f-mus'), [0, 200, 0, 200], 2, [['m-l', 'audio', 3], ['m-r', 'audio', 4]]), 2),
      track(named(0, 'Narration'), aItem('vo-l', 'vo take', fdef('f-vo', VO_URL), [20, 120, 5, 105], 1, [['vo-l', 'audio', 5], ['vo-r', 'audio', 6]]), 1),
      track(named(1, 'Narration'), aItem('vo-r', 'vo take', fref('f-vo'), [20, 120, 5, 105], 2, [['vo-l', 'audio', 5], ['vo-r', 'audio', 6]]), 2),
    ]);
    const r = readXmeml(xml, p);
    expect(r.timeline.audio.music.map((c) => c.src)).toEqual(['mus']);
    expect(r.timeline.audio.vo.map((c) => c.src)).toEqual(['vo']);
    expect(r.timeline.audio.sfx).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('legacy layout without exploded attributes: merges a linked pair and warns when it straddles two roles', () => {
    const xml = stereoDoc([
      track('', aItem('ca1', 'shot', fref('f-cam'), [0, 200, 0, 200], 1, [['v1', 'video', 1], ['ca1', 'audio', 1], ['ca2', 'audio', 2]]), 1),
      track('', aItem('ca2', 'shot', fref('f-cam'), [0, 200, 0, 200], 2, [['v1', 'video', 1], ['ca1', 'audio', 1], ['ca2', 'audio', 2]]), 2),
      track('', aItem('vo-l', 'vo take', fdef('f-vo', VO_URL), [20, 120, 5, 105], 1, [['vo-l', 'audio', 3], ['vo-r', 'audio', 4]])),
      track('', aItem('vo-r', 'vo take', fref('f-vo'), [20, 120, 5, 105], 2, [['vo-l', 'audio', 3], ['vo-r', 'audio', 4]])),
    ]);
    const r = readXmeml(xml, p);
    expect(r.timeline.audio.vo.map((c) => c.id)).toEqual(['vo take']);
    expect(r.timeline.audio.music).toEqual([]);
    expect(r.warnings).toEqual([expect.stringContaining("A3/A4: stereo pair 'vo take' spans tracks read as vo and music; treated as vo")]);
  });

  it('keeps linked clips separate (with a warning) when they differ', () => {
    const xml = stereoDoc([
      camAudio(0), camAudio(1),
      track(ex(0), aItem('vo-l', 'vo take', fdef('f-vo', VO_URL), [20, 120, 5, 105], 1, [['vo-l', 'audio', 3], ['vo-r', 'audio', 4]]), 1),
      track(ex(1), aItem('vo-r', 'vo take', fref('f-vo'), [30, 120, 15, 105], 2, [['vo-l', 'audio', 3], ['vo-r', 'audio', 4]]), 2),
    ]);
    const r = readXmeml(xml, p);
    expect(r.timeline.audio.vo.map((c) => c.at)).toEqual([20, 30]);
    expect(r.warnings).toEqual([expect.stringContaining("linked audio 'vo take' and its partner(s) differ")]);
  });

  it('round-trips mono and stereo role audio written as pairs without duplicating clips', () => {
    const t = richTimeline();
    const q = makeProject(t);
    const xml = writeXmeml(q, { sequenceName: 'pairs' });
    expect((xml.match(/<clipitem id="clipitem-m1(-r)?"/g) ?? []).length).toBe(2);
    expect(readXmeml(xml, q).timeline.audio).toEqual(t.audio);
  });
});