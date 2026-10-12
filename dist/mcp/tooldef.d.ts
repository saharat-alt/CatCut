/**
 * Shared MCP tool plumbing. Feature modules (tools-*.ts) export `ToolDef[]` built with `tool()`;
 * tools.ts concatenates them into TOOLS.
 */
import type { z } from 'zod';
import type { UserAction } from '../core/types.js';
import type { AppState } from './state.js';
/** Told to the agent next to every card: show it as is, then wait. */
export declare const RELAY = "Show userAction.say to the user exactly as written (Thai), then stop and wait for their reply. Do not invent other steps.";
/** A tool failure that needs the person to do something (DESIGN.md §14). */
export declare function needsUser(message: string, action: UserAction, data?: Record<string, unknown>): ToolError;
export interface ToolResult {
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
    [key: string]: unknown;
}
/** Throw to return a structured failure (data is merged into the JSON body). */
export declare class ToolError extends Error {
    readonly data: Record<string, unknown>;
    constructor(message: string, data?: Record<string, unknown>);
}
export interface ToolDef {
    name: string;
    description: string;
    input: z.ZodRawShape;
    handler: (args: never, state: AppState) => Promise<unknown>;
    /** true: changes the project (blocked while a build/deliver/review job runs). */
    mutating?: boolean;
    /** true: writes into the open project's folder (blocked for protected paths). */
    writesProject?: boolean;
}
export declare function tool<S extends z.ZodRawShape>(def: {
    name: string;
    description: string;
    input: S;
    handler: (args: z.infer<z.ZodObject<S>>, state: AppState) => Promise<unknown>;
    mutating?: boolean;
    writesProject?: boolean;
}): ToolDef;
export declare function json(data: unknown): string;
export declare function ok(data: unknown): ToolResult;
export declare function fail(err: unknown): ToolResult;
