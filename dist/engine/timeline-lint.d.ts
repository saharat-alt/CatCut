import type { Clip, Frames, Project, QcIssue } from '../core/types.js';
/** What lint needs from a shot index (structurally compatible with engine/shots.ts ShotIndex). */
export interface ShotData {
    frames: Frames;
    cuts: Frames[];
    motion?: number[];
}
export type ShotIndexMap = ReadonlyMap<string, ShotData> | Readonly<Record<string, ShotData | undefined>>;
export interface LintRules {
    flashFrames?: Frames;
    nearClips?: number;
    maxStaticSec?: number;
    staticMotion?: number;
    checks?: Array<'cutcross' | 'flash' | 'repeat' | 'lowmotion' | 'slowmo'>;
}
export interface LintIssue extends QcIssue {
    tc?: string;
    sourceFrame?: Frames;
    side?: 'head' | 'tail' | 'middle';
    suggestion?: string;
}
/** Source frames consumed by a clip body: round(dur × rate) for constant speed. */
export declare function consumedFrames(clip: Clip): Frames;
export declare function lintTimeline(p: Project, shots: ShotIndexMap, rules?: LintRules): LintIssue[];
export interface SnapOptions {
    headHandle?: Frames;
    tailHandle?: Frames;
    allowDurChange?: boolean;
}
export interface SnapProposal {
    clipId: string;
    changed: boolean;
    before: {
        in: Frames;
        dur: Frames;
    };
    in: Frames;
    dur: Frames;
    reasons: string[];
    warnings: string[];
}
/**
 * Move a clip's source window so its visible head/tail land on source shot boundaries when a
 * boundary sits within k timeline frames inside the clip (a leak of the neighbouring shot).
 * Keeps the timeline duration by sliding the window; shortens the clip only when allowed.
 * Never moves the window outside [0, source length).
 */
export declare function snapToShots(clip: Clip, shots: ShotData, k: Frames, opts?: SnapOptions): SnapProposal;
