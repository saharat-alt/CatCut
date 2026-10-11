import type { AeBackend, ToolPaths } from '../core/types.js';
import { type SpawnFn } from './aerender.js';
export declare const isEcProject: (path: string) => boolean;
export interface EffectCraftOptions {
    spawn?: SpawnFn;
    /** inspect / version (default 2 min) */
    timeoutMs?: number;
    /** edit / create (default 10 min) */
    scriptTimeoutMs?: number;
    minFreeRamGb?: number;
}
export declare function createEffectCraftBackend(tools: ToolPaths, opts?: EffectCraftOptions): AeBackend;
/**
 * One AeBackend over both hosts: `.ecproj` paths go to EffectCraft, all others to After Effects.
 * Optional analysis methods stay After Effects only and say so for `.ecproj`. `kind` is the After
 * Effects backend's, so existing reports do not change.
 */
export declare function createMotionBackend<A extends AeBackend>(ae: A, ec: AeBackend): A;
