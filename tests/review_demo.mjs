// Synthetic, isolated sample. Never opens Adobe or production media.
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { createAppState } from '../dist/mcp/state.js';
import { callTool, toolResultData } from '../dist/mcp/tools.js';

const root = join(process.cwd(), 'tmp', 'review-demo');
await mkdir(root, { recursive: true });
const dir = await mkdtemp(join(root, 'demo-'));
const state = await createAppState();
state.env.encoders.h264_nvenc = false;
state.env.encoders.h264_qsv = false;
async function call(name, args = {}) {
  const result = await callTool(state, name, args);
  const body = toolResultData(result);
  if (result.isError) throw new Error(JSON.stringify(body));
  if (!body.jobId) return body;
  const job = await state.jobs.wait(body.jobId);
  if (job.status !== 'done') throw new Error(job.error || job.status);
  return job.result;
}
const media = join(dir, 'ฟุตเทจตัวอย่าง.mp4');
await execa(state.env.tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '10', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', media], { windowsHide: true, timeout: 60_000 });
await call('project_new', { dir: join(dir, 'project'), name: 'ตัวอย่างรีวิว · สื่อสังเคราะห์', width: 640, height: 360, fps: 25 });
await call('asset_add', { path: media, id: 'camera' });
await call('timeline_set', { timeline: { video: [
  { id: 's1', src: 'camera', in: 0, dur: 50, marker: 'เปิดเรื่อง' },
  { id: 's2', src: 'camera', in: 60, dur: 75, marker: 'เล่าเรื่อง' },
  { id: 's3', src: 'camera', in: 150, dur: 50, marker: 'ปิดเรื่อง' },
], cuts: [{ after: 's1', dissolve: 10 }, { after: 's2', dissolve: 13 }], audio: { vo: [], music: [], sfx: [] } } });
await call('build', { skipDeliver: true });
const review = await call('review_open');
console.log(JSON.stringify({ project: state.project.dir, ...review }, null, 2));
const close = () => { void Promise.all([...state.reviews.values()].map(r => r.close())); };
process.once('SIGINT', close); process.once('SIGTERM', close);
