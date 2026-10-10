import type { Frames } from './types.js';
/** Frames -> "HH:MM:SS:FF" (non-drop-frame). fps is rounded for the FF field. */
export declare function framesToTc(frames: Frames, fps: number): string;
/** "HH:MM:SS:FF" | "MM:SS:FF" | "SS:FF" | plain integer string -> frames. Accepts ';' or '.' as the frame separator. */
export declare function tcToFrames(tc: string, fps: number): Frames;
export declare function framesToSeconds(frames: Frames, fps: number): number;
export declare function secondsToFrames(sec: number, fps: number): Frames;
/** Split a dissolve of n frames around a cut: a before, b after (b >= a). */
export declare function splitDissolve(n: Frames): {
    a: Frames;
    b: Frames;
};
