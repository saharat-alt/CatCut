import type { Project, XmemlReadResult, XmemlWriteOptions } from '../core/types.js';
export interface XmemlReadOptions {
    /** Decoded absolute path -> asset id. Consulted before the project's own asset table. */
    resolveAsset?: (absPath: string) => string | undefined;
}
export interface XmemlReadResultEx extends XmemlReadResult {
    /** Things the model cannot represent or that were guessed: gaps, off-center transitions, snapped markers… */
    warnings: string[];
}
/**
 * Absolute path -> Premiere's own form `file://localhost/D%3a/…` (UNC: `file://server/share/…`).
 * Every segment is percent-encoded UTF-8, so Thai survives.
 */
export declare function pathToUrl(abs: string): string;
/** `file:///D:/…`, `file://localhost/D%3a/…` (Premiere), `file://server/share/…` -> absolute path (Windows separators where it is a Windows path). */
export declare function pathFromUrl(url: string): string;
/** What the XML cannot carry exactly (speed ramps, optical-flow interpolation, muted slow-mo audio). */
export declare function xmemlExportWarnings(p: Project): string[];
export declare function writeXmeml(p: Project, opts: XmemlWriteOptions): string;
export declare function readXmeml(xml: string, p?: Project, opts?: XmemlReadOptions): XmemlReadResultEx;
