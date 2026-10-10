import type { JobInfo, Progress } from './types.js';
export interface JobContext {
    log(line: string): void;
    progress(p: Progress): void;
    readonly signal: AbortSignal;
}
export type JobFn = (ctx: JobContext) => Promise<unknown>;
export interface JobManagerOptions {
    /** Jobs running at once; the rest wait as 'queued'. Default 1: builds and renders are heavy. */
    maxConcurrent?: number;
    /** Log lines kept per job. Default 200. */
    maxLogLines?: number;
}
export declare class JobManager {
    private seq;
    private running;
    private readonly entries;
    private readonly queue;
    private readonly maxConcurrent;
    private readonly maxLogLines;
    constructor(opts?: JobManagerOptions);
    /** Registers the job and runs it as soon as a slot is free. Returned info is a snapshot; poll with get(). */
    start(name: string, fn: JobFn): JobInfo;
    get(id: string): JobInfo | undefined;
    list(): JobInfo[];
    /** Queued: dropped immediately. Running: the job's AbortSignal fires; status becomes 'cancelled' once it settles. */
    cancel(id: string): boolean;
    wait(id: string): Promise<JobInfo>;
    private pump;
    private run;
    private finish;
    private settle;
    private appendLog;
}
