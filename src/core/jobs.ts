import type { JobInfo, JobStatus, Progress } from './types.js';

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

interface Entry {
  info: JobInfo;
  fn: JobFn;
  ac: AbortController;
  waiters: Array<(info: JobInfo) => void>;
  cancelRequested: boolean;
}

const FINAL: ReadonlySet<JobStatus> = new Set<JobStatus>(['done', 'failed', 'cancelled']);

function snapshot(info: JobInfo): JobInfo {
  const copy: JobInfo = { ...info, log: info.log.slice() };
  if (info.progress) copy.progress = { ...info.progress };
  return copy;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const short = (err as { shortMessage?: unknown }).shortMessage; // execa
    return (typeof short === 'string' && short) || err.message || err.name;
  }
  return String(err) || 'unknown error';
}

export class JobManager {
  private seq = 0;
  private running = 0;
  private readonly entries = new Map<string, Entry>();
  private readonly queue: string[] = [];
  private readonly maxConcurrent: number;
  private readonly maxLogLines: number;

  constructor(opts: JobManagerOptions = {}) {
    this.maxConcurrent = Math.max(1, Math.floor(opts.maxConcurrent ?? 1));
    this.maxLogLines = Math.max(1, Math.floor(opts.maxLogLines ?? 200));
  }

  /** Registers the job and runs it as soon as a slot is free. Returned info is a snapshot; poll with get(). */
  start(name: string, fn: JobFn): JobInfo {
    const id = `job-${String(++this.seq).padStart(4, '0')}`;
    const entry: Entry = {
      info: { id, name, status: 'queued', log: [] },
      fn,
      ac: new AbortController(),
      waiters: [],
      cancelRequested: false,
    };
    this.entries.set(id, entry);
    this.queue.push(id);
    this.pump();
    return snapshot(entry.info);
  }

  get(id: string): JobInfo | undefined {
    const e = this.entries.get(id);
    return e ? snapshot(e.info) : undefined;
  }

  list(): JobInfo[] {
    return [...this.entries.values()].map((e) => snapshot(e.info));
  }

  /** Queued: dropped immediately. Running: the job's AbortSignal fires; status becomes 'cancelled' once it settles. */
  cancel(id: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    if (e.info.status === 'queued') {
      const i = this.queue.indexOf(id);
      if (i >= 0) this.queue.splice(i, 1);
      e.cancelRequested = true;
      this.settle(e, 'cancelled', 'cancelled before start');
      return true;
    }
    if (e.info.status === 'running') {
      e.cancelRequested = true;
      e.ac.abort(new Error('cancelled'));
      return true;
    }
    return false;
  }

  wait(id: string): Promise<JobInfo> {
    const e = this.entries.get(id);
    if (!e) return Promise.reject(new Error(`unknown job: ${id}`));
    if (FINAL.has(e.info.status)) return Promise.resolve(snapshot(e.info));
    return new Promise((resolve) => e.waiters.push(resolve));
  }

  private pump(): void {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift() as string;
      const e = this.entries.get(id);
      if (e && e.info.status === 'queued') this.run(e);
    }
  }

  private run(e: Entry): void {
    this.running++;
    e.info.status = 'running';
    e.info.startedAt = new Date().toISOString();
    const ctx: JobContext = {
      log: (line) => this.appendLog(e, line),
      progress: (p) => { e.info.progress = { ...p }; },
      signal: e.ac.signal,
    };
    let promise: Promise<unknown>;
    try {
      promise = Promise.resolve(e.fn(ctx));
    } catch (err) {
      promise = Promise.reject(err);
    }
    promise.then(
      (result) => {
        e.info.result = result;
        this.finish(e, 'done');
      },
      (err: unknown) => {
        this.finish(e, e.cancelRequested ? 'cancelled' : 'failed', errorMessage(err));
      },
    );
  }

  private finish(e: Entry, status: JobStatus, error?: string): void {
    this.running--;
    this.settle(e, status, error);
    this.pump();
  }

  private settle(e: Entry, status: JobStatus, error?: string): void {
    e.info.status = status;
    e.info.endedAt = new Date().toISOString();
    if (error !== undefined) e.info.error = error;
    const snap = snapshot(e.info);
    for (const w of e.waiters.splice(0)) w(snap);
  }

  private appendLog(e: Entry, text: string): void {
    const lines = String(text).split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const log = e.info.log;
    log.push(...lines);
    if (log.length > this.maxLogLines) log.splice(0, log.length - this.maxLogLines);
  }
}
