const FINAL = new Set(['done', 'failed', 'cancelled']);
function snapshot(info) {
    const copy = { ...info, log: info.log.slice() };
    if (info.progress)
        copy.progress = { ...info.progress };
    return copy;
}
function errorMessage(err) {
    if (err instanceof Error) {
        const short = err.shortMessage; // execa
        return (typeof short === 'string' && short) || err.message || err.name;
    }
    return String(err) || 'unknown error';
}
export class JobManager {
    seq = 0;
    running = 0;
    entries = new Map();
    queue = [];
    maxConcurrent;
    maxLogLines;
    constructor(opts = {}) {
        this.maxConcurrent = Math.max(1, Math.floor(opts.maxConcurrent ?? 1));
        this.maxLogLines = Math.max(1, Math.floor(opts.maxLogLines ?? 200));
    }
    /** Registers the job and runs it as soon as a slot is free. Returned info is a snapshot; poll with get(). */
    start(name, fn) {
        const id = `job-${String(++this.seq).padStart(4, '0')}`;
        const entry = {
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
    get(id) {
        const e = this.entries.get(id);
        return e ? snapshot(e.info) : undefined;
    }
    list() {
        return [...this.entries.values()].map((e) => snapshot(e.info));
    }
    /** Queued: dropped immediately. Running: the job's AbortSignal fires; status becomes 'cancelled' once it settles. */
    cancel(id) {
        const e = this.entries.get(id);
        if (!e)
            return false;
        if (e.info.status === 'queued') {
            const i = this.queue.indexOf(id);
            if (i >= 0)
                this.queue.splice(i, 1);
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
    wait(id) {
        const e = this.entries.get(id);
        if (!e)
            return Promise.reject(new Error(`unknown job: ${id}`));
        if (FINAL.has(e.info.status))
            return Promise.resolve(snapshot(e.info));
        return new Promise((resolve) => e.waiters.push(resolve));
    }
    pump() {
        while (this.running < this.maxConcurrent && this.queue.length > 0) {
            const id = this.queue.shift();
            const e = this.entries.get(id);
            if (e && e.info.status === 'queued')
                this.run(e);
        }
    }
    run(e) {
        this.running++;
        e.info.status = 'running';
        e.info.startedAt = new Date().toISOString();
        const ctx = {
            log: (line) => this.appendLog(e, line),
            progress: (p) => { e.info.progress = { ...p }; },
            signal: e.ac.signal,
        };
        let promise;
        try {
            promise = Promise.resolve(e.fn(ctx));
        }
        catch (err) {
            promise = Promise.reject(err);
        }
        promise.then((result) => {
            e.info.result = result;
            this.finish(e, 'done');
        }, (err) => {
            this.finish(e, e.cancelRequested ? 'cancelled' : 'failed', errorMessage(err));
        });
    }
    finish(e, status, error) {
        this.running--;
        this.settle(e, status, error);
        this.pump();
    }
    settle(e, status, error) {
        e.info.status = status;
        e.info.endedAt = new Date().toISOString();
        if (error !== undefined)
            e.info.error = error;
        const snap = snapshot(e.info);
        for (const w of e.waiters.splice(0))
            w(snap);
    }
    appendLog(e, text) {
        const lines = String(text).split(/\r?\n/);
        if (lines.length > 1 && lines[lines.length - 1] === '')
            lines.pop();
        const log = e.info.log;
        log.push(...lines);
        if (log.length > this.maxLogLines)
            log.splice(0, log.length - this.maxLogLines);
    }
}
//# sourceMappingURL=jobs.js.map