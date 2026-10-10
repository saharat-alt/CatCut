import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import vm from 'node:vm';

const runner = readFileSync(new URL('../../jsx/runner.jsx', import.meta.url), 'utf8');
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function run(action: string, ops: unknown[] = [], nativeJson = true) {
  const dir = await mkdtemp(join(os.tmpdir(), 'editmcp-jsx-')); dirs.push(dir);
  const aep = join(dir, 'working.aep'), result = join(dir, 'result.json'), job = join(dir, 'job.json');
  await writeFile(aep, 'working');
  await writeFile(job, JSON.stringify({ action, aep, result, comp: 'Title', atFrame: 10, ops }));
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
  `, context);
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
});
