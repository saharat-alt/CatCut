import type { AeCompAsset, Clip, ClipSpeed, FileAsset, Frames, ProbeInfo, Project, ReviewPlan, Timeline } from './types.js';
export interface ProjectPaths {
    cacheSegments: string;
    cacheRenders: string;
    cacheAudio: string;
    out: string;
    review: string;
    tmp: string;
}
export declare function createProject(dir: string, meta: {
    name: string;
    fps?: number;
    width?: number;
    height?: number;
}): Promise<Project>;
/** `dir` may be the project directory or the project.json path itself. */
export declare function loadProject(dir: string): Promise<Project>;
export declare class ProjectConflictError extends Error {
    readonly conflicts: string[];
    readonly file: string;
    constructor(conflicts: string[], file: string);
}
export declare class ProjectLockedError extends Error {
    readonly lockFile: string;
    constructor(lockFile: string, holder: string);
}
/** True when `target` is (inside) a protected path. Lexical check first, so a protected tree is never even stat'ed. */
export declare function isProtected(target: string): boolean;
export interface SaveOptions {
    /** how long to wait for another process's project.lock (default 15 s) */
    lockTimeoutMs?: number;
    /** a lock older than this is reclaimed even if its pid is alive (default 2 min) */
    staleLockMs?: number;
}
/**
 * Atomic (temp file + rename) and concurrency-safe: under project.lock, re-reads project.json; if another
 * process saved since this object was loaded/saved, merges both (see merge3) and adopts their changes in
 * place, or throws ProjectConflictError without writing. `dir` is not persisted.
 */
export declare function saveProject(p: Project, opts?: SaveOptions): Promise<void>;
export declare function projectPaths(p: Project): ProjectPaths;
export declare function addFileAsset(p: Project, filePath: string, opts?: {
    id?: string;
    kind?: FileAsset['kind'];
    probe?: (path: string) => Promise<ProbeInfo>;
}): Promise<FileAsset>;
export declare function addAeComp(p: Project, aep: string, comp: string, id?: string): AeCompAsset;
export declare function setTimeline(p: Project, t: Timeline): void;
export interface SpeedCurve {
    r0: number;
    r1: number;
    R: number;
}
/** The clip's retime curve, or undefined for realtime (no speed, rate 1, no ramp). */
export declare function speedCurve(c: Pick<Clip, 'speed'>): SpeedCurve | undefined;
/** Effective interpolation: the clip's choice, else blend when any part of the curve is slow motion, else nearest. */
export declare function clipInterpolation(c: Pick<Clip, 'speed'>): NonNullable<ClipSpeed['interpolation']>;
/** Average rate of the clip over its duration (constant rate, or source span / dur for ramps); 1 when realtime. */
export declare function averageRate(c: Pick<Clip, 'dur' | 'speed'>): number;
/** Source position (relative to `in`, fractional frames) at clip-local timeline time t. */
export declare function curvePos(c: SpeedCurve, t: number): number;
/** Inverse of curvePos: timeline time at which the source position reaches m. */
export declare function curveTime(c: SpeedCurve, m: number): number;
/** First clip-local slot that shows source frame `in + m` (nearest sampling). */
export declare function curveSlot(c: SpeedCurve, m: number): number;
/** Source frame (relative to `in`) shown at clip-local slot k with nearest sampling. */
export declare function shownFrame(c: SpeedCurve | undefined, k: number): number;
/** Source frames the clip covers: round(dur * rate) for constant speed (the contract), the curve's span for ramps. */
export declare function clipSourceSpan(c: Pick<Clip, 'dur' | 'speed'>): Frames;
/**
 * Source range (relative to `in`, [first, end)) a clip needs when it also shows `before` timeline
 * frames of handle ahead of its in-point and `after` frames past its out-point (dissolves). The body
 * needs max(span, last shown frame + 1); handles need every frame they show (nearest sampling; a blend
 * or motion lookahead past the source end holds the last frame instead).
 */
export declare function clipSourceNeeds(c: Pick<Clip, 'dur' | 'speed'>, before?: number, after?: number): {
    first: number;
    end: number;
};
export declare function validateTimeline(p: Project): string[];
export declare function timelineFrames(p: Project): Frames;
export declare function captureReviewPlan(p: Project): ReviewPlan;
export declare function clipStartFrames(p: Project): Map<string, Frames>;
/**
 * Identity of what a build would produce: timeline + the content identity of every referenced
 * asset (file hash / comp fingerprint, falling back to the path when not yet known) + picture format.
 * Unreferenced assets, project name and delivery settings do not affect it.
 */
export declare function planHash(p: Project): string;
/** 'v001', 'v002', ...: one past the highest existing id, skipping any id whose out/ folder already exists. */
export declare function nextVersionId(p: Project): string;
