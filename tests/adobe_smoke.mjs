// Opt-in integration test: launches isolated Adobe instances and keeps evidence under tmp/.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { execa } from 'execa';
import { createAppState } from '../dist/mcp/state.js';
import { callTool, toolResultData } from '../dist/mcp/tools.js';
import { hashFile } from '../dist/core/hash.js';
import { killTree } from '../dist/engine/aerender.js';

if (process.env.EDITMCP_TEST_ADOBE !== '1') throw new Error('Set EDITMCP_TEST_ADOBE=1 explicitly; this test opens Adobe.');
const root = join(process.cwd(), 'tmp', 'adobe-test');
await mkdir(root, { recursive: true });
const dir = await mkdtemp(join(root, 'real-'));
const state = await createAppState();
state.env.encoders.h264_nvenc = false;
state.env.encoders.h264_qsv = false;
const aep = join(dir, 'fixture.aep');
const setupResult = join(dir, 'setup.json');
const report = { dir, startedAt: new Date().toISOString(), checks: [], renders: [], builds: [] };
const reportFile = join(dir, 'report.json');
console.log('Evidence:', dir);
async function record(name, value) {
  report.checks.push({ name, value });
  await writeFile(reportFile, JSON.stringify(report, null, 2));
  console.log('PASS', name, typeof value === 'string' ? value : JSON.stringify(value));
}
async function call(name, args = {}) {
  const result = await callTool(state, name, args);
  const value = toolResultData(result);
  if (result.isError) throw new Error(name + ': ' + JSON.stringify(value));
  if (!value.jobId) return value;
  const job = await state.jobs.wait(value.jobId);
  await writeFile(join(dir, name + '-' + value.jobId + '.json'), JSON.stringify(job, null, 2));
  if (job.status !== 'done') throw new Error(name + ': ' + job.error);
  return job.result;
}
const render = state.ae.render;
state.ae.render = async request => {
  const result = await render({ ...request, timeoutMs: 120_000, mfrPercent: 25 });
  report.renders.push({ comp: request.comp, ...result });
  await writeFile(reportFile, JSON.stringify(report, null, 2));
  return result;
};
try {
  assert.ok(os.freemem() / 2 ** 30 >= 0.75, 'Not enough free RAM for isolated AE test');
  const setup = join(dir, 'setup.jsx');
  const runner = await readFile(new URL('../jsx/runner.jsx', import.meta.url), 'utf8');
  const serializer = runner.slice(runner.indexOf('function stringify('), runner.indexOf('function parse('));
  await writeFile(setup, `
    (function () {
      ${serializer}
      function step(s) { var f = new File(${JSON.stringify(setupResult + '.steps')}); f.encoding = "UTF-8"; f.open("a"); f.writeln(s); f.close(); }
      step("script started");
      app.beginSuppressDialogs(); app.saveProjectOnCrash = false;
      step("dialogs suppressed");
      var result = {};
      try {
        step("before close");
        if (app.project) app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
        step("closed");
        app.newProject();
        step("new project");
        function make(name, title, bg) {
          var c = app.project.items.addComp(name, 640, 360, 1, 2, 25);
          c.layers.addSolid(bg, "Background", 640, 360, 1, 2);
          var stripe = c.layers.addSolid([1, .55, .1], "Accent", 480, 4, 1, 2);
          stripe.property("ADBE Transform Group").property("ADBE Position").setValue([320, 240]);
          var t = c.layers.addText(title); t.name = "Title";
          var p = t.property("ADBE Text Properties").property("ADBE Text Document"), d = p.value;
          d.font = "Tahoma"; d.fontSize = 36; d.fillColor = [1,1,1]; d.applyFill = true;
          d.justification = ParagraphJustification.CENTER_JUSTIFY; p.setValue(d);
          t.property("ADBE Transform Group").property("ADBE Position").setValue([320, 180]);
          return c;
        }
        var c = make("TITLE", "ทดสอบ Adobe จริง", [.035,.035,.04]);
        step("title comp");
        make("END", "EDITMCP · AFTER EFFECTS", [.09,.09,.1]);
        step("end comp");
        var rq = app.project.renderQueue.items.add(c), names = rq.outputModule(1).templates;
        result.templates = [];
        for (var i=0; i<names.length; i++) result.templates.push(String(names[i]));
        rq.remove();
        step("templates read");
        app.project.save(new File(${JSON.stringify(aep)}));
        step("project saved");
        result.version = app.version; result.ok = true; app.exitCode = 0;
      } catch(e) { result.ok = false; result.error = String(e); app.exitCode = 1; }
      finally {
        var f = new File(${JSON.stringify(setupResult)}); f.encoding = "UTF-8"; f.open("w");
        f.write(stringify(result)); f.close();
        if (app.project) app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
        app.endSuppressDialogs(false); app.quit();
      }
    })();
  `, 'utf8');
  // shortcut: this AE 26.5 installation crashes on newProject() with -noui; use GUI setup until Adobe supports it here.
  const child = execa(state.env.tools.afterfx, ['-m', '-r', setup], { reject: false, windowsHide: true, timeout: 0 });
  const timer = setTimeout(() => { void killTree(child.pid); }, 120_000);
  let created;
  try { created = await child; } finally { clearTimeout(timer); }
  await writeFile(join(dir, 'setup.log'), created.stdout + '\n' + created.stderr);
  assert.equal(created.exitCode, 0, 'AE fixture creation failed: ' + created.stderr);
  const fixture = JSON.parse((await readFile(setupResult, 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(fixture.ok, true, fixture.error);
  report.version = fixture.version; report.templates = fixture.templates;
  await record('isolated fixture saved', fixture.version);

  const list = await call('ae_list_comps', { aep });
  assert.equal(list.comps.length, 2);
  await record('list comps', list.comps.map(c => c.name));
  const inspected = await call('ae_inspect_comp', { aep, comp: 'TITLE', atFrame: 8 });
  assert.equal(inspected.layers.find(l => l.name === 'Title').text, 'ทดสอบ Adobe จริง');
  await record('inspect Thai text and fingerprint', inspected);
  await call('project_new', { dir: join(dir, 'project'), name: 'Adobe จริง · ทดสอบแยก', fps: 25, width: 640, height: 360 });
  await call('asset_add', { aep, comp: 'TITLE', id: 'title' });
  await call('asset_add', { aep, comp: 'END', id: 'end' });
  await call('timeline_set', { timeline: {
    video: [{ id: 's1', src: 'title', in: 8, dur: 25 }, { id: 's2', src: 'end', in: 8, dur: 25 }],
    cuts: [{ after: 's1', dissolve: 13 }], audio: { vo: [], music: [], sfx: [] },
  } });
  async function build(name) {
    const value = await call('build', { skipDeliver: true });
    report.builds.push({ name, ...value });
    const probe = await execa(state.env.tools.ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', value.master], { windowsHide: true, timeout: 30_000 });
    const video = JSON.parse(probe.stdout).streams.find(s => s.codec_type === 'video');
    assert.equal(video.codec_name, 'prores'); assert.equal(video.codec_tag_string, 'apch');
    assert.equal(video.width, 640); assert.equal(video.height, 360); assert.equal(Number(video.nb_frames), 50);
    await execa(state.env.tools.ffmpeg, ['-v', 'error', '-nostdin', '-i', value.master, '-f', 'null', '-'], { windowsHide: true, timeout: 60_000 });
    await writeFile(join(dir, value.version + '-probe.json'), probe.stdout);
    await writeFile(join(dir, value.version + '-qc.json'), JSON.stringify(state.project.versions.find(v => v.id === value.version).qc, null, 2));
    await record(name, value.stats);
    return value;
  }
  const first = await build('first build');
  assert.equal(first.stats.compsRendered, 2);
  const originalMaster = await hashFile(first.master);
  const reused = await build('unchanged build');
  assert.equal(reused.stats.compsRendered, 0); assert.equal(reused.stats.segmentsRendered, 0);
  const originalAep = await hashFile(aep);
  const edited = await call('ae_edit', { aep, comp: 'TITLE', ops: [{ op: 'setText', layer: 'Title', text: 'แก้ข้อความไทยสำเร็จ', fontSize: 38 }] });
  const backup = edited.log.find(l => l.startsWith('backup: ')).slice(8);
  assert.equal(await hashFile(backup), originalAep);
  await record('edit Thai text with preserved original backup', edited);
  const changed = await build('one comp changed');
  assert.equal(changed.stats.compsRendered, 1); assert.equal(changed.stats.compsReused, 1);
  assert.equal(changed.stats.segmentsRendered, 1); assert.equal(changed.stats.segmentsReused, 1);
  assert.equal(await hashFile(first.master), originalMaster);
  await record('previous master preserved', first.master);
  const preview = await call('ae_preview_frame', { aep, comp: 'TITLE', frame: 8, out: join(dir, 'เฟรมไทย.png') });
  await record('single frame PNG with Thai output path', preview.png);
  const exported = await call('export_premiere_xml', { version: changed.version, sequenceName: 'Adobe real smoke' });
  await record('XML generated (Premiere import still requires bridge)', exported.path);
  const proxy = await call('preview', { version: changed.version });
  await record('review proxy from Adobe master', proxy.reviewProxy);
  report.status = 'PASS_AE_PREMIERE_UNVERIFIED';
} catch (error) {
  report.status = 'FAIL'; report.error = error.stack || String(error); process.exitCode = 1;
  console.error(report.error);
} finally {
  report.endedAt = new Date().toISOString();
  await writeFile(reportFile, JSON.stringify(report, null, 2));
  console.log('Report:', reportFile);
}
