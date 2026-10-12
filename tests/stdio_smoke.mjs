// Release smoke: exercise the compiled CLI over real MCP stdio; Adobe is never launched.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { execa } from 'execa';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { discoverTools } from '../dist/core/tools.js';

const dir = await mkdtemp(join(os.tmpdir(), 'editmcp-stdio-'));
const client = new Client({ name: 'release-smoke', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/mcp/cli.js', import.meta.url)), 'serve'],
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)), EDITMCP_ALLOW_AE: '0' },
  stderr: 'pipe',
});
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}
async function job(name, args = {}) {
  const started = await call(name, args);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const job = await call('job_status', { id: started.jobId });
    if (job.status === 'done') return job.result;
    assert.ok(!['failed', 'cancelled'].includes(job.status), JSON.stringify(job));
    await delay(50);
  }
  throw new Error(`${name} timed out`);
}
try {
  const tools = discoverTools(), clip = join(dir, 'คลิป.mp4');
  await execa(tools.ffmpeg, ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', clip], { windowsHide: true, timeout: 60_000 });
  await client.connect(transport);
  assert.ok((await client.listTools()).tools.some((t) => t.name === 'build'));
  assert.equal((await call('doctor')).aeVersion, 'unknown (not launched)');
  await call('project_new', { dir: join(dir, 'project'), name: 'stdio', width: 320, height: 180 });
  await call('asset_add', { id: 'cam', path: clip });
  await call('timeline_set', { timeline: { video: [{ id: 'shot', src: 'cam', in: 0, dur: 25 }] } });
  const first = await job('build', { skipDeliver: true }), cached = await job('build', { skipDeliver: true });
  assert.equal(first.stats.segmentsRendered, 1);
  assert.equal(cached.stats.segmentsRendered, 0);
  assert.equal(cached.stats.segmentsReused, 1);
  assert.notEqual(first.master, cached.master);
  assert.equal((await call('qc_report')).qc.frames, 25);
  const xml = await call('export_premiere_xml');
  assert.equal((await call('import_premiere_xml', { path: xml.path })).applied, false); // dry run by default
  assert.equal((await call('import_premiere_xml', { path: xml.path, apply: true })).applied, true);
  assert.ok((await call('ready_check')).apps.some((a) => a.app === 'after-effects'));
  const review = await job('review_open');
  const data = await fetch(review.url + 'data').then(r => r.json());
  assert.equal(data.plan.frames, 25);
  assert.equal(data.plan.shots[0].id, 'shot');
  assert.equal((await fetch(review.url + 'media', { headers: { Range: 'bytes=0-99' } })).status, 206);
  const saved = await fetch(review.url + 'session', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: new URL(review.url).origin }, body: JSON.stringify({ revision: 0, notes: [{ id: 'note-1', frame: 5, in: 0, out: 10, intent: 'text', text: 'แก้ข้อความไทย', strokes: [{ points: [[0.2, 0.3], [0.6, 0.4]] }] }] }) });
  assert.equal(saved.status, 200);
  await call('review_submit', { revision: 1 });
  const notes = await call('review_notes');
  assert.equal(notes.session.status, 'submitted');
  assert.equal(notes.session.notes[0].sourceFrame, 5);
  await call('review_close');
  await assert.rejects(fetch(review.url));
  console.log('PASS: compiled MCP stdio, build/cache/QC/XML, review proxy/HTTP/notes/submission/close; Adobe not launched');
} finally {
  await client.close();
  await transport.close();
  await rm(dir, { recursive: true, force: true });
}
