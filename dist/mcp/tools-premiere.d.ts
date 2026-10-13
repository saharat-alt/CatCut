import { type PremiereClient, type PremiereProjectRef } from '../engine/premiere.js';
import { type AppState } from './state.js';
import { type ToolDef } from './tooldef.js';
export declare function client(state: AppState): PremiereClient;
/**
 * A full .prproj path is opened when needed (Premiere started or the project opened); a bare name
 * must already be the active project.
 */
export declare function ensureProject(state: AppState, wanted: string): Promise<{
    project: PremiereProjectRef;
    launched: boolean;
}>;
/** Told after every Premiere tool: is it saved, may Premiere be closed. */
export declare function closeHint(state: AppState, saved: boolean): string;
export declare const PREMIERE_TOOLS: ToolDef[];
/** Exposed for tests: the bin a file lands in. */
export declare const _binFor: (file: string, root?: string) => string;
