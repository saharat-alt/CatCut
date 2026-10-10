import { z } from 'zod';
import type { Constraint, Frames, Project, QcIssue, StyleRules, ToolPaths } from './types.js';
export type RuleSourceKind = 'brief' | 'user';
/** Where a rule came from: the brief/board, or the user's explicit instruction in this project. */
export interface RuleSource {
    source: RuleSourceKind;
    quote: string;
    at: string;
}
/** Constraint + provenance. Extra fields persist in project.json alongside the contract fields. */
export interface RuleConstraint extends Constraint {
    source?: RuleSourceKind;
    quote?: string;
    /** no-repeat-gimmick: the same gimmick may appear on at most this many consecutive clips (default 1) */
    max?: number;
}
/** StyleRules + per-field provenance (`sources.cornerRadiusPct`, `sources['joins:card>footage']` ...). */
export type StyleRulesRecord = StyleRules & {
    sources?: Record<string, RuleSource>;
};
/** Thrown when a change would override the brief (or remove a brief rule) without the user's go-ahead. */
export declare class RuleConflictError extends Error {
    readonly conflicts: string[];
    constructor(message: string, conflicts: string[]);
}
export declare const ConstraintInputSchema: z.ZodObject<{
    source: z.ZodEnum<["brief", "user"]>;
    quote: z.ZodString;
} & {
    text: z.ZodString;
    id: z.ZodOptional<z.ZodString>;
    scope: z.ZodOptional<z.ZodString>;
    check: z.ZodOptional<z.ZodEnum<["board-only", "no-cover-photo", "logo-static", "no-repeat-gimmick", "manual"]>>;
    max: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    text: string;
    source: "brief" | "user";
    quote: string;
    id?: string | undefined;
    check?: "board-only" | "no-cover-photo" | "logo-static" | "no-repeat-gimmick" | "manual" | undefined;
    scope?: string | undefined;
    max?: number | undefined;
}, {
    text: string;
    source: "brief" | "user";
    quote: string;
    id?: string | undefined;
    check?: "board-only" | "no-cover-photo" | "logo-static" | "no-repeat-gimmick" | "manual" | undefined;
    scope?: string | undefined;
    max?: number | undefined;
}>;
export type ConstraintInput = z.input<typeof ConstraintInputSchema>;
/** Every field optional; `null` removes a field. Unknown keys are rejected so typos never pass silently. */
export declare const StylePatchSchema: z.ZodObject<{
    cornerRadiusPct: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    safeMarginPct: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    palette: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodString, "many">>>;
    joins: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
        from: z.ZodString;
        to: z.ZodString;
        dissolve: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        from: string;
        to: string;
        dissolve: number;
    }, {
        from: string;
        to: string;
        dissolve: number;
    }>, "many">>>;
    thai: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        minCapHeightPct: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        minWeight: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        lowerVowelClearancePx: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        animateBy: z.ZodOptional<z.ZodNullable<z.ZodEnum<["line", "word", "char"]>>>;
    }, "strict", z.ZodTypeAny, {
        minCapHeightPct?: number | null | undefined;
        minWeight?: number | null | undefined;
        lowerVowelClearancePx?: number | null | undefined;
        animateBy?: "line" | "word" | "char" | null | undefined;
    }, {
        minCapHeightPct?: number | null | undefined;
        minWeight?: number | null | undefined;
        lowerVowelClearancePx?: number | null | undefined;
        animateBy?: "line" | "word" | "char" | null | undefined;
    }>>>;
    maxStaticSec: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
}, "strict", z.ZodTypeAny, {
    thai?: {
        minCapHeightPct?: number | null | undefined;
        minWeight?: number | null | undefined;
        lowerVowelClearancePx?: number | null | undefined;
        animateBy?: "line" | "word" | "char" | null | undefined;
    } | null | undefined;
    cornerRadiusPct?: number | null | undefined;
    safeMarginPct?: number | null | undefined;
    palette?: string[] | null | undefined;
    joins?: {
        from: string;
        to: string;
        dissolve: number;
    }[] | null | undefined;
    maxStaticSec?: number | null | undefined;
}, {
    thai?: {
        minCapHeightPct?: number | null | undefined;
        minWeight?: number | null | undefined;
        lowerVowelClearancePx?: number | null | undefined;
        animateBy?: "line" | "word" | "char" | null | undefined;
    } | null | undefined;
    cornerRadiusPct?: number | null | undefined;
    safeMarginPct?: number | null | undefined;
    palette?: string[] | null | undefined;
    joins?: {
        from: string;
        to: string;
        dissolve: number;
    }[] | null | undefined;
    maxStaticSec?: number | null | undefined;
}>;
export declare function listConstraints(p: Project): RuleConstraint[];
/**
 * Add a constraint (mutates `p`; the caller saves). Returns warnings the agent must act on: a user rule that
 * looks like it competes with a brief rule (same check, same scope) means: stop and ask the user.
 */
export declare function addConstraint(p: Project, input: ConstraintInput, now?: Date): {
    constraint: RuleConstraint;
    warnings: string[];
};
/** Remove by id. Removing a brief rule needs `userConfirmed` (the user explicitly agreed to drop it). */
export declare function removeConstraint(p: Project, id: string, opts?: {
    userConfirmed?: boolean;
}): RuleConstraint;
/**
 * Validate and merge a StyleRules patch (mutates `p`; the caller saves). Scalars replace, `thai` merges per
 * field, `joins` merge by (from, to), `palette` replaces, `null` removes. A user patch that changes a field the
 * brief set throws RuleConflictError unless `overrideBrief` (only after the user said so).
 */
export declare function setStyleRules(p: Project, patch: unknown, meta: {
    source: RuleSourceKind;
    quote: string;
    overrideBrief?: boolean;
}, now?: Date): {
    styleRules: StyleRulesRecord;
    changed: string[];
};
export interface ChecklistItem {
    id: string;
    kind: 'priority' | 'constraint' | 'style' | 'visual' | 'process';
    text: string;
    source?: string;
    auto?: boolean;
}
/** Compact Thai/English checklist the agent must re-read before every edit and build. */
export declare function rulesForAgent(p: Project): {
    text: string;
    items: ChecklistItem[];
};
/** One-line notice to show (and get a yes) before calling a paid external service or connector. */
export declare function costNotice(service: string): string;
export interface RulesCheckResult {
    issues: QcIssue[];
    /** rules a person/agent must verify by eye (no-cover-photo, manual, unchecked text) */
    checklist: ChecklistItem[];
    /** machine checks that could not run, with the reason */
    skipped: string[];
}
export interface RulesCheckOptions {
    /** effect / preset match names per asset id (e.g. from ae_inspect_comp), for no-repeat-gimmick */
    effects?: Record<string, string[]>;
}
export declare function checkRules(p: Project, opts?: RulesCheckOptions): RulesCheckResult;
export interface EvidenceInstance {
    instance: number;
    clipId: string;
    src: string;
    comp?: string;
    start: Frames;
    dur: Frames;
    frame: Frames;
    tc: string;
    sourceFrame: Frames;
}
export interface EvidencePlan {
    versionId: string;
    master: string;
    fps: number;
    from: 'reviewPlan' | 'timeline';
    instances: EvidenceInstance[];
    warnings: string[];
}
export interface EvidenceTarget {
    assetId?: string;
    clipIds?: string[];
    /** frame inside each instance, relative to the clip start; default: middle of the dissolve-free part */
    offset?: Frames;
}
/**
 * Every timeline instance of an asset/comp (or the given clips) in a version, with one frame each to grab,
 * so a claim like "fixed everywhere" can be backed by one picture per instance.
 */
export declare function evidenceFrames(p: Project, versionId: string | undefined, target: EvidenceTarget): EvidencePlan;
export interface EvidenceResult {
    dir: string;
    frames: Array<EvidenceInstance & {
        path: string;
    }>;
    contactSheet?: string;
    warnings: string[];
}
/**
 * Grab each instance's frame from the version master into <project>/review/evidence/<version>/ (new names only,
 * `-n`), then tile them into a labelled contact sheet. Frame-accurate: input seek lands on the first frame whose
 * pts >= (frame - 0.25) / fps.
 */
export declare function extractEvidence(tools: Pick<ToolPaths, 'ffmpeg'>, p: Project, plan: EvidencePlan, opts?: {
    signal?: AbortSignal;
}): Promise<EvidenceResult>;
