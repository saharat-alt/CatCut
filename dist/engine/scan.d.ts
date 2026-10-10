import type { ToolPaths } from '../core/types.js';
export type ScanFlag = 'vfr' | 'interlaced' | 'low-res' | 'odd-fps' | 'fps-mismatch' | 'pillarbox' | 'letterbox' | 'mojibake' | 'no-video' | 'probe-failed';
export interface ScanProbe {
    durationSec?: number;
    fps?: number;
    rFrameRate?: string;
    avgFrameRate?: string;
    vfr?: boolean;
    width?: number;
    height?: number;
    videoCodec?: string;
    pixFmt?: string;
    fieldOrder?: string;
    audioCodec?: string;
    audioChannels?: number;
}
export interface ActiveArea {
    x: number;
    y: number;
    w: number;
    h: number;
    pillarbox: boolean;
    letterbox: boolean;
}
export interface ScanFile {
    path: string;
    rel: string;
    name: string;
    kind: 'video' | 'audio' | 'still';
    size: number;
    probe?: ScanProbe;
    activeArea?: ActiveArea;
    fixedRel?: string;
    slot?: string;
    flags: ScanFlag[];
    notes: string[];
}
export interface ScanReport {
    dir: string;
    recursive: boolean;
    files: ScanFile[];
    renamePlan: Array<{
        from: string;
        to: string;
    }>;
    slots: Record<string, string[]>;
    unslotted: string[];
    summary: Record<string, number>;
}
export interface ScanOptions {
    recursive?: boolean;
    crop?: boolean;
    projectFps?: number;
    concurrency?: number;
    signal?: AbortSignal;
    onFile?: (done: number, total: number, rel: string) => void;
}
/**
 * Proposed name when `name` looks like Thai (or other UTF-8) text misdecoded as cp437 / cp1252,
 * else undefined. Names that already contain Thai, or are plain ASCII, are left alone.
 */
export declare function fixMojibake(name: string): string | undefined;
/** Slot id from a file/folder name: leading digits plus an optional single letter ("01_a.mov" → "01", "28r_x" → "28r"). */
export declare function slotOf(name: string): string | undefined;
export declare function scanFootage(tools: ToolPaths, dir: string, opts?: ScanOptions): Promise<ScanReport>;
export interface AliasResult {
    aliasDir: string;
    created: Array<{
        source: string;
        alias: string;
        method: 'hardlink' | 'copy';
    }>;
    skipped: Array<{
        source: string;
        alias: string;
        reason: string;
    }>;
    index: string;
}
/**
 * Correctly named hardlinks (copy when the volume differs) for every mojibake file, inside
 * `aliasDir` only. Never touches the user's files and never overwrites: an existing alias is skipped.
 * `aliases.json` maps alias path → original path (merged with what is already there).
 */
export declare function applyAliases(report: ScanReport, aliasDir: string): Promise<AliasResult>;
