/**
 * FCP7 XML (xmeml v5) writer + reader — the Premiere hand-tweak loop.
 *
 * Layout (details in docs/xmeml-notes.md):
 *   V1 = the cut · A1/A2 = clip audio linked to V1 · A3 = vo · A4 = music · A5 = sfx ·
 *   A6+ = overflow lanes when clips of one role overlap.
 * Dissolve N at cut C covers [C-a, C+b), a = floor(N/2): the transitionitem has exactly that
 * start/end, touching clip edges are written as -1 (FCP7 convention) and in/out are extended by
 * the halves. Clip ids travel in <name> (Premiere preserves it), file ids derive from asset ids.
 */
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { splitDissolve } from '../core/timecode.js';
import type {
  Asset,
  AudioClip,
  AudioTracks,
  Clip,
  Cut,
  Frames,
  Project,
  Timeline,
  XmemlReadResult,
  XmemlWriteOptions,
} from '../core/types.js';

// ---------- types owned by this module (types.ts is the contract and stays untouched) ----------

export interface XmemlReadOptions {
  /** Decoded absolute path -> asset id. Consulted before the project's own asset table. */
  resolveAsset?: (absPath: string) => string | undefined;
}

export interface XmemlReadResultEx extends XmemlReadResult {
  /** Things the model cannot represent or that were guessed: gaps, off-center transitions, snapped markers… */
  warnings: string[];
}

// ---------- tiny deterministic XML builder ----------

type XKid = XNode | string | number;
interface XNode {
  t: string;
  a?: Record<string, string>;
  k: XKid[];
}

function el(t: string, ...kids: Array<XKid | false | null | undefined>): XNode {
  return { t, k: kids.filter((k): k is XKid => k !== false && k !== null && k !== undefined) };
}

function ela(t: string, a: Record<string, string>, ...kids: Array<XKid | false | null | undefined>): XNode {
  const n = el(t, ...kids);
  n.a = a;
  return n;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);

function fmtNum(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

const fmtKid = (k: string | number): string => (typeof k === 'number' ? fmtNum(k) : esc(k));

function render(n: XNode, depth: number, out: string[]): void {
  const pad = '  '.repeat(depth);
  const attrs = n.a ? Object.entries(n.a).map(([k, v]) => ` ${k}="${esc(v)}"`).join('') : '';
  if (n.k.length === 0) {
    out.push(`${pad}<${n.t}${attrs}/>`);
    return;
  }
  if (n.k.every((k) => typeof k !== 'object')) {
    out.push(`${pad}<${n.t}${attrs}>${n.k.map((k) => fmtKid(k as string | number)).join('')}</${n.t}>`);
    return;
  }
  out.push(`${pad}<${n.t}${attrs}>`);
  for (const k of n.k) {
    if (typeof k === 'object') render(k, depth + 1, out);
    else out.push(`${pad}  ${fmtKid(k)}`);
  }
  out.push(`${pad}</${n.t}>`);
}

// ---------- rates, paths, asset helpers ----------

function rateOf(fps: number): { timebase: number; ntsc: boolean } {
  const timebase = Math.round(fps);
  return { timebase, ntsc: Math.abs(fps - timebase) > 0.001 }; // 23.976 / 29.97 / 59.94
}

function fpsOf(timebase: number, ntsc: boolean): number {
  return ntsc ? Math.round((timebase * 1000) / 1001 * 1000) / 1000 : timebase;
}

const rateNode = (timebase: number, ntsc: boolean): XNode =>
  el('rate', el('timebase', timebase), el('ntsc', ntsc ? 'TRUE' : 'FALSE'));

function baseName(p: string): string {
  const s = p.replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/** Absolute path -> `file:///D:/…` (UNC: `file://server/share/…`). Every segment is percent-encoded UTF-8, so Thai survives. */
export function pathToUrl(abs: string): string {
  const s = abs.normalize('NFC').replace(/\\/g, '/');
  const enc = (segs: string[]): string => segs.map((x) => encodeURIComponent(x)).join('/');
  const unc = /^\/\/([^/]+)\/(.*)$/.exec(s);
  if (unc) return `file://${unc[1]}/${enc((unc[2] ?? '').split('/'))}`;
  const drv = /^([A-Za-z]:)(?:\/(.*))?$/.exec(s);
  if (drv) return `file:///${drv[1]}/${enc((drv[2] ?? '').split('/'))}`;
  return `file://${enc((s.startsWith('/') ? s : `/${s}`).split('/'))}`;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** `file:///D:/…`, `file://localhost/D%3a/…` (Premiere), `file://server/share/…` -> absolute path (Windows separators where it is a Windows path). */
export function pathFromUrl(url: string): string {
  const m = /^file:\/\/([^/]*)(\/.*)?$/i.exec(url.trim());
  if (!m) return decodeSafe(url.trim()).normalize('NFC');
  const host = m[1] ?? '';
  const rest = decodeSafe(m[2] ?? '/').normalize('NFC');
  if (host && host.toLowerCase() !== 'localhost') return `\\\\${host}${rest.replace(/\//g, '\\')}`;
  if (/^\/[A-Za-z]:(\/|$)/.test(rest)) return rest.slice(1).replace(/\//g, '\\');
  return rest;
}

/** Case-insensitive, separator-insensitive key for comparing paths. */
function pathKey(p: string): string {
  let s = p.normalize('NFC').trim();
  if (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\') || s.startsWith('//')) s = path.win32.normalize(s).replace(/[\\/]+$/, '');
  return s.toLowerCase();
}

const defaultResolvePath = (a: Asset): string | undefined => (a.kind === 'aecomp' ? a.render?.path : a.path);
const assetHasVideo = (a: Asset): boolean => (a.probe ? a.probe.hasVideo : a.kind !== 'audio');
const assetHasAudio = (a: Asset): boolean => (a.probe ? a.probe.hasAudio : a.kind === 'camera' || a.kind === 'audio');
const assetChannels = (a: Asset): 1 | 2 => (a.probe?.channels === 1 ? 1 : 2);

const DB_EPS = 0.005;
const round = (v: number, digits: number): number => Math.round(v * 10 ** digits) / 10 ** digits;

// ============================================================================================
// WRITER
// ============================================================================================

interface PlacedAudio {
  clip: AudioClip;
  at: Frames;
  in: Frames;
  dur: Frames;
}

/** First-fit lanes: overlapping clips of one role go to extra tracks instead of colliding. */
function placeLanes(items: PlacedAudio[]): PlacedAudio[][] {
  const lanes: PlacedAudio[][] = [];
  for (const it of [...items].sort((x, y) => x.at - y.at)) {
    let lane = lanes.find((l) => {
      const last = l[l.length - 1];
      return last !== undefined && last.at + last.dur <= it.at;
    });
    if (!lane) {
      lane = [];
      lanes.push(lane);
    }
    lane.push(it);
  }
  return lanes;
}

function motionFilter(scale: number | undefined): XNode | undefined {
  if (scale === undefined || scale === 100) return undefined;
  return el(
    'filter',
    el(
      'effect',
      el('name', 'Basic Motion'),
      el('effectid', 'basic'),
      el('effectcategory', 'motion'),
      el('effecttype', 'motion'),
      el('mediatype', 'video'),
      el('parameter', el('parameterid', 'scale'), el('name', 'Scale'), el('valuemin', 0), el('valuemax', 1000), el('value', scale)),
    ),
  );
}

/** Audio Levels filter: linear gain, fades as keyframes in source frames (same space as in/out). */
function levelsFilter(c: AudioClip, xmlIn: Frames, xmlOut: Frames): XNode | undefined {
  const gain = c.gainDb ?? 0;
  const dur = xmlOut - xmlIn;
  const fi = Math.min(Math.max(0, c.fadeIn ?? 0), dur);
  const fo = Math.min(Math.max(0, c.fadeOut ?? 0), dur - fi);
  if (gain === 0 && fi <= 0 && fo <= 0) return undefined;
  const g = round(10 ** (gain / 20), 6);
  const kfs: XNode[] = [];
  const kf = (when: Frames, v: number): void => {
    const prev = kfs[kfs.length - 1];
    if (prev && (prev.k[0] as XNode).k[0] === when) kfs.pop();
    kfs.push(el('keyframe', el('when', when), el('value', v)));
  };
  if (fi > 0 || fo > 0) {
    kf(xmlIn, fi > 0 ? 0 : g);
    if (fi > 0) kf(xmlIn + fi, g);
    if (fo > 0) kf(xmlOut - fo, g);
    kf(xmlOut, fo > 0 ? 0 : g);
  }
  return el(
    'filter',
    el(
      'effect',
      el('name', 'Audio Levels'),
      el('effectid', 'audiolevels'),
      el('effectcategory', 'audiolevels'),
      el('effecttype', 'audiolevels'),
      el('mediatype', 'audio'),
      el('parameter', el('parameterid', 'level'), el('name', 'Level'), el('valuemin', 0), el('valuemax', 3.98109), el('value', g), ...kfs),
    ),
  );
}

function transitionNode(rate: XNode, start: Frames, end: Frames, audio: boolean): XNode {
  const name = audio ? 'Cross Fade (+3dB)' : 'Cross Dissolve';
  return el(
    'transitionitem',
    rate,
    el('start', start),
    el('end', end),
    el('alignment', 'center'),
    el(
      'effect',
      el('name', name),
      el('effectid', name),
      el('effectcategory', 'Dissolve'),
      el('effecttype', 'transition'),
      el('mediatype', audio ? 'audio' : 'video'),
      !audio && el('wipecode', 0),
      !audio && el('wipeaccuracy', 100),
      !audio && el('startratio', 0),
      !audio && el('endratio', 1),
      !audio && el('reverse', 'FALSE'),
    ),
  );
}

const linkNode = (ref: string, mediatype: 'video' | 'audio', trackindex: number, clipindex: number): XNode =>
  el(
    'link',
    el('linkclipref', ref),
    el('mediatype', mediatype),
    el('trackindex', trackindex),
    el('clipindex', clipindex),
    mediatype === 'audio' && el('groupindex', 1),
  );

export function writeXmeml(p: Project, opts: XmemlWriteOptions): string {
  const fps = p.meta.fps > 0 ? p.meta.fps : 25;
  const { timebase, ntsc } = rateOf(fps);
  const rate = (): XNode => rateNode(timebase, ntsc);
  const W = p.meta.width;
  const H = p.meta.height;
  const tl = p.timeline;
  const clips = tl.video;
  const n = clips.length;
  const resolvePath = opts.resolvePath ?? defaultResolvePath;
  const useClipAudio = tl.audio.useClipAudio !== false;

  const assetOf = (id: string, who: string): Asset => {
    const a = p.assets[id];
    if (!a) throw new Error(`xmeml: ${who} refers to unknown asset '${id}'`);
    return a;
  };

  // --- timeline positions and dissolve halves
  const starts: Frames[] = [];
  let total = 0;
  for (const c of clips) {
    if (!(c.dur > 0)) throw new Error(`xmeml: clip '${c.id}' has non-positive duration`);
    starts.push(total);
    total += c.dur;
  }
  const index = new Map(clips.map((c, i) => [c.id, i] as const));
  const dissolveAfter: Frames[] = clips.map(() => 0);
  for (const cut of tl.cuts) {
    const i = index.get(cut.after);
    if (i === undefined || i >= n - 1 || !(cut.dissolve > 0)) continue;
    dissolveAfter[i] = Math.round(cut.dissolve);
  }
  const dAfter = (i: number): Frames => dissolveAfter[i] ?? 0;
  const aPrev = clips.map((_, i) => (i > 0 ? splitDissolve(dAfter(i - 1)).a : 0)); // handle this clip needs before its head
  const bNext = clips.map((_, i) => (i < n - 1 ? splitDissolve(dAfter(i)).b : 0)); // handle this clip needs after its tail
  const startOf = (i: number): Frames => starts[i] ?? 0;
  const ap = (i: number): Frames => aPrev[i] ?? 0;
  const bn = (i: number): Frames => bNext[i] ?? 0;

  // --- stable xml ids
  const used = new Set<string>();
  const xmlId = (prefix: string, raw: string): string => {
    const base = `${prefix}-${raw.normalize('NFC').replace(/[^A-Za-z0-9_.-]/g, '_') || 'x'}`;
    let id = base;
    for (let k = 2; used.has(id); k++) id = `${base}-${k}`;
    used.add(id);
    return id;
  };
  const vId = clips.map((c) => xmlId('clipitem', c.id));
  const audioLanesOf: number[][] = clips.map((c) => {
    if (!useClipAudio) return [];
    const a = assetOf(c.src, `clip '${c.id}'`);
    if (!assetHasAudio(a)) return [];
    return assetChannels(a) === 2 ? [0, 1] : [0];
  });
  const lanesOf = (i: number): number[] => audioLanesOf[i] ?? [];
  const aId = clips.map((c, i) => lanesOf(i).map((L) => xmlId('clipitem', `${c.id}-a${L + 1}`)));

  // --- source frames each asset must cover (keeps <duration> >= every out; stills included)
  const needed = new Map<string, Frames>();
  const need = (assetId: string, out: Frames): void => {
    needed.set(assetId, Math.max(needed.get(assetId) ?? 0, out));
  };

  // --- video in/out per clip (stills may shift `in` so a preceding dissolve never asks for in < 0)
  const vIn: Frames[] = [];
  const vOut: Frames[] = [];
  clips.forEach((c, i) => {
    const a = assetOf(c.src, `clip '${c.id}'`);
    let xIn = c.in - ap(i);
    if (xIn < 0 && a.kind === 'still') xIn = 0;
    if (xIn < 0) throw new Error(`xmeml: clip '${c.id}' needs ${ap(i)} handle frame(s) before in=${c.in} for the dissolve`);
    const xOut = xIn + ap(i) + c.dur + bn(i);
    vIn.push(xIn);
    vOut.push(xOut);
    need(c.src, xOut);
  });

  // --- vo / music / sfx placement
  const resolveAudio = (c: AudioClip): PlacedAudio => {
    const a = assetOf(c.src, `audio clip '${c.id}'`);
    const inF = c.in ?? 0;
    let dur = c.dur;
    if (dur === undefined) {
      const src = a.probe?.durationFrames;
      dur = src !== undefined ? Math.min(src - inF, total - c.at) : total - c.at;
    }
    if (!(dur > 0)) throw new Error(`xmeml: audio clip '${c.id}' has non-positive duration`);
    need(c.src, inF + dur);
    return { clip: c, at: c.at, in: inF, dur };
  };
  const roles: Array<[string, AudioClip[]]> = [
    ['vo', tl.audio.vo ?? []],
    ['music', tl.audio.music ?? []],
    ['sfx', tl.audio.sfx ?? []],
  ];
  const mainLanes: PlacedAudio[][] = [];
  const extraLanes: PlacedAudio[][] = [];
  for (const [, list] of roles) {
    const [first, ...rest] = placeLanes(list.map(resolveAudio));
    mainLanes.push(first ?? []);
    extraLanes.push(...rest);
  }
  const audioItemId = new Map<AudioClip, string>();
  for (const lane of [...mainLanes, ...extraLanes]) for (const pa of lane) audioItemId.set(pa.clip, xmlId('clipitem', pa.clip.id));

  // --- file elements: full definition on first use, id reference afterwards
  const fileIds = new Map<string, string>();
  const fileDefined = new Set<string>();
  const fileDuration = (a: Asset, assetId: string): Frames => Math.max(a.probe?.durationFrames ?? 0, needed.get(assetId) ?? 0);
  const fileRef = (assetId: string): XNode => {
    const a = assetOf(assetId, 'file reference');
    let id = fileIds.get(assetId);
    if (id === undefined) {
      id = xmlId('file', assetId);
      fileIds.set(assetId, id);
    }
    if (fileDefined.has(assetId)) return ela('file', { id });
    fileDefined.add(assetId);
    const fpath = resolvePath(a);
    if (!fpath) throw new Error(`xmeml: asset '${assetId}' has no file path yet (aecomp not rendered? build first or pass resolvePath)`);
    const probe = a.probe;
    const media: XNode[] = [];
    if (assetHasVideo(a)) {
      const fr = rateOf(probe?.fps ?? fps);
      media.push(
        el(
          'video',
          el(
            'samplecharacteristics',
            rateNode(fr.timebase, fr.ntsc),
            el('width', probe?.width ?? W),
            el('height', probe?.height ?? H),
            el('anamorphic', 'FALSE'),
            el('pixelaspectratio', 'square'),
            el('fielddominance', 'none'),
          ),
        ),
      );
    }
    if (assetHasAudio(a)) {
      media.push(
        el('audio', el('samplecharacteristics', el('depth', 16), el('samplerate', probe?.sampleRate ?? 48000)), el('channelcount', assetChannels(a))),
      );
    }
    return ela(
      'file',
      { id },
      el('name', baseName(fpath)),
      el('pathurl', pathToUrl(fpath)),
      rate(),
      el('duration', fileDuration(a, assetId)),
      el('media', ...media),
    );
  };

  // --- clip audio lanes A1/A2: clipindex bookkeeping, then nodes
  const laneIndex: number[][] = clips.map(() => [0, 0]);
  const laneCount = [0, 0];
  clips.forEach((_, i) => {
    for (const L of lanesOf(i)) {
      laneCount[L] = (laneCount[L] ?? 0) + 1;
      const li = laneIndex[i];
      if (li) li[L] = laneCount[L] ?? 0;
    }
  });
  const onLane = (i: number, L: number): boolean => lanesOf(i).includes(L);
  const linksFor = (i: number): XNode[] => {
    if (lanesOf(i).length === 0) return [];
    const out = [linkNode(vId[i] ?? '', 'video', 1, i + 1)];
    for (const L of lanesOf(i)) out.push(linkNode(aId[i]?.[L] ?? '', 'audio', L + 1, laneIndex[i]?.[L] ?? 0));
    return out;
  };

  const vItems: XNode[] = [];
  const clipAudioItems: XNode[][] = [[], []];
  clips.forEach((c, i) => {
    const a = assetOf(c.src, `clip '${c.id}'`);
    const start = startOf(i);
    vItems.push(
      ela(
        'clipitem',
        { id: vId[i] ?? '' },
        el('name', c.id),
        el('enabled', 'TRUE'),
        el('duration', fileDuration(a, c.src)),
        rate(),
        el('start', ap(i) > 0 ? -1 : start),
        el('end', bn(i) > 0 ? -1 : start + c.dur),
        el('in', vIn[i] ?? 0),
        el('out', vOut[i] ?? 0),
        el('pixelaspectratio', 'square'),
        el('anamorphic', 'FALSE'),
        el('alphatype', 'none'),
        fileRef(c.src),
        motionFilter(c.scale),
        ...linksFor(i),
      ),
    );
    if (i < n - 1 && dAfter(i) > 0) {
      const cutAt = start + c.dur;
      const { a: da, b: db } = splitDissolve(dAfter(i));
      vItems.push(transitionNode(rate(), cutAt - da, cutAt + db, false));
    }
    for (const L of lanesOf(i)) {
      // audio cross fade only where both neighbours have audio on this lane; otherwise a hard cut at C
      const xfPrev = i > 0 && onLane(i - 1, L) && dAfter(i - 1) > 0;
      const xfNext = i < n - 1 && onLane(i + 1, L) && dAfter(i) > 0;
      const hp = xfPrev ? ap(i) : 0;
      const hn = xfNext ? bn(i) : 0;
      const xIn = (vIn[i] ?? 0) + ap(i) - hp;
      const lane = clipAudioItems[L];
      if (!lane) continue;
      lane.push(
        ela(
          'clipitem',
          { id: aId[i]?.[L] ?? '' },
          el('name', c.id),
          el('enabled', 'TRUE'),
          el('duration', fileDuration(a, c.src)),
          rate(),
          el('start', hp > 0 ? -1 : start),
          el('end', hn > 0 ? -1 : start + c.dur),
          el('in', xIn),
          el('out', xIn + hp + c.dur + hn),
          fileRef(c.src),
          el('sourcetrack', el('mediatype', 'audio'), el('trackindex', L + 1)),
          ...linksFor(i),
        ),
      );
      if (xfNext) {
        const cutAt = start + c.dur;
        const { a: da, b: db } = splitDissolve(dAfter(i));
        lane.push(transitionNode(rate(), cutAt - da, cutAt + db, true));
      }
    }
  });

  // --- vo / music / sfx nodes
  const audioItem = (pa: PlacedAudio): XNode => {
    const a = assetOf(pa.clip.src, `audio clip '${pa.clip.id}'`);
    const xOut = pa.in + pa.dur;
    return ela(
      'clipitem',
      { id: audioItemId.get(pa.clip) ?? '' },
      el('name', pa.clip.id),
      el('enabled', 'TRUE'),
      el('duration', fileDuration(a, pa.clip.src)),
      rate(),
      el('start', pa.at),
      el('end', pa.at + pa.dur),
      el('in', pa.in),
      el('out', xOut),
      fileRef(pa.clip.src),
      el('sourcetrack', el('mediatype', 'audio'), el('trackindex', 1)),
      levelsFilter(pa.clip, pa.in, xOut),
    );
  };
  const audioTrack = (items: XNode[], outputChannel?: number): XNode =>
    el('track', ...items, el('enabled', 'TRUE'), el('locked', 'FALSE'), outputChannel !== undefined && el('outputchannelindex', outputChannel));
  const audioTracks: XNode[] = [
    audioTrack(clipAudioItems[0] ?? [], 1),
    audioTrack(clipAudioItems[1] ?? [], 2),
    ...mainLanes.map((lane) => audioTrack(lane.map(audioItem))),
    ...extraLanes.map((lane) => audioTrack(lane.map(audioItem))),
  ];

  // --- sequence markers at clip starts
  const markers = clips.flatMap((c, i) =>
    c.marker ? [el('marker', el('name', c.marker), el('comment', ''), el('in', startOf(i)), el('out', -1))] : [],
  );

  const seq = ela(
    'sequence',
    { id: 'sequence-1' },
    el('name', opts.sequenceName),
    el('duration', total),
    rate(),
    el('timecode', rate(), el('string', '00:00:00:00'), el('frame', 0), el('displayformat', 'NDF')),
    el('in', -1),
    el('out', -1),
    el(
      'media',
      el(
        'video',
        el(
          'format',
          el(
            'samplecharacteristics',
            rate(),
            el('width', W),
            el('height', H),
            el('anamorphic', 'FALSE'),
            el('pixelaspectratio', 'square'),
            el('fielddominance', 'none'),
            el('colordepth', 24),
          ),
        ),
        el('track', ...vItems, el('enabled', 'TRUE'), el('locked', 'FALSE')),
      ),
      el('audio', el('numOutputChannels', 2), el('format', el('samplecharacteristics', el('depth', 16), el('samplerate', 48000))), ...audioTracks),
    ),
    ...markers,
  );

  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE xmeml>'];
  render(ela('xmeml', { version: '5' }, seq), 0, out);
  return `${out.join('\n')}\n`;
}

// ============================================================================================
// READER
// ============================================================================================

type PNode = Record<string, unknown>;
const ATTR = ':@';

function tagOf(n: PNode): string {
  for (const k of Object.keys(n)) if (k !== ATTR) return k;
  return '';
}
function kidsOf(n: PNode): PNode[] {
  const v = n[tagOf(n)];
  return Array.isArray(v) ? (v as PNode[]) : [];
}
function attrOf(n: PNode, name: string): string | undefined {
  const a = n[ATTR] as Record<string, unknown> | undefined;
  const v = a?.[`@_${name}`];
  return v === undefined || v === null ? undefined : String(v);
}
function textOf(n: PNode): string {
  return kidsOf(n)
    .map((k) => ('#text' in k ? String(k['#text']) : ''))
    .join('')
    .trim();
}
const child = (n: PNode, name: string): PNode | undefined => kidsOf(n).find((k) => tagOf(k) === name);
const children = (n: PNode, name: string): PNode[] => kidsOf(n).filter((k) => tagOf(k) === name);
function childText(n: PNode, name: string): string | undefined {
  const c = child(n, name);
  return c ? textOf(c) : undefined;
}
function childNum(n: PNode, name: string): number | undefined {
  const t = childText(n, name);
  if (t === undefined || t === '') return undefined;
  const v = Number(t);
  return Number.isFinite(v) ? v : undefined;
}
function descend(n: PNode, ...names: string[]): PNode | undefined {
  let cur: PNode | undefined = n;
  for (const name of names) {
    if (!cur) return undefined;
    cur = child(cur, name);
  }
  return cur;
}
function walk(n: PNode, fn: (node: PNode) => void): void {
  for (const k of kidsOf(n)) {
    if ('#text' in k) continue;
    fn(k);
    walk(k, fn);
  }
}
function findFirst(n: PNode, tag: string): PNode | undefined {
  for (const k of kidsOf(n)) {
    if ('#text' in k) continue;
    if (tagOf(k) === tag) return k;
    const hit = findFirst(k, tag);
    if (hit) return hit;
  }
  return undefined;
}

interface FileRec {
  id: string;
  name?: string;
  pathurl?: string;
  width?: number;
  height?: number;
}

interface RItem {
  kind: 'clip' | 'trans';
  node: PNode;
  name: string;
  start: Frames;
  end: Frames;
  in: Frames;
  out: Frames;
  file?: FileRec;
  nestedSequence?: string;
  alignment: string;
}

type Warn = (s: string) => void;

/** Items of one track in order, with FCP7 -1 edges resolved against the neighbouring transition. */
function readItems(track: PNode, label: string, fps: number, fileOf: (node: PNode) => FileRec | undefined, warn: Warn): RItem[] {
  const items: RItem[] = [];
  for (const k of kidsOf(track)) {
    const t = tagOf(k);
    if (t === 'clipitem') {
      const name = childText(k, 'name') ?? '';
      let inF = childNum(k, 'in') ?? 0;
      let outF = childNum(k, 'out') ?? -1;
      const r = child(k, 'rate');
      const tb = r ? childNum(r, 'timebase') : undefined;
      if (r && tb) {
        const clipFps = fpsOf(tb, (childText(r, 'ntsc') ?? 'FALSE').toUpperCase() === 'TRUE');
        if (Math.abs(clipFps - fps) > 0.01) {
          warn(`${label}: '${name}' runs at ${clipFps} fps; in/out rescaled to sequence ${fps} fps`);
          inF = Math.round((inF * fps) / clipFps);
          if (outF >= 0) outF = Math.round((outF * fps) / clipFps);
        }
      }
      if ((childText(k, 'enabled') ?? 'TRUE').toUpperCase() === 'FALSE') warn(`${label}: '${name}' is disabled in the XML but kept`);
      const fileNode = child(k, 'file');
      const nested = child(k, 'sequence');
      items.push({
        kind: 'clip',
        node: k,
        name,
        start: childNum(k, 'start') ?? 0,
        end: childNum(k, 'end') ?? -1,
        in: inF,
        out: outF,
        file: fileNode ? fileOf(fileNode) : undefined,
        nestedSequence: nested ? childText(nested, 'name') ?? 'nested sequence' : undefined,
        alignment: '',
      });
    } else if (t === 'transitionitem') {
      const eff = child(k, 'effect');
      const name = (eff && childText(eff, 'name')) ?? 'transition';
      const start = childNum(k, 'start') ?? -1;
      const end = childNum(k, 'end') ?? -1;
      if (start < 0 || end <= start) {
        warn(`${label}: transition '${name}' has no usable start/end; ignored`);
        continue;
      }
      items.push({ kind: 'trans', node: k, name, start, end, in: 0, out: 0, alignment: (childText(k, 'alignment') ?? 'center').toLowerCase() });
    }
  }
  items.forEach((it, i) => {
    if (it.kind !== 'clip') return;
    const prev = items[i - 1];
    const next = items[i + 1];
    if (it.start < 0) {
      if (prev?.kind === 'trans') it.start = prev.start;
      else {
        warn(`${label}: '${it.name}' has start=-1 without a preceding transition`);
        it.start = prev ? prev.end : 0;
      }
    }
    if (it.end < 0) {
      if (next?.kind === 'trans') it.end = next.end;
      else {
        warn(`${label}: '${it.name}' has end=-1 without a following transition`);
        it.end = it.start + Math.max(0, it.out - it.in);
      }
    }
    if (it.out < 0) it.out = it.in + (it.end - it.start);
    if (it.out - it.in !== it.end - it.start) warn(`${label}: '${it.name}' source span (${it.out - it.in}) != timeline span (${it.end - it.start}); speed change ignored`);
  });
  return items;
}

/** Where the model's cut sits inside a transition: centered → start + floor(N/2); start/end aligned → that edge. */
function cutOf(t: RItem, label: string, warn: Warn): Frames {
  const n = t.end - t.start;
  if (t.alignment.startsWith('start')) {
    warn(`${label}: transition '${t.name}' is ${t.alignment}-aligned; it will be re-centered on the next export`);
    return t.start;
  }
  if (t.alignment.startsWith('end')) {
    warn(`${label}: transition '${t.name}' is ${t.alignment}-aligned; it will be re-centered on the next export`);
    return t.end;
  }
  return t.start + splitDissolve(n).a;
}

function readScale(clipNode: PNode, name: string, warn: Warn): number | undefined {
  for (const f of children(clipNode, 'filter')) {
    for (const e of children(f, 'effect')) {
      if (childText(e, 'effectid') !== 'basic' && childText(e, 'name') !== 'Basic Motion') continue;
      for (const prm of children(e, 'parameter')) {
        if (childText(prm, 'parameterid') !== 'scale') continue;
        const kfs = children(prm, 'keyframe');
        if (kfs.length > 0) warn(`V1: '${name}' has animated scale; first keyframe used`);
        const first = kfs[0];
        const v = (first && childNum(first, 'value')) ?? childNum(prm, 'value');
        return v === undefined ? undefined : round(v, 4);
      }
    }
  }
  return undefined;
}

function readLevels(clipNode: PNode, xmlIn: Frames, xmlOut: Frames): Pick<AudioClip, 'gainDb' | 'fadeIn' | 'fadeOut'> {
  const res: Pick<AudioClip, 'gainDb' | 'fadeIn' | 'fadeOut'> = {};
  for (const f of children(clipNode, 'filter')) {
    for (const e of children(f, 'effect')) {
      if (childText(e, 'effectid') !== 'audiolevels' && childText(e, 'name') !== 'Audio Levels') continue;
      const prm = children(e, 'parameter').find((x) => childText(x, 'parameterid') === 'level');
      if (!prm) continue;
      const kfs = children(prm, 'keyframe')
        .map((k) => ({ when: childNum(k, 'when'), value: childNum(k, 'value') }))
        .filter((k): k is { when: number; value: number } => k.when !== undefined && k.value !== undefined)
        .sort((x, y) => x.when - y.when);
      const g = kfs.length > 0 ? Math.max(...kfs.map((k) => k.value)) : childNum(prm, 'value') ?? 1;
      const db = g > 0 ? round(20 * Math.log10(g), 2) : -60;
      if (Math.abs(db) >= DB_EPS) res.gainDb = db;
      const first = kfs[0];
      const second = kfs[1];
      const last = kfs[kfs.length - 1];
      const beforeLast = kfs[kfs.length - 2];
      if (first && second && first.value === 0 && first.when <= xmlIn && second.when > first.when) res.fadeIn = second.when - first.when;
      if (last && beforeLast && last.value === 0 && last.when >= xmlOut && last.when > beforeLast.when) res.fadeOut = last.when - beforeLast.when;
      return res;
    }
  }
  return res;
}

export function readXmeml(xml: string, p?: Project, opts: XmemlReadOptions = {}): XmemlReadResultEx {
  const warnings: string[] = [];
  const warn: Warn = (s) => {
    warnings.push(s);
  };
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    ignoreDeclaration: true,
    ignorePiTags: true,
  });
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch (e) {
    throw new Error(`xmeml: cannot parse XML: ${(e as Error).message}`);
  }
  const root: PNode = { root: Array.isArray(doc) ? doc : [] };
  const seq = findFirst(root, 'sequence');
  if (!seq) throw new Error('xmeml: no <sequence> element found');

  // --- every <file> anywhere, merged by id (first full definition wins, id-only refs resolve to it)
  const filesById = new Map<string, FileRec>();
  const filesByNode = new WeakMap<PNode, FileRec>();
  let anon = 0;
  walk(root, (node) => {
    if (tagOf(node) !== 'file') return;
    const id = attrOf(node, 'id') ?? `anon-${++anon}`;
    let rec = filesById.get(id);
    if (!rec) {
      rec = { id };
      filesById.set(id, rec);
    }
    rec.name ??= childText(node, 'name');
    rec.pathurl ??= childText(node, 'pathurl');
    const sc = descend(node, 'media', 'video', 'samplecharacteristics');
    if (sc) {
      rec.width ??= childNum(sc, 'width');
      rec.height ??= childNum(sc, 'height');
    }
    filesByNode.set(node, rec);
  });
  const fileOf = (node: PNode): FileRec | undefined => filesByNode.get(node) ?? (attrOf(node, 'id') ? filesById.get(attrOf(node, 'id') ?? '') : undefined);

  // --- sequence rate / size
  const fmtChars = descend(seq, 'media', 'video', 'format', 'samplecharacteristics');
  const rateSrc = child(seq, 'rate') ?? (fmtChars ? child(fmtChars, 'rate') : undefined);
  let fps = p?.meta.fps ?? 25;
  if (rateSrc) {
    const tb = childNum(rateSrc, 'timebase');
    if (tb) fps = fpsOf(tb, (childText(rateSrc, 'ntsc') ?? 'FALSE').toUpperCase() === 'TRUE');
  }
  const firstVideoFile = [...filesById.values()].find((f) => f.width !== undefined && f.height !== undefined);
  const width = (fmtChars && childNum(fmtChars, 'width')) ?? firstVideoFile?.width ?? p?.meta.width ?? 1920;
  const height = (fmtChars && childNum(fmtChars, 'height')) ?? firstVideoFile?.height ?? p?.meta.height ?? 1080;

  // --- asset mapping
  const assetByPath = new Map<string, string>();
  if (p) {
    for (const a of Object.values(p.assets)) {
      const fp = defaultResolvePath(a);
      if (fp) assetByPath.set(pathKey(fp), a.id);
    }
  }
  const unresolvedPaths: string[] = [];
  const unresolved = (s: string): string => {
    if (!unresolvedPaths.includes(s)) unresolvedPaths.push(s);
    return s;
  };
  const srcFor = (it: RItem, label: string): string => {
    if (it.nestedSequence !== undefined) {
      warn(`${label}: '${it.name}' is a nested sequence; source left as its name`);
      return unresolved(it.nestedSequence);
    }
    if (!it.file) {
      warn(`${label}: '${it.name}' has no <file>; source left as the clip name`);
      return unresolved(it.name || '?');
    }
    if (!it.file.pathurl) {
      warn(`${label}: '${it.name}' file has no pathurl (offline?)`);
      return unresolved(it.file.name ?? it.file.id);
    }
    const abs = pathFromUrl(it.file.pathurl);
    return opts.resolveAsset?.(abs) ?? assetByPath.get(pathKey(abs)) ?? unresolved(abs);
  };
  const uniqueId = (pool: Set<string>, name: string, fallback: string): string => {
    const base = name.trim() || fallback;
    let id = base;
    for (let k = 2; pool.has(id); k++) id = `${base}_${k}`;
    pool.add(id);
    return id;
  };

  // --- video: V1 only
  const videoNode = descend(seq, 'media', 'video');
  const vTracks = videoNode ? children(videoNode, 'track') : [];
  vTracks.slice(1).forEach((trk, i) => {
    const count = children(trk, 'clipitem').length;
    if (count > 0) warn(`V${i + 2}: ${count} clip(s) ignored (model has one video track)`);
  });
  const v1 = vTracks[0];
  const items = v1 ? readItems(v1, 'V1', fps, fileOf, warn) : [];
  const video: Clip[] = [];
  const cuts: Cut[] = [];
  const spans: Array<{ clip: Clip; xStart: Frames; xEnd: Frames }> = [];
  const pendingMarkers: Array<{ name: string; at: Frames; from: string }> = [];
  const videoIds = new Set<string>();
  let lastIdx = -1;
  let lastEnd: Frames | undefined;
  items.forEach((it, i) => {
    if (it.kind !== 'clip') return;
    const prev = items[i - 1];
    const before = items[i - 2];
    const next = items[i + 1];
    const after = items[i + 2];
    const prevT = prev?.kind === 'trans' && before?.kind === 'clip' ? prev : undefined;
    const nextT = next?.kind === 'trans' && after?.kind === 'clip' ? next : undefined;
    if (prev?.kind === 'trans' && !prevT) warn(`V1: transition '${prev.name}' before '${it.name}' has no clip on its other side; folded into the clip`);
    if (next?.kind === 'trans' && !nextT) warn(`V1: transition '${next.name}' after '${it.name}' has no clip on its other side; folded into the clip`);
    if (prevT && !/dissolve/i.test(prevT.name)) warn(`V1: transition '${prevT.name}' treated as a cross dissolve`);
    const cPrev = prevT ? cutOf(prevT, 'V1', warn) : it.start;
    const cNext = nextT ? cutOf(nextT, 'V1', warn) : it.end;
    const dur = cNext - cPrev;
    if (dur <= 0) {
      warn(`V1: '${it.name}' has no frames left outside its transitions; skipped`);
      return;
    }
    if (lastEnd !== undefined && cPrev !== lastEnd) warn(`V1: ${cPrev - lastEnd} frame gap/overlap before '${it.name}' dropped (model has no gaps)`);
    const clip: Clip = { id: uniqueId(videoIds, it.name, `v${video.length + 1}`), src: srcFor(it, 'V1'), in: it.in + (cPrev - it.start), dur };
    // A still with no head handle is clamped to XML in=0; remove that synthetic source offset on import.
    if (p?.assets[clip.src]?.kind === 'still' && it.in === 0) clip.in = 0;
    const scale = readScale(it.node, it.name, warn);
    if (scale !== undefined && scale !== 100) clip.scale = scale;
    const lastClip = video[video.length - 1];
    if (lastClip) {
      const adjacent = prevT !== undefined && before === items[lastIdx];
      if (prevT && !adjacent) warn(`V1: dissolve before '${it.name}' dropped because its other clip was skipped`);
      cuts.push({ after: lastClip.id, dissolve: adjacent && prevT ? prevT.end - prevT.start : 0 });
    }
    for (const m of children(it.node, 'marker')) {
      const name = childText(m, 'name') || childText(m, 'comment') || '';
      const mIn = childNum(m, 'in');
      if (name && mIn !== undefined) pendingMarkers.push({ name, at: it.start + (mIn - it.in), from: 'clip marker' });
    }
    video.push(clip);
    spans.push({ clip, xStart: cPrev, xEnd: cNext });
    lastIdx = i;
    lastEnd = cNext;
  });

  // --- markers: sequence markers first, then clip markers; exact clip start wins, else snap to the containing clip
  for (const m of children(seq, 'marker')) {
    const name = childText(m, 'name') || childText(m, 'comment') || '';
    const at = childNum(m, 'in');
    if (name && at !== undefined) pendingMarkers.unshift({ name, at, from: 'sequence marker' });
  }
  for (const m of pendingMarkers) {
    const exact = spans.find((s) => s.xStart === m.at);
    const target = exact ?? spans.find((s) => m.at >= s.xStart && m.at < s.xEnd);
    if (!target) {
      warn(`marker '${m.name}' at ${m.at} is outside every clip; dropped`);
      continue;
    }
    if (target.clip.marker !== undefined) {
      warn(`marker '${m.name}' at ${m.at} dropped: clip '${target.clip.id}' already has marker '${target.clip.marker}'`);
      continue;
    }
    if (!exact) warn(`${m.from} '${m.name}' at ${m.at} snapped to start of clip '${target.clip.id}' (${target.xStart})`);
    target.clip.marker = m.name;
  }

  // --- audio: A1/A2 linked clip audio is implied by the video; A3 vo, A4 music, A5+ sfx
  const audioNode = descend(seq, 'media', 'audio');
  const aTracks = audioNode ? children(audioNode, 'track') : [];
  const vo: AudioClip[] = [];
  const music: AudioClip[] = [];
  const sfx: AudioClip[] = [];
  const audioIds = new Set<string>();
  let linkedClipAudio = 0;
  aTracks.forEach((trk, ti) => {
    const idx = ti + 1;
    const label = `A${idx}`;
    const role = idx === 3 ? 'vo' : idx === 4 ? 'music' : 'sfx';
    const list = role === 'vo' ? vo : role === 'music' ? music : sfx;
    const tItems = readItems(trk, label, fps, fileOf, warn);
    tItems.forEach((it, k) => {
      if (it.kind !== 'clip') return;
      if (children(it.node, 'link').some((l) => childText(l, 'mediatype') === 'video')) {
        linkedClipAudio++;
        return;
      }
      if (idx <= 2 || idx > 5) warn(`${label}: '${it.name}' is not on a vo/music/sfx track; treated as ${role}`);
      const prev = tItems[k - 1];
      const next = tItems[k + 1];
      const prevT = prev?.kind === 'trans' && tItems[k - 2]?.kind === 'clip' ? prev : undefined;
      const nextT = next?.kind === 'trans' && tItems[k + 2]?.kind === 'clip' ? next : undefined;
      const ac: AudioClip = { id: uniqueId(audioIds, it.name, `${role}${list.length + 1}`), src: srcFor(it, label), at: it.start, dur: it.end - it.start };
      if (it.in > 0) ac.in = it.in;
      const lv = readLevels(it.node, it.in, it.out);
      if (lv.gainDb !== undefined) ac.gainDb = lv.gainDb;
      const fadeIn = lv.fadeIn ?? (prevT ? prevT.end - prevT.start : undefined);
      const fadeOut = lv.fadeOut ?? (nextT ? nextT.end - nextT.start : undefined);
      if (fadeIn !== undefined && fadeIn > 0) ac.fadeIn = fadeIn;
      if (fadeOut !== undefined && fadeOut > 0) ac.fadeOut = fadeOut;
      list.push(ac);
    });
  });
  const byAt = (x: AudioClip, y: AudioClip): number => x.at - y.at;
  const audio: AudioTracks = { vo: vo.sort(byAt), music: music.sort(byAt), sfx: sfx.sort(byAt) };
  if (linkedClipAudio === 0 && p && video.some((c) => (p.assets[c.src] ? assetHasAudio(p.assets[c.src] as Asset) : false))) audio.useClipAudio = false;
  if (p?.timeline.audio.duck) audio.duck = { ...p.timeline.audio.duck };

  const timeline: Timeline = { video, cuts, audio };
  return { fps, width, height, timeline, unresolvedPaths, warnings };
}
