import type { Frames, ToolPaths } from '../core/types.js';
export declare const DEFAULT_SCENE_THRESHOLD = 10;
export interface Shot {
    start: Frames;
    end: Frames;
    motion: number;
}
export interface ShotIndex {
    path: string;
    fileHash: string;
    threshold: number;
    ffmpegVersion: string;
    fps: number;
    frames: Frames;
    cuts: Frames[];
    shots: Shot[];
    motion: number[];
    createdAt: string;
}
export interface DetectShotsOptions {
    fps: number;
    threshold?: number;
    cacheDir?: string;
    fileHash?: string;
    ffmpegVersion?: string;
    force?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
}
export declare function ffmpegVersion(tools: ToolPaths): Promise<string>;
export declare function shotCachePath(cacheDir: string, fileHash: string): string;
/** Cached index for this file/threshold/ffmpeg/fps, without decoding anything. */
export declare function loadCachedShots(cacheDir: string, fileHash: string, opts: {
    fps: number;
    threshold?: number;
    ffmpegVersion: string;
}): Promise<ShotIndex | undefined>;
/**
 * Shot changes + per-frame motion of the first video stream. The path is only ever an `-i` argument
 * (Thai paths are safe). Returns the cached index when one matches.
 */
export declare function detectShots(tools: ToolPaths, path: string, opts: DetectShotsOptions): Promise<ShotIndex & {
    cached: boolean;
}>;
