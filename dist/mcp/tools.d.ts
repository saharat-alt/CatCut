import { z } from 'zod';
import type { Timeline } from '../core/types.js';
import { type AppState } from './state.js';
import { type ToolDef, type ToolResult } from './tooldef.js';
export type { ToolDef, ToolResult } from './tooldef.js';
export declare function runTool(t: ToolDef, args: unknown, state: AppState): Promise<ToolResult>;
/** Validate args with the tool's schema and run it (used by the CLI and tests). */
export declare function callTool(state: AppState, name: string, args?: Record<string, unknown>): Promise<ToolResult>;
/** Parse the JSON body of a ToolResult. */
export declare function toolResultData(r: ToolResult): Record<string, unknown>;
declare const EditOpSchema: z.ZodDiscriminatedUnion<"op", [z.ZodObject<{
    op: z.ZodLiteral<"insert">;
    clip: z.ZodObject<{
        id: z.ZodString;
        src: z.ZodString;
        in: z.ZodNumber;
        dur: z.ZodNumber;
        scale: z.ZodOptional<z.ZodNumber>;
        marker: z.ZodOptional<z.ZodString>;
        slot: z.ZodOptional<z.ZodString>;
        speed: z.ZodOptional<z.ZodObject<{
            rate: z.ZodNumber;
            rampFrom: z.ZodOptional<z.ZodNumber>;
            rampFrames: z.ZodOptional<z.ZodNumber>;
            interpolation: z.ZodOptional<z.ZodEnum<["nearest", "blend", "motion"]>>;
        }, "strip", z.ZodTypeAny, {
            rate: number;
            rampFrom?: number | undefined;
            interpolation?: "nearest" | "blend" | "motion" | undefined;
            rampFrames?: number | undefined;
        }, {
            rate: number;
            rampFrom?: number | undefined;
            interpolation?: "nearest" | "blend" | "motion" | undefined;
            rampFrames?: number | undefined;
        }>>;
        pushIn: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        src: string;
        in: number;
        dur: number;
        speed?: {
            rate: number;
            rampFrom?: number | undefined;
            interpolation?: "nearest" | "blend" | "motion" | undefined;
            rampFrames?: number | undefined;
        } | undefined;
        scale?: number | undefined;
        marker?: string | undefined;
        slot?: string | undefined;
        pushIn?: number | undefined;
    }, {
        id: string;
        src: string;
        in: number;
        dur: number;
        speed?: {
            rate: number;
            rampFrom?: number | undefined;
            interpolation?: "nearest" | "blend" | "motion" | undefined;
            rampFrames?: number | undefined;
        } | undefined;
        scale?: number | undefined;
        marker?: string | undefined;
        slot?: string | undefined;
        pushIn?: number | undefined;
    }>;
    index: z.ZodOptional<z.ZodNumber>;
    after: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    clip: {
        id: string;
        src: string;
        in: number;
        dur: number;
        speed?: {
            rate: number;
            rampFrom?: number | undefined;
            interpolation?: "nearest" | "blend" | "motion" | undefined;
            rampFrames?: number | undefined;
        } | undefined;
        scale?: number | undefined;
        marker?: string | undefined;
        slot?: string | undefined;
        pushIn?: number | undefined;
    };
    op: "insert";
    after?: string | undefined;
    index?: number | undefined;
}, {
    clip: {
        id: string;
        src: string;
        in: number;
        dur: number;
        speed?: {
            rate: number;
            rampFrom?: number | undefined;
            interpolation?: "nearest" | "blend" | "motion" | undefined;
            rampFrames?: number | undefined;
        } | undefined;
        scale?: number | undefined;
        marker?: string | undefined;
        slot?: string | undefined;
        pushIn?: number | undefined;
    };
    op: "insert";
    after?: string | undefined;
    index?: number | undefined;
}>, z.ZodObject<{
    op: z.ZodLiteral<"move">;
    id: z.ZodString;
    index: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    id: string;
    op: "move";
    index: number;
}, {
    id: string;
    op: "move";
    index: number;
}>, z.ZodObject<{
    op: z.ZodLiteral<"remove">;
    id: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    op: "remove";
}, {
    id: string;
    op: "remove";
}>, z.ZodObject<{
    op: z.ZodLiteral<"trim">;
    id: z.ZodString;
    in: z.ZodOptional<z.ZodNumber>;
    dur: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    id: string;
    op: "trim";
    in?: number | undefined;
    dur?: number | undefined;
}, {
    id: string;
    op: "trim";
    in?: number | undefined;
    dur?: number | undefined;
}>, z.ZodObject<{
    op: z.ZodLiteral<"set_dissolve">;
    after: z.ZodString;
    frames: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    frames: number;
    op: "set_dissolve";
    after: string;
}, {
    frames: number;
    op: "set_dissolve";
    after: string;
}>, z.ZodObject<{
    op: z.ZodLiteral<"set_marker">;
    id: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    id: string;
    op: "set_marker";
    name?: string | undefined;
}, {
    id: string;
    op: "set_marker";
    name?: string | undefined;
}>, z.ZodObject<{
    op: z.ZodLiteral<"set_scale">;
    id: z.ZodString;
    scale: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    id: string;
    scale: number;
    op: "set_scale";
}, {
    id: string;
    scale: number;
    op: "set_scale";
}>, z.ZodObject<{
    op: z.ZodLiteral<"remove_audio">;
    id: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    op: "remove_audio";
}, {
    id: string;
    op: "remove_audio";
}>]>;
type EditOp = z.infer<typeof EditOpSchema>;
/** Never overwrite: returns p, or p_2, p_3 ... (before the extension). */
export declare function uniquePath(p: string): string;
export declare function applyEditOps(t: Timeline, ops: EditOp[]): Timeline;
interface ClipChange {
    index: number;
    id?: string;
    field: string;
    from?: unknown;
    to?: unknown;
}
/** Positional diff of two timelines (Premiere does not preserve our clip ids reliably). */
export declare function diffTimelines(a: Timeline, b: Timeline): {
    frames: {
        before: number;
        after: number;
    };
    clips: {
        before: number;
        after: number;
        changed: ClipChange[];
    };
    dissolves: {
        after: string;
        from: number;
        to: number;
    }[];
    audio: {
        before: {
            vo: number;
            music: number;
            sfx: number;
        };
        after: {
            vo: number;
            music: number;
            sfx: number;
        };
    };
};
export declare const TOOLS: readonly ToolDef[];
