import type { Clip, Cut, Frames, Project, StyleRules } from '../core/types.js';
/** Edge type of a clip. Built-ins: 'card' (AE comp / still / graphic), 'footage' (camera), 'logo'. */
export type EdgeType = 'card' | 'footage' | 'logo' | (string & {});
export type JoinRule = NonNullable<StyleRules['joins']>[number];
export interface EdgeOptions {
    /** regex (case-insensitive) matched against asset id, slot, comp name and file name; default logo|โลโก้ */
    logoPattern?: string;
    /** explicit edge types by clip id, slot id or asset id (checked in that order) */
    overrides?: Record<string, EdgeType>;
}
export interface JoinRow {
    after: string;
    next: string;
    at: Frames;
    tc: string;
    from: EdgeType;
    to: EdgeType;
    dissolve: Frames;
    /** timeline frames of picture available past A's out / before B's in (null = unlimited, undefined = unknown length) */
    handles: {
        after: Frames | null | undefined;
        before: Frames | null | undefined;
    };
    /** longest dissolve the handles allow (null = unlimited, undefined = unknown) */
    maxDissolve: Frames | null | undefined;
    policy?: {
        dissolve: Frames;
        rule: string;
        reversed?: boolean;
    };
    match: 'match' | 'differs' | 'no-rule' | 'no-policy';
}
export interface JoinReport {
    policy: 'styleRules.joins' | 'given' | 'none';
    rules: JoinRule[];
    cuts: JoinRow[];
    counts: Record<string, number>;
    note: string;
}
export interface JoinProposal {
    after: string;
    next: string;
    at: Frames;
    tc: string;
    from: EdgeType;
    to: EdgeType;
    current: Frames;
    proposed: Frames;
    rule: string;
    feasible: boolean;
    reason?: string;
}
export declare function edgeTypeOf(p: Project, clip: Clip, opts?: EdgeOptions): EdgeType;
/**
 * The rule for an edge pair: exact match first, then one side '*', then '*'→'*'. A rule also covers the
 * reverse direction (footage→card uses card→footage) unless some rule names that direction.
 */
export declare function ruleFor(rules: JoinRule[], from: EdgeType, to: EdgeType): {
    rule: JoinRule;
    reversed: boolean;
} | undefined;
/** Every cut with its edge types, dissolve, handles and (when a policy exists) whether it matches. */
export declare function joinReport(p: Project, opts?: EdgeOptions & {
    rules?: JoinRule[];
}): JoinReport;
/**
 * Dissolve changes the join policy asks for. No policy (no StyleRules.joins and no rules given) = no
 * proposal at all. A proposal is infeasible when the handles cannot carry it (it is never clamped).
 */
export declare function proposeJoins(p: Project, opts?: EdgeOptions & {
    rules?: JoinRule[];
}): {
    report: JoinReport;
    proposals: JoinProposal[];
};
/** Cuts with the given proposals applied (one entry per changed cut; 0 removes the dissolve). */
export declare function applyJoinProposals(cuts: Cut[], proposals: JoinProposal[]): Cut[];
