import { describe, expect, it } from 'vitest';
import { JobManager } from '../../src/core/jobs.js';

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('JobManager', () => {
  it('assigns sequential ids and runs a job to done with its result', async () => {
    const jm = new JobManager();
    const a = jm.start('one', async () => 1);
    const b = jm.start('two', async () => 'x');
    expect(a.id).toBe('job-0001');
    expect(b.id).toBe('job-0002');
    expect(a.name).toBe('one');
    const ra = await jm.wait(a.id);
    const rb = await jm.wait(b.id);
    expect(ra.status).toBe('done');
    expect(ra.result).toBe(1);
    expect(rb.result).toBe('x');
    expect(ra.startedAt).toBeDefined();
    expect(ra.endedAt).toBeDefined();
    expect(jm.list().map((j) => j.id)).toEqual(['job-0001', 'job-0002']);
  });

  it('records progress and log lines; snapshots are detached from internal state', async () => {
    const jm = new JobManager();
    const gate = deferred();
    const j = jm.start('p', async (ctx) => {
      ctx.log('starting');
      ctx.progress({ stage: 'segments', done: 1, total: 4, message: 'seg 1' });
      await gate.promise;
      ctx.log('line a\nline b\r\n');
      ctx.progress({ stage: 'mux', done: 4, total: 4 });
      return 'ok';
    });
    await tick();
    const mid = jm.get(j.id)!;
    expect(mid.status).toBe('running');
    expect(mid.progress).toEqual({ stage: 'segments', done: 1, total: 4, message: 'seg 1' });
    expect(mid.log).toEqual(['starting']);
    mid.log.push('tampered');
    mid.progress!.done = 99;

    gate.resolve();
    const fin = await jm.wait(j.id);
    expect(fin.status).toBe('done');
    expect(fin.progress).toEqual({ stage: 'mux', done: 4, total: 4 });
    expect(fin.log).toEqual(['starting', 'line a', 'line b']);
  });

  it('keeps only the last 200 log lines', async () => {
    const jm = new JobManager();
    const j = jm.start('log', async (ctx) => {
      for (let i = 0; i < 250; i++) ctx.log(`L${i}`);
    });
    const fin = await jm.wait(j.id);
    expect(fin.log).toHaveLength(200);
    expect(fin.log[0]).toBe('L50');
    expect(fin.log[199]).toBe('L249');
  });

  it('marks a rejected job failed with its message (including synchronous throws)', async () => {
    const jm = new JobManager();
    const a = jm.start('fail', async () => { throw new Error('boom'); });
    const b = jm.start('sync', (() => { throw new Error('sync boom'); }) as never);
    expect((await jm.wait(a.id)).status).toBe('failed');
    expect((await jm.wait(a.id)).error).toBe('boom');
    const rb = await jm.wait(b.id);
    expect(rb.status).toBe('failed');
    expect(rb.error).toBe('sync boom');
  });

  it('cancels a running job through its AbortSignal', async () => {
    const jm = new JobManager();
    let observed = false;
    const j = jm.start('cancel-me', ({ signal, log }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => {
        observed = true;
        log('aborting');
        reject(signal.reason ?? new Error('aborted'));
      });
    }));
    await tick();
    expect(jm.get(j.id)!.status).toBe('running');
    expect(jm.cancel(j.id)).toBe(true);
    const fin = await jm.wait(j.id);
    expect(observed).toBe(true);
    expect(fin.status).toBe('cancelled');
    expect(fin.log).toContain('aborting');
    expect(jm.cancel(j.id)).toBe(false); // already settled
    expect(jm.cancel('job-9999')).toBe(false);
  });

  it('queues beyond maxConcurrent (default 1) and can cancel a queued job', async () => {
    const jm = new JobManager();
    const gateA = deferred();
    const order: string[] = [];
    const a = jm.start('A', async () => { order.push('A'); await gateA.promise; return 'a'; });
    const b = jm.start('B', async () => { order.push('B'); return 'b'; });
    const c = jm.start('C', async () => { order.push('C'); return 'c'; });
    await tick();
    expect(jm.get(a.id)!.status).toBe('running');
    expect(jm.get(b.id)!.status).toBe('queued');
    expect(jm.get(c.id)!.status).toBe('queued');
    expect(order).toEqual(['A']);

    expect(jm.cancel(b.id)).toBe(true);
    const rb = await jm.wait(b.id);
    expect(rb.status).toBe('cancelled');
    expect(rb.startedAt).toBeUndefined();

    gateA.resolve();
    expect((await jm.wait(a.id)).status).toBe('done');
    expect((await jm.wait(c.id)).result).toBe('c');
    expect(order).toEqual(['A', 'C']);
  });

  it('runs jobs in parallel when maxConcurrent allows', async () => {
    const jm = new JobManager({ maxConcurrent: 2 });
    const gate = deferred();
    const a = jm.start('A', async () => gate.promise);
    const b = jm.start('B', async () => gate.promise);
    const c = jm.start('C', async () => 'c');
    await tick();
    expect(jm.get(a.id)!.status).toBe('running');
    expect(jm.get(b.id)!.status).toBe('running');
    expect(jm.get(c.id)!.status).toBe('queued');
    gate.resolve();
    expect((await jm.wait(c.id)).status).toBe('done');
  });

  it('wait() rejects for unknown ids and resolves immediately for settled jobs', async () => {
    const jm = new JobManager();
    await expect(jm.wait('job-0042')).rejects.toThrow(/unknown job/);
    const j = jm.start('fast', async () => 7);
    await jm.wait(j.id);
    expect((await jm.wait(j.id)).result).toBe(7);
    expect(jm.get('nope')).toBeUndefined();
  });
});
