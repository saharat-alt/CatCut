import type { Frames, Project, ReviewPlan, ToolPaths, Version } from '../core/types.js';
/** A frame f in [start, start+dur) of the source plan maps to clamp(toStart + f - start, toMin, toMax). */
export interface MapSegment {
    start: Frames;
    dur: Frames;
    toStart: Frames;
    toMin: Frames;
    toMax: Frames;
}
export interface FrameMap {
    /** 'timecode': same length, same frame number. 'shot': lengths differ, matched by clip id. */
    method: 'timecode' | 'shot';
    warning?: string;
    segments: MapSegment[];
}
/** How frames of `from` land in `to`. Same length → by timecode; otherwise by shot id (source-aligned when the source is the same). */
export declare function mapFrames(from: ReviewPlan, to: ReviewPlan, labels?: {
    from: string;
    to: string;
}): FrameMap;
export declare function mapFrame(map: FrameMap, f: Frames): Frames;
export interface ComparableVersion {
    id: string;
    createdAt: string;
    frames: Frames;
    proxy: string;
    plan: ReviewPlan;
}
/**
 * Other versions of this project that can be shown next to `current`: valid id, a frozen shot plan,
 * the same fps, and a review proxy that exists inside the project folder.
 */
export declare function comparableVersions(p: Project, current: Version): Promise<ComparableVersion[]>;
export declare function findComparable(p: Project, current: Version, id: string): Promise<ComparableVersion>;
export interface ComparePair {
    clipId?: string;
    a: Frames;
    b: Frames;
}
/** Pick frame pairs: explicit A frames, or the middle of each listed (or every) A shot; B frames come from the mapping. */
export declare function comparePairs(a: ReviewPlan, b: ReviewPlan, opts?: {
    clipIds?: string[];
    frames?: Frames[];
}, max?: number): {
    pairs: ComparePair[];
    map: FrameMap;
};
interface Side {
    id: string;
    media: string;
    plan: ReviewPlan;
}
export interface CompareSheetResult {
    path: string;
    sidecar: string;
    labelled: boolean;
    method: FrameMap['method'];
    warning?: string;
    pairs: Array<{
        clipId?: string;
        a: {
            version: string;
            frame: Frames;
            tc: string;
        };
        b: {
            version: string;
            frame: Frames;
            tc: string;
        };
    }>;
}
/** Render a two-column before/after sheet (A left, B right), one row per pair. Never overwrites. */
export declare function renderCompareSheet(opts: {
    tools: ToolPaths;
    a: Side;
    b: Side;
    pairs: ComparePair[];
    outPath: string;
    map: FrameMap;
    signal?: AbortSignal;
    timeoutMs?: number;
}): Promise<CompareSheetResult>;
/** Media used for the sheet: the ProRes master when present, else the review proxy. */
export declare function sheetMedia(v: Version): string;
export {};
