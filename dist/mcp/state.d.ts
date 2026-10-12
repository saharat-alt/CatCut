import type { ReviewServer } from '../review/server.js';
import type { PremiereClient, PremiereHost } from '../engine/premiere.js';
import type { AeBackend, AeCompAsset, Asset, BuildOptions, BuildResult, DeliveryTargetId, Environment, FileAsset, Frames, JobInfo, ProbeInfo, Progress, Project, Timeline, XmemlReadResult, XmemlWriteOptions } from '../core/types.js';
export interface ProjectApi {
    createProject(dir: string, meta: {
        name: string;
        fps?: number;
        width?: number;
        height?: number;
    }): Promise<Project>;
    loadProject(dir: string): Promise<Project>;
    saveProject(p: Project): Promise<void>;
    projectPaths(p: Project): {
        cacheSegments: string;
        cacheRenders: string;
        cacheAudio: string;
        out: string;
        review: string;
        tmp: string;
    };
    addFileAsset(p: Project, path: string, opts?: {
        id?: string;
        kind?: FileAsset['kind'];
        probe?: (path: string) => Promise<ProbeInfo>;
    }): Promise<FileAsset>;
    addAeComp(p: Project, aep: string, comp: string, id?: string): AeCompAsset;
    setTimeline(p: Project, t: Timeline): void;
    validateTimeline(p: Project): string[];
    timelineFrames(p: Project): Frames;
    planHash(p: Project): string;
    nextVersionId(p: Project): string;
    clipStartFrames(p: Project): Map<string, Frames>;
}
export interface XmemlApi {
    writeXmeml(p: Project, opts: XmemlWriteOptions): string;
    /** `warnings` (dropped V2+ clips, gaps, speed changes, ambiguous audio roles...) when the reader provides them */
    readXmeml(xml: string, p?: Project): XmemlReadResult & {
        warnings?: string[];
    };
}
export interface AssemblerLike {
    build(p: Project, opts?: BuildOptions): Promise<BuildResult>;
    deliver(p: Project, versionId: string, targets: DeliveryTargetId[], opts?: {
        onProgress?: (p: Progress) => void;
        signal?: AbortSignal;
    }): Promise<Record<string, string>>;
    reviewProxy(p: Project, versionId: string, opts?: {
        signal?: AbortSignal;
    }): Promise<string>;
}
export interface JobContext {
    log(line: string): void;
    progress(p: Progress): void;
    signal: AbortSignal;
}
export interface JobManagerLike {
    start(name: string, fn: (ctx: JobContext) => Promise<unknown>): JobInfo;
    get(id: string): JobInfo | undefined;
    list(): JobInfo[];
    cancel(id: string): boolean;
    wait(id: string): Promise<JobInfo>;
}
export interface AppState {
    reviews?: Map<string, ReviewServer>;
    /** Premiere handoff bridge client (created on first use; tests inject a fake) */
    premiere?: PremiereClient;
    /** process checks + launcher for Premiere (tests inject a fake) */
    premiereHost?: PremiereHost;
    /** set when CatCut started Premiere itself: only then premiere_close may quit it without force */
    premiereLaunched?: {
        project: string;
        pid?: number;
    };
    project?: Project;
    env: Environment;
    ae: AeBackend;
    assembler: AssemblerLike;
    jobs: JobManagerLike;
    api: {
        project: ProjectApi;
        xmeml: XmemlApi;
        probe: (path: string) => Promise<ProbeInfo>;
    };
    /** environment problems found at startup (doctor reports them; tools that need ffmpeg refuse) */
    problems: string[];
}
/** Environment that never throws: missing ffmpeg becomes a `problems` entry instead. */
export declare function safeEnvironment(): Promise<{
    env: Environment;
    problems: string[];
}>;
/** Wire the real modules. AE is never launched here (the backend spawns per call). */
export declare function createAppState(opts?: {
    projectDir?: string;
}): Promise<AppState>;
export declare function requireProject(state: AppState): Project;
export declare function requireFfmpeg(state: AppState): void;
export declare function isAeComp(a: Asset): a is AeCompAsset;
/** aecomp assets whose render is missing or stale (fingerprint changed since the render). */
export declare function compsNeedingRender(p: Project): string[];
