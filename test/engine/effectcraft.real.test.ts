// Opt-in: runs the installed effectcraft-cli (set CATCUT_EFFECTCRAFT_IT=1). Never touches After Effects.
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findArtCraft, findFfmpeg } from '../../src/core/tools.js';
import { createEffectCraftBackend } from '../../src/engine/effectcraft.js';
import { probe } from '../../src/engine/ffmpeg.js';

const ec = findArtCraft().effectcraftCli;
const ff = findFfmpeg();
const run = process.env['CATCUT_EFFECTCRAFT_IT'] === '1' && !!ec && !!ff;

// One script for both hosts: match names + new TextDocument (EffectCraft ignores display names).
const JSX = `
var comp = app.project.items.addComp("Title", 640, 360, 1, 2, 25);
comp.layers.addSolid([0.1, 0.1, 0.3], "BG", 640, 360, 1);
var t = comp.layers.addText("สวัสดี");
t.name = "Headline";
var doc = new TextDocument("สวัสดี"); doc.fontSize = 48; doc.fillColor = [1, 1, 1]; doc.applyFill = true;
t.property("ADBE Text Properties").property("ADBE Text Document").setValue(doc);
t.property("ADBE Transform Group").property("ADBE Position").setValueAtTime(0, [320, 200]);
L("layers " + comp.numLayers);
`;

describe.skipIf(!run)('EffectCraft CLI (real, opt-in)', () => {
  it('create → render a range → fingerprint → edit → preview, all through the backend', async () => {
    const tools = { ...ff!, effectcraftCli: ec! };
    const backend = createEffectCraftBackend(tools);
    const dir = await mkdtemp(join(os.tmpdir(), 'catcut-ec-it-'));
    const ecproj = join(dir, 'ไตเติล', 'title.ecproj');
    const created = await backend.create!({ jsx: JSX, saveAs: ecproj });
    expect(created.comps).toEqual([expect.objectContaining({ name: 'Title', durationFrames: 50, width: 640, height: 360 })]);
    expect(created.log).toEqual(['layers 2']);

    const r = await backend.render({ aep: ecproj, comp: 'Title', outPath: join(dir, 'ไตเติล.mov'), startFrame: 10, endFrame: 19 });
    const info = await probe(tools, r.path, { fps: 25 });
    expect(info.durationFrames).toBe(10);
    expect(info.allIntra).toBe(true);

    const fp1 = (await backend.fingerprint(ecproj))['Title'];
    expect((await backend.fingerprint(ecproj))['Title']).toBe(fp1);
    const edited = await backend.edit({ aep: ecproj, comp: 'Title', ops: [{ op: 'setText', layer: 'Headline', text: 'แก้แล้ว' }] });
    expect(edited.fingerprint).not.toBe(fp1);
    const detail = await backend.inspectComp(ecproj, 'Title');
    expect(detail.layers.map((l) => [l.name, l.kind, l.text])).toEqual([['Headline', 'text', 'แก้แล้ว'], ['BG', 'solid', undefined]]);
    expect(detail.fingerprint).toBe(edited.fingerprint);

    const png = await backend.previewFrame(ecproj, 'Title', 25, join(dir, 'f.png'));
    expect(existsSync(png)).toBe(true);
  }, 300_000);
});
