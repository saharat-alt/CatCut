import type { Frames, QcIssue, QcReport, ToolPaths } from '../core/types.js';
export interface QcLoudnessTarget {
    integratedLufs: number;
    truePeakDb: number;
    toleranceLu?: number;
}
export interface QcClipStart {
    clipId: string;
    start: Frames;
    dur: Frames;
}
export interface QcArgs {
    tools: ToolPaths;
    path: string;
    expectedFrames: Frames;
    fps: number;
    loudness?: QcLoudnessTarget;
    contactSheetPath?: string;
    clipStarts?: QcClipStart[];
    /** duplicate-frame cadence (stutter, e.g. slow motion made by repeating frames); off by default */
    duplicates?: boolean | QcDuplicateOptions;
    /** timeline-lint issues (flash / lowmotion ...) to carry into the report unchanged */
    lintIssues?: QcIssue[];
    signal?: AbortSignal;
    timeoutMs?: number;
}
export interface QcDuplicateOptions {
    ranges?: Array<{
        start: Frames;
        end: Frames;
    }>;
    minRatio?: number;
    minSec?: number;
    /** mpdecimate thresholds (8×8 block SAD); strict defaults so only near-identical frames count */
    hi?: number;
    lo?: number;
    frac?: number;
}
export interface LoudnessStats {
    integratedLufs: number;
    truePeakDb: number;
    lra: number;
}
/** Integrated loudness, true peak and LRA of the first audio stream (ebur128; loudnorm JSON as fallback). */
export declare function measureLoudness(tools: ToolPaths, path: string): Promise<LoudnessStats>;
export declare function runQc(args: QcArgs): Promise<QcReport>;
