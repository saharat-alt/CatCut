import type { Encoders, ToolPaths } from '../core/types.js';
import { type SpawnFn } from './aerender.js';
export interface ProxyJob {
    source: string;
    proxy: string;
}
/** Originals under `sources` (files or folders) → `<proxyDir>/<folder>/<name>_Proxy.mp4`, keeping the folder layout. */
export declare function planProxies(sources: string[], proxyDir: string): Promise<ProxyJob[]>;
export interface ProxyOptions {
    height?: number;
    spawn?: SpawnFn;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number, file: string) => void;
}
export interface ProxyRow {
    source: string;
    proxy: string;
    status: 'made' | 'exists' | 'failed';
    error?: string;
    frames?: number;
    bytes?: number;
}
export declare function makeProxies(tools: ToolPaths, encoders: Encoders, jobs: ProxyJob[], opts?: ProxyOptions): Promise<{
    rows: ProxyRow[];
    bytes: number;
}>;
