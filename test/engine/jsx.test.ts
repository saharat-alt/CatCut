import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import vm from 'node:vm';

const runner = readFileSync(new URL('../../jsx/runner.jsx', import.meta.url), 'utf8');
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function run(action: string, ops: unknown[] = [], nativeJson = true, extra = '', jobText?: string, jobExtra: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(os.tmpdir(), 'editmcp-jsx-')); dirs.push(dir);
  const aep = join(dir, 'working.aep'), result = join(dir, 'job.result.json'), job = join(dir, 'job.json');
  await writeFile(aep, 'working');
  await writeFile(job, jobText ?? JSON.stringify({ action, aep, result, comp: 'Title', atFrame: 10, ops, ...jobExtra }));
  class File {
    encoding = ''; mode = '';
    constructor(public fsName: string) {}
    get exists() { return existsSync(this.fsName); }
    get modified() { return statSync(this.fsName).mtime; }
    open(mode: string) { this.mode = mode; return true; }
    read() { return readFileSync(this.fsName, 'utf8'); }
    write(text: string) { writeFileSync(this.fsName, text, 'utf8'); }
    close() {}
  }
  const context = vm.createContext({ File, EDITMCP_JOB: job, JSON: nativeJson ? JSON : undefined });
  vm.runInContext(`
    function CompItem() {}
    function TextLayer() {}
    function TextDocument() { this.text = 'เดิม'; this.fontSize = 20; }
    function Shape() {} function ShapeLayer() {} function CameraLayer() {} function LightLayer() {}
    function MarkerValue() {} function KeyframeEase() {} function SolidSource() {}
    var PropertyType = { PROPERTY: 1 }, PropertyValueType = { NO_VALUE: 2, CUSTOM_VALUE: 3 };
    var KeyframeInterpolationType = { BEZIER: 1 }, CloseOptions = { DO_NOT_SAVE_CHANGES: 1 };
    var doc = new TextDocument();
    var text = { name: 'Source Text', matchName: 'ADBE Text Document', propertyType: 1, propertyValueType: 4, numKeys: 0,
      valueAtTime: function () { return doc; }, setValue: function (d) { doc = d; }, setValueAtTime: function (t, d) { doc = d; } };
    Object.defineProperty(text, 'value', { get: function () { return doc; } });
    var layer = new TextLayer(); layer.name = 'Text'; layer.enabled = true; layer.inPoint = 0; layer.outPoint = 4; layer.startTime = 0;
    layer.numProperties = 1; layer.source = null; layer.parent = null;
    layer.property = function (name) {
      if (name === 1) return text;
      if (name === 'ADBE Text Properties') return { property: function () { return text; } };
      if (name === 'ADBE Effect Parade') return { numProperties: 0, addProperty: function () { return { property: function () { return { setValue: function () {} }; } }; } };
      return null;
    };
    var comp = new CompItem(); comp.id = 1; comp.name = 'Title'; comp.width = 320; comp.height = 180; comp.frameRate = 25; comp.duration = 4; comp.numLayers = 1;
    comp.layer = function (name) { return name === 1 || name === 'Text' ? layer : null; };
    var closed = 0, quit = 0, saved = 0;
    var app = { version: '26.0', beginSuppressDialogs: function () {}, endSuppressDialogs: function () {}, quit: function () { quit++; },
      open: function () {}, project: { numItems: 1, item: function () { return comp; }, close: function () { closed++; }, save: function () { saved++; } } };
  ` + extra, context);
  vm.runInContext(runner, context, { timeout: 5000 });
  return { context, result: JSON.parse(await readFile(result, 'utf8')) };
}

describe('ExtendScript runner in a mock AE host', () => {
  it('serializes Unicode, inspects text and closes without saving', async () => {
    const { context, result } = await run('inspect');
    expect(result.ok).toBe(true);
    expect(result.data.layers[0]).toMatchObject({ name: 'Text', text: 'เดิม', kind: 'text', inFrame: 0, outFrame: 100 });
    expect(result.data.snapshot.layers[0].properties[0].value.text).toBe('เดิม');
    expect(context.saved).toBe(0);
    expect(context.quit).toBe(1);
  });
  it('applies text, timing, enabled, effects, properties and explicit script operations', async () => {
    const { context, result } = await run('edit', [
      { op: 'setText', layer: 'Text', text: 'ไทย "ทดสอบ"\nใหม่', fontSize: 48 },
      { op: 'shiftLayer', layer: 'Text', frames: 5 },
      { op: 'setLayerEnabled', layer: 1, enabled: false },
      { op: 'addEffect', layer: 1, matchName: 'ADBE Gaussian Blur 2', properties: {} },
      { op: 'script', jsx: 'comp.width = 640;' },
    ], false);
    expect(result.ok).toBe(true);
    expect(result.data.layers[0].text).toBe('ไทย "ทดสอบ"\nใหม่');
    expect(result.data.width).toBe(640);
    expect(context.layer.startTime).toBe(0.2);
    expect(context.layer.enabled).toBe(false);
    expect(context.saved).toBe(1);
  });
  it('reports invalid operations and never saves a partially applied edit', async () => {
    const { context, result } = await run('edit', [{ op: 'setText', layer: 'missing', text: 'bad' }]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('layer not found');
    expect(context.saved).toBe(0);
    expect(context.quit).toBe(1);
  });
  it('fingerprints expressions by text plus sampled values, flags opaque values, records timing', async () => {
    const extra = `
      comp.displayStartFrame = 250; comp.workAreaStart = 1; comp.workAreaDuration = 2;
      var expr = { name: 'Position', matchName: 'ADBE Position', propertyType: 1, propertyValueType: 5, numKeys: 0,
        canSetExpression: true, expression: 'time * 10', expressionEnabled: true, expressionError: '',
        valueAtTime: function (t, pre) { return pre ? 0 : Math.round(t * 1000) / 100; } };
      var curves = { name: 'Curves', matchName: 'ADBE CurvesCustom', propertyType: 1, propertyValueType: 3, numKeys: 0, canSetExpression: false };
      var baseProperty = layer.property;
      layer.numProperties = 3;
      layer.property = function (n) { return n === 2 ? expr : n === 3 ? curves : baseProperty(n); };
    `;
    const { result } = await run('fingerprint', [], true, extra);
    expect(result.ok).toBe(true);
    const snap = result.data.Title;
    expect(snap).toMatchObject({ durationFrames: 100, displayStartFrame: 250, opaque: true });
    expect(snap.settings).toMatchObject({ workAreaStart: 1, workAreaDuration: 2, displayStartFrame: 250 });
    const [text, position, curvesSnap] = snap.layers[0].properties;
    expect(text.value.opaque).toBe(true); // mock TextDocument has no characterRange
    expect(text.value.text).toBe('เดิม');
    expect(position.expression).toBe('time * 10');
    const frames = position.samples.map((s: { f: number }) => s.f);
    expect(frames[0]).toBe(0);
    expect(frames[frames.length - 1]).toBe(99);
    expect(frames.length).toBe(10);
    expect(position.samples[frames.length - 1].v).toBeCloseTo(39.6);
    expect(curvesSnap.opaque).toBe(true);
    expect(JSON.stringify(result.data)).not.toContain('projectDependency');
  });
  it('still writes a result and quits when the job cannot be read or close throws', async () => {
    const { context, result } = await run('inspect', [], true, `app.project.close = function () { closed++; throw new Error('close failed'); };`, '{not json');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/JSON|Unexpected|invalid/i);
    expect(context.quit).toBe(1);
    const second = await run('inspect', [], true, `app.project.close = function () { closed++; throw new Error('close failed'); };`);
    expect(second.result.ok).toBe(false); // close before open throws -> reported
    expect(second.context.quit).toBe(1);
  });
});

// A richer mock comp for the analysis commands: Thai title animated by words whose motion ends at 1 s,
// a full-frame background that ends at 3 s, a photo behind a track matte, a Controls null.
const ANALYSIS_HOST = `
  function AVLayer() {}
  var PropertyType = { PROPERTY: 1, NAMED_GROUP: 2 };
  var TrackMatteType = { NO_TRACK_MATTE: 0, ALPHA: 1, LUMA: 3 };
  var PurgeTarget = { ALL_CACHES: 'all' }; var purgedWith = null; var opened = 0;
  app.purge = function (t) { purgedWith = t; };
  app.open = function () { opened++; };
  app.fonts = { missingOrSubstitutedFonts: [{ postScriptName: 'Kanit-Bold', familyName: 'Kanit' }] };
  function P(name, mn, o) { var p = { name: name, matchName: mn, propertyType: 1, numKeys: 0, canSetExpression: true, expressionEnabled: false, expression: '' }; for (var k in o) p[k] = o[k]; return p; }
  function V(name, mn, v, o) { var p = P(name, mn, o || {}); p.value = v; p.valueAtTime = function () { return v; }; return p; }
  function G(name, mn, kids) { return { name: name, matchName: mn, propertyType: 2, enabled: true, numProperties: kids.length,
    property: function (i) { if (typeof i === 'number') return kids[i - 1] || null; for (var j = 0; j < kids.length; j++) if (kids[j].matchName === i || kids[j].name === i) return kids[j]; return null; } }; }
  function keyed(p, times) { p.numKeys = times.length; p.keyTime = function (k) { return times[k - 1]; }; return p; }
  function transform(o) { o = o || {}; return G('Transform', 'ADBE Transform Group', [
    V('Anchor Point', 'ADBE Anchor Point', o.anchor || [0, 0]),
    o.position || V('Position', 'ADBE Position', [160, 90]),
    V('Scale', 'ADBE Scale', o.scale || [100, 100]),
    o.opacity || V('Opacity', 'ADBE Opacity', 100)]); }
  function mk(Ctor, name, groups, o) { var l = new Ctor(); l.name = name; l.enabled = true; l.inPoint = 0; l.outPoint = 4; l.startTime = 0; l.stretch = 100;
    l.parent = null; l.source = null; l.hasVideo = true; var g = G(name, 'layer', groups); l.numProperties = g.numProperties; l.property = g.property;
    for (var k in o) l[k] = o[k]; return l; }
  var titleDoc = new TextDocument(); titleDoc.text = 'สวัสดีครับ ทุกคน'; titleDoc.fontSize = 20; titleDoc.font = 'Kanit-Bold'; titleDoc.fontFamily = 'Kanit';
  var selector = G('Range Selector 1', 'ADBE Text Selector', [G('Advanced', 'ADBE Text Range Advanced', [V('Based On', 'ADBE Text Range Type2', 3)])]);
  var title = mk(TextLayer, 'หัวข้อ', [
    G('Text', 'ADBE Text Properties', [V('Source Text', 'ADBE Text Document', titleDoc),
      G('Animators', 'ADBE Text Animators', [G('Animator 1', 'ADBE Text Animator', [G('Selectors', 'ADBE Text Selectors', [selector])])])]),
    transform({ position: keyed(V('Position', 'ADBE Position', [160, 90]), [0, 1]) }),
    keyed(P('Marker', 'ADBE Marker'), [3.9])]);
  var footSource = { name: 'bg.png', width: 320, height: 180, hasVideo: true, mainSource: { isStill: true }, file: { fsName: 'D:\\\\media\\\\bg.png' } };
  var bg = mk(AVLayer, 'BG', [transform({ anchor: [160, 90] })], { outPoint: 3, source: footSource,
    sourceRectAtTime: function () { return { left: 0, top: 0, width: 320, height: 180 }; } });
  var photoSource = { name: 'photo.mov', width: 320, height: 180, hasVideo: true, mainSource: { isStill: false }, file: { fsName: 'D:\\\\media\\\\photo.mov' } };
  var fade = V('Opacity', 'ADBE Opacity', 100, { expressionEnabled: true, expression: 'thisComp.layer("Controls").effect("Fade")(1)' });
  var matte = mk(ShapeLayer, 'Window', [transform()], { enabled: false, isTrackMatte: true });
  var photo = mk(AVLayer, 'Photo', [transform({ opacity: fade })], { source: photoSource, hasTrackMatte: true, trackMatteType: 3, trackMatteLayer: matte });
  var controls = mk(AVLayer, 'Controls', [G('Effects', 'ADBE Effect Parade', [G('Fade', 'ADBE Slider Control', [V('Slider', 'ADBE Slider Control-0001', 1)])])], { nullLayer: true });
  var layers = [title, controls, matte, photo, bg];
  comp.numLayers = layers.length;
  comp.layer = function (i) { return layers[i - 1]; };
`;

describe('runner analysis commands in a mock AE host', () => {
  it('scanTemplate reports placeholders (matte window = still), expression locks, controls, fonts and animators', async () => {
    const { result } = await run('scanTemplate', [], true, ANALYSIS_HOST);
    expect(result.ok).toBe(true);
    const [c] = result.data.comps;
    expect(c).toMatchObject({ name: 'Title', durationFrames: 100, width: 320, height: 180, fonts: ['Kanit-Bold'] });
    expect(c.textAnimators).toEqual([{ layer: 'หัวข้อ', animator: 'Animator 1', basedOn: 'words' }]);
    const byLayer = Object.fromEntries(c.placeholders.map((p: { layer: string }) => [p.layer, p]));
    expect(byLayer['หัวข้อ']).toMatchObject({ kind: 'text', moving: true });
    expect(byLayer['Photo']).toMatchObject({ kind: 'footage', moving: false, matte: 'Window', source: 'D:\\media\\photo.mov' });
    expect(byLayer['BG']).toMatchObject({ kind: 'image', moving: true });
    expect(byLayer['Window']).toBeUndefined(); // the matte itself is not a slot
    expect(c.expressionLocked).toEqual(['Photo > Transform > Opacity']);
    expect(result.data.warnings.join('\n')).toMatch(/Controls.*Fade/);
  });
  it('lintComp finds stopped animation, early background and Thai animators; thai-size only with a project rule', async () => {
    const { result, context } = await run('lintComp', [], true, ANALYSIS_HOST, undefined, { rules: { thai: { minCapHeightPct: 15 } } });
    expect(result.ok).toBe(true);
    expect(context.saved).toBe(0);
    const kinds = result.data.issues.map((i: { kind: string }) => i.kind).sort();
    expect(kinds).toEqual(['animation-ends-early', 'background-ends-early', 'thai-animator', 'thai-size']);
    const anim = result.data.issues.find((i: { kind: string }) => i.kind === 'animation-ends-early');
    expect(anim).toMatchObject({ layer: 'หัวข้อ', frame: 25 }); // the marker at 3.9 s is not animation
    expect(result.data.issues.find((i: { kind: string }) => i.kind === 'background-ends-early')).toMatchObject({ layer: 'BG', frame: 75 });
    expect(result.data.issues.find((i: { kind: string }) => i.kind === 'thai-animator')).toMatchObject({ basedOn: 'words' });
    const noRules = await run('lintComp', [], true, ANALYSIS_HOST);
    expect(noRules.result.data.issues.map((i: { kind: string }) => i.kind)).not.toContain('thai-size');
  });
  it('lintComp: a time expression keeps a layer moving; English text with a word animator is fine', async () => {
    const extra = ANALYSIS_HOST + `
      titleDoc.text = 'Hello world';
      title.property('ADBE Transform Group').property('ADBE Opacity').expressionEnabled = true;
      title.property('ADBE Transform Group').property('ADBE Opacity').expression = 'wiggle(2, 10)';
    `;
    const { result } = await run('lintComp', [], true, extra);
    const kinds = result.data.issues.map((i: { kind: string }) => i.kind);
    expect(kinds).not.toContain('animation-ends-early');
    expect(kinds).not.toContain('thai-animator');
    expect(kinds).toContain('background-ends-early');
  });
  it('listFonts collects text fonts and the AE missing list; purge needs no project', async () => {
    const { result } = await run('listFonts', [], true, ANALYSIS_HOST);
    expect(result.data).toEqual({ fonts: ['Kanit-Bold'], families: ['Kanit'], aeMissing: ['Kanit-Bold'] });
    const purge = await run('purge', [], true, ANALYSIS_HOST);
    expect(purge.result).toMatchObject({ ok: true, data: { purged: 'ALL_CACHES' } });
    expect(purge.context.purgedWith).toBe('all');
    expect(purge.context.opened).toBe(0);
    expect(purge.context.quit).toBe(1);
  });
  it('stays ASCII-only so $.evalFile cannot mis-decode it', () => {
    expect(/[^\x00-\x7f]/.test(runner)).toBe(false);
  });
});
