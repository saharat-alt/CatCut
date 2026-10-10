import { z } from 'zod';
import type { Project, ReviewPlan, Version } from '../core/types.js';
/** Pen colour = edit intent (DESIGN §7.5). The UI chips in web/review/style.css use the same values. */
export declare const INTENT_COLORS: {
    readonly cut: "#ff5a52";
    readonly timing: "#ffd23f";
    readonly text: "#4c8dff";
    readonly color: "#3ccf6e";
    readonly audio: "#b77cff";
    readonly other: "#c4c4cc";
};
/**
 * open = the agent should act; resolved = done; parked = "พักไว้ / ยังไม่ต้องแก้": kept for later, the agent must not act on it.
 * Sessions written before 'parked' existed only contain open/resolved and still parse.
 */
export declare const NOTE_STATUSES: readonly ["open", "resolved", "parked"];
declare const sessionSchema: z.ZodObject<{
    version: z.ZodString;
    planHash: z.ZodString;
    revision: z.ZodNumber;
    updatedAt: z.ZodString;
    status: z.ZodEnum<["draft", "submitted"]>;
    notes: z.ZodArray<z.ZodEffects<z.ZodObject<{
        id: z.ZodString;
        frame: z.ZodNumber;
        in: z.ZodNumber;
        out: z.ZodNumber;
        intent: z.ZodEnum<["audio" | "text" | "other" | "timing" | "cut" | "color", ...("audio" | "text" | "other" | "timing" | "cut" | "color")[]]>;
        color: z.ZodOptional<z.ZodString>;
        text: z.ZodDefault<z.ZodString>;
        strokes: z.ZodArray<z.ZodEffects<z.ZodObject<{
            kind: z.ZodDefault<z.ZodEnum<["free", "circle", "arrow"]>>;
            points: z.ZodArray<z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>, "many">;
            intent: z.ZodOptional<z.ZodEnum<["audio" | "text" | "other" | "timing" | "cut" | "color", ...("audio" | "text" | "other" | "timing" | "cut" | "color")[]]>>;
            color: z.ZodOptional<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            kind: "free" | "circle" | "arrow";
            points: [number, number][];
            color?: string | undefined;
            intent?: "audio" | "text" | "other" | "timing" | "cut" | "color" | undefined;
        }, {
            points: [number, number][];
            kind?: "free" | "circle" | "arrow" | undefined;
            color?: string | undefined;
            intent?: "audio" | "text" | "other" | "timing" | "cut" | "color" | undefined;
        }>, {
            kind: "free" | "circle" | "arrow";
            points: [number, number][];
            color?: string | undefined;
            intent?: "audio" | "text" | "other" | "timing" | "cut" | "color" | undefined;
        }, {
            points: [number, number][];
            kind?: "free" | "circle" | "arrow" | undefined;
            color?: string | undefined;
            intent?: "audio" | "text" | "other" | "timing" | "cut" | "color" | undefined;
        }>, "many">;
        status: z.ZodDefault<z.ZodEnum<["open", "resolved", "parked"]>>;
        revertTo: z.ZodOptional<z.ZodObject<{
            version: z.ZodString;
            clipId: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            version: string;
            clipId: string;
        }, {
            version: string;
            clipId: string;
        }>>;
    } & {
        shot: z.ZodString;
        asset: z.ZodString;
        sourceFrame: z.ZodNumber;
        comp: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        text: string;
        id: string;
        out: number;
        in: number;
        status: "open" | "resolved" | "parked";
        frame: number;
        intent: "audio" | "text" | "other" | "timing" | "cut" | "color";
        strokes: {
            kind: "free" | "circle" | "arrow";
            points: [number, number][];
            color?: string | undefined;
            intent?: "audio" | "text" | "other" | "timing" | "cut" | "color" | undefined;
        }[];
        shot: string;
        asset: string;
        sourceFrame: number;
        comp?: string | undefined;
        color?: string | undefined;
        revertTo?: {
            version: string;
            clipId: string;
        } | undefined;
    }, {
        id: string;
        out: number;
        in: number;
        frame: number;
        intent: "audio" | "text" | "other" | "timing" | "cut" | "color";
        strokes: {
            points: [number, number][];
            kind?: "free" | "circle" | "arrow" | undefined;
            color?: string | undefined;
            intent?: "audio" | "text" | "other" | "timing" | "cut" | "color" | undefined;
        }[];
        shot: string;
        asset: string;
        sourceFrame: number;
        comp?: string | undefined;
        text?: string | undefined;
        status?: "open" | "resolved" | "parked" | undefined;
        color?: string | undefined;
        revertTo?: {
            version: string;
            clipId: string;
        } | undefined;
    }>, {
        text: string;
        id: string;
        out: number;
        in: number;
        status: "open" | "resolved" | "parked";
        frame: number;
        intent: "audio" | "text" | "other" | "timing" | "cut" | "color";
        strokes: {
            kind: "free" | "circle" | "arrow";
            points: [number, number][];
            color?: string | undefined;
            intent?: "audio" | "text" | "other" | "timing" | "cut" | "color" | undefined;
        }[];
        shot: string;
        asset: string;
        sourceFrame: number;
        comp?: string | undefined;
        color?: string | undefined;
        revertTo?: {
            version: string;
            clipId: string;
        } | undefined;
    } & {
        color: string;
    }, {
        id: string;
        out: number;
        in: number;
        frame: number;
        intent: "audio" | "text" | "other" | "timing" | "cut" | "color";
        strokes: {
            points: [number, number][];
            kind?: "free" | "circle" | "arrow" | undefined;
            color?: string | undefined;
            intent?: "audio" | "text" | "other" | "timing" | "cut" | "color" | undefined;
        }[];
        shot: string;
        asset: string;
        sourceFrame: number;
        comp?: string | undefined;
        text?: string | undefined;
        status?: "open" | "resolved" | "parked" | undefined;
        color?: string | undefined;
        revertTo?: {
            version: string;
            clipId: string;
        } | undefined;
    }>, "many">;
}, "strict", z.ZodTypeAny, {
    status: "draft" | "submitted";
    version: string;
    notes: ({
        text: string;
        id: string;
        out: number;
        in: number;
        status: "open" | "resolved" | "parked";
        frame: number;
        intent: "audio" | "text" | "other" | "timing" | "cut" | "color";
        strokes: {
            kind: "free" | "circle" | "arrow";
            points: [number, number][];
            color?: string | undefined;
            intent?: "audio" | "text" | "other" | "timing" | "cut" | "color" | undefined;
        }[];
        shot: string;
        asset: string;
        sourceFrame: number;
        comp?: string | undefined;
        color?: string | undefined;
        revertTo?: {
            version: string;
            clipId: string;
        } | undefined;
    } & {
        color: string;
    })[];
    revision: number;
    planHash: string;
    updatedAt: string;
}, {
    status: "draft" | "submitted";
    version: string;
    notes: {
        id: string;
        out: number;
        in: number;
        frame: number;
        intent: "audio" | "text" | "other" | "timing" | "cut" | "color";
        strokes: {
            points: [number, number][];
            kind?: "free" | "circle" | "arrow" | undefined;
            color?: string | undefined;
            intent?: "audio" | "text" | "other" | "timing" | "cut" | "color" | undefined;
        }[];
        shot: string;
        asset: string;
        sourceFrame: number;
        comp?: string | undefined;
        text?: string | undefined;
        status?: "open" | "resolved" | "parked" | undefined;
        color?: string | undefined;
        revertTo?: {
            version: string;
            clipId: string;
        } | undefined;
    }[];
    revision: number;
    planHash: string;
    updatedAt: string;
}>;
export type ReviewSession = z.infer<typeof sessionSchema>;
declare const storedDraft: z.ZodObject<{
    frame: z.ZodNumber;
    in: z.ZodNumber;
    out: z.ZodNumber;
    intent: z.ZodEnum<["audio" | "text" | "other" | "timing" | "cut" | "color", ...("audio" | "text" | "other" | "timing" | "cut" | "color")[]]>;
    text: z.ZodString;
    strokes: z.ZodArray<z.ZodEffects<z.ZodObject<{
        kind: z.ZodDefault<z.ZodEnum<["free", "circle", "arrow"]>>;
        points: z.ZodArray<z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>, "many">;
        intent: z.ZodOptional<z.ZodEnum<["audio" | "text" | "other" | "timing" | "cut" | "color", ...("audio" | "text" | "other" | "timing" | "cut" | "color")[]]>>;
        color: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        kind: "free" | "circle" | "arrow";
        points: [number, number][];
        color?: string | undefined;
        intent?: "audio" | "text" | "other" | "timing" | "cut" | "color" | undefined;
    }, {
        points: [number, number][];
        kind?: "free" | "circle" | "arrow" | undefined;
        color?: string | undefined;
        intent?: "audio" | "text" | "other" | "timing" | "cut" | "color" | undefined;
    }>, {
        kind: "free" | "circle" | "arrow";
        points: [number, number][];
        color?: string | undefined;
        intent?: "audio" | "text" | "other" | "timing" | "cut" | "color" | undefined;
    }, {
        points: [number, number][];
        kind?: "free" | "circle" | "arrow" | undefined;
        color?: string | undefined;
        intent?: "audio" | "text" | "other" | "timing" | "cut" | "color" | undefined;
    }>, "many">;
    editingId: z.ZodOptional<z.ZodString>;
} & {
    version: z.ZodString;
    planHash: z.ZodString;
    updatedAt: z.ZodString;
}, "strict", z.ZodTypeAny, {
    text: string;
    out: number;
    in: number;
    version: string;
    frame: number;
    intent: "audio" | "text" | "other" | "timing" | "cut" | "color";
    strokes: {
        kind: "free" | "circle" | "arrow";
        points: [number, number][];
        color?: string | undefined;
        intent?: "audio" | "text" | "other" | "timing" | "cut" | "color" | undefined;
    }[];
    planHash: string;
    updatedAt: string;
    editingId?: string | undefined;
}, {
    text: string;
    out: number;
    in: number;
    version: string;
    frame: number;
    intent: "audio" | "text" | "other" | "timing" | "cut" | "color";
    strokes: {
        points: [number, number][];
        kind?: "free" | "circle" | "arrow" | undefined;
        color?: string | undefined;
        intent?: "audio" | "text" | "other" | "timing" | "cut" | "color" | undefined;
    }[];
    planHash: string;
    updatedAt: string;
    editingId?: string | undefined;
}>;
type ReviewDraft = z.infer<typeof storedDraft>;
export declare class ReviewError extends Error {
    readonly status: number;
    constructor(message: string, status?: number);
}
export declare function versionPlan(p: Project, v: Version): ReviewPlan;
export declare function readReviewSession(p: Project, v: Version): Promise<ReviewSession>;
export declare function saveReviewSession(p: Project, v: Version, input: unknown): Promise<ReviewSession>;
type StoredNote = ReviewSession['notes'][number];
export interface AgentReview {
    /** How the agent must treat the lists below. */
    rule: string;
    /** status 'open': propose a fix plan for these (confirm before building). */
    actionable: StoredNote[];
    /** status 'parked' (พักไว้ / ยังไม่ต้องแก้): informational only, change nothing for them. */
    parked: StoredNote[];
    resolved: StoredNote[];
    /** Actionable notes that ask to bring a shot back from another version: shot_revert(version, clipId). */
    revertRequests: Array<{
        noteId: string;
        version: string;
        clipId: string;
        frame: number;
    }>;
}
/** Split notes into what the agent may act on and what is parked. */
export declare function agentReview(s: ReviewSession): AgentReview;
export declare function submitReview(p: Project, v: Version, revision?: number): Promise<{
    session: ReviewSession;
    path: string;
} & AgentReview>;
/** The unsaved editor draft (text, marks, range) so a reload or crash does not lose it. Not part of the agent-facing notes. */
export declare function readReviewDraft(p: Project, v: Version): Promise<ReviewDraft | null>;
export declare function saveReviewDraft(p: Project, v: Version, input: unknown): Promise<ReviewDraft | null>;
export {};
