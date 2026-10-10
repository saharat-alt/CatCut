import { fork } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { captureReviewPlan, createProject, saveProject } from '../../src/core/project.js';
import type { Version } from '../../src/core/types.js';

it('allows only one competing process to save a shared revision', async () => {
  const dir = await mkdtemp(join(os.tmpdir(), 'editmcp-review-race-'));
  const children: ReturnType<typeof fork>[] = [];
  try {
    const p = await createProject(join(dir, 'project'), { name: 'race', width: 320, height: 180 });
    p.timeline.video = [{ id: 's1', src: 'cam', in: 0, dur: 25 }];
    p.versions = [{ id: 'v001', planHash: 'fixture', reviewPlan: captureReviewPlan(p) } as Version];
    await saveProject(p);
    const file = join(dir, 'writer.mjs');
    await writeFile(file, `
      import { loadProject } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/core/project.ts')).href)};
      import { saveReviewSession } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/review/session.ts')).href)};
      const p = await loadProject(process.argv[2]);
      process.send('ready');
      process.once('message', async () => {
        try {
          await saveReviewSession(p, p.versions[0], { revision: 0, notes: Array.from({length: 80}, (_, i) => ({ id: String(i), frame: 0, in: 0, out: 1, intent: 'text', text: 'x'.repeat(5000), strokes: [] })) });
          process.send(200);
        } catch (e) { process.send(e.status || 500); }
        process.disconnect();
      });
    `);
    const results: Array<Promise<number>> = [];
    await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
      const child = fork(file, [p.dir], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
      children.push(child);
      child.once('error', reject);
      child.once('message', () => resolve());
      results.push(new Promise((resolve, reject) => {
        child.on('message', value => { if (typeof value === 'number') resolve(value); });
        child.once('error', reject);
        child.once('exit', code => { if (code) reject(new Error(`writer exited ${code}`)); });
      }));
    })));
    for (const child of children) child.send('go');
    const statuses = await Promise.all(results);
    expect(statuses.sort()).toEqual([200, 409, 409, 409]);
  } finally {
    for (const child of children) child.kill();
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
