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
async function build() {
  const started = await call('build', { skipDeliver: true });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const job = await call('job_status', { id: started.jobId });
    if (job.status === 'done') return job.result;
    assert.ok(!['failed', 'cancelled'].includes(job.status), JSON.stringify(job));
    await delay(50);
  }
  throw new Error('build timed out');
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
  const first = await build(), cached = await build();
  assert.equal(first.stats.segmentsRendered, 1);
  assert.equal(cached.stats.segmentsRendered, 0);
  assert.equal(cached.stats.segmentsReused, 1);
  assert.notEqual(first.master, cached.master);
  assert.equal((await call('qc_report')).qc.frames, 25);
  const xml = await call('export_premiere_xml');
  assert.equal((await call('import_premiere_xml', { path: xml.path })).applied, true);
  console.log('PASS: compiled MCP stdio, doctor, project/assets/timeline, build/cache/QC, XML round trip; Adobe not launched');
} finally {
  await client.close();
  await transport.close();
  await rm(dir, { recursive: true, force: true });
}
