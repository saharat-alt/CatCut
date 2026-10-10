import type { Frames } from './types.js';

/** Frames -> "HH:MM:SS:FF" (non-drop-frame). fps is rounded for the FF field. */
export function framesToTc(frames: Frames, fps: number): string {
  const f = Math.round(fps);
  const neg = frames < 0;
  let n = Math.abs(Math.round(frames));
  const ff = n % f; n = (n - ff) / f;
  const ss = n % 60; n = (n - ss) / 60;
  const mm = n % 60; n = (n - mm) / 60;
  const hh = n;
  const p = (v: number) => String(v).padStart(2, '0');
  return `${neg ? '-' : ''}${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}

/** "HH:MM:SS:FF" | "MM:SS:FF" | "SS:FF" | plain integer string -> frames. Accepts ';' or '.' as the frame separator. */
export function tcToFrames(tc: string, fps: number): Frames {
  const s = tc.trim();
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  const neg = s.startsWith('-');
  const parts = s.replace(/^-/, '').split(/[:;.]/).map((x) => parseInt(x, 10));
  if (parts.some((x) => Number.isNaN(x))) throw new Error(`bad timecode: ${tc}`);
  const f = Math.round(fps);
  while (parts.length < 4) parts.unshift(0);
  const [hh, mm, ss, ff] = parts as [number, number, number, number];
  const total = ((hh * 60 + mm) * 60 + ss) * f + ff;
  return neg ? -total : total;
}

export function framesToSeconds(frames: Frames, fps: number): number {
  return frames / fps;
}

export function secondsToFrames(sec: number, fps: number): Frames {
  return Math.round(sec * fps);
}

/** Split a dissolve of n frames around a cut: a before, b after (b >= a). */
export function splitDissolve(n: Frames): { a: Frames; b: Frames } {
  const a = Math.floor(n / 2);
  return { a, b: n - a };
}
