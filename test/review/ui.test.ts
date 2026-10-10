import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { INTENT_COLORS } from '../../src/review/session.js';

const source = await readFile(new URL('../../web/review/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../../web/review/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../../web/review/style.css', import.meta.url), 'utf8');
const flush = () => new Promise<void>(r => setImmediate(r));
type Element = ReturnType<typeof element>;
function element() {
  const events = new Map<string, (event?: unknown) => unknown>();
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  return {
    children: [] as Element[], textContent: '', value: '', className: '', disabled: false, checked: false,
    hidden: false, tagName: 'BUTTON', dataset: {} as Record<string, string>, attributes,
    style: { props: new Map<string, string>(), setProperty(k: string, v: string) { this.props.set(k, v); } },
    classList: { contains: (s: string) => classes.has(s), toggle(s: string, on: boolean) { if (on) classes.add(s); else classes.delete(s); } },
    onclick: undefined as undefined | (() => unknown), onsubmit: undefined as undefined | ((event: { preventDefault(): void }) => unknown),
    append(...nodes: Element[]) { this.children.push(...nodes); }, replaceChildren() { this.children = []; },
    setAttribute(k: string, v: string) { attributes.set(k, v); }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }), setPointerCapture() {},
    focus() {},
    addEventListener(name: string, fn: (event?: unknown) => unknown) { events.set(name, fn); },
    emit(name: string, event?: unknown) { return events.get(name)?.(event); },
    click() { if (!this.disabled) return this.onclick?.(); },
  };
}
type Draft = { frame: number; in: number; out: number; intent: string; text: string; strokes: unknown[]; editingId?: string };
type PageOpts = { draft?: Draft; notes?: unknown[]; frames?: number; compare?: unknown; history?: unknown; brand?: unknown };
async function page(opts: PageOpts = {}) {
  const elements = new Map<string, Element>();
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id)!; };
  const radios = Object.keys(INTENT_COLORS).map(value => ({ ...element(), value, checked: value === 'text', tagName: 'INPUT' }));
  const video = Object.assign(get('video'), { paused: true, readyState: 4, seeking: false, currentTime: 0, pause() {}, play: async () => {} });
  Object.defineProperty(video, 'currentTime', { get: () => currentTime, set(value: number) { currentTime = value; video.seeking = true; video.emit('seeking'); } });
  let currentTime = 0;
  const videoB = Object.assign(get('video-b'), { paused: true, currentTime: 0, src: '', pause() { this.paused = true; }, play: async function (this: { paused: boolean }) { this.paused = false; } });
  const documentEvents = new Map<string, (event: unknown) => void>();
  const requests: Array<{ route: string; body: Record<string, unknown>; resolve: (data: unknown) => void }> = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const windowEvents = new Map<string, (event: unknown) => void>();
  const frames = opts.frames ?? 25;
  const initial = {
    name: 'test', version: 'v001', intents: INTENT_COLORS,
    plan: { fps: 25, width: 320, height: 180, frames, shots: frames === 25 ? [{ id: 's1', src: 'cam', start: 0, in: 0, dur: 25 }] : [{ id: 's1', src: 'cam', start: 0, in: 0, dur: 25 }, { id: 's2', src: 'cam', start: 25, in: 0, dur: frames - 25 }] },
    session: { revision: 0, status: 'draft', notes: opts.notes ?? [] }, draft: opts.draft ?? null,
    compare: opts.compare ?? { versions: [], previous: null }, history: opts.history ?? null, brand: opts.brand ?? { logo: false },
  };
  runInNewContext(source, {
    document: {
      getElementById: get, title: '', createElement: element, createElementNS: element,
      addEventListener: (name: string, fn: (event: unknown) => void) => documentEvents.set(name, fn),
      querySelector: (selector: string) => selector.includes(':checked') ? radios.find(r => r.checked) : radios.find(r => selector.includes(`value="${r.value}"`)),
      querySelectorAll: (selector: string) => selector === 'input[name="intent"]' ? radios : [...radios, get('note-text'), get('new-note')],
    },
    window: { addEventListener: (name: string, fn: (event: unknown) => void) => windowEvents.set(name, fn) },
    fetch: (route: string, init: { body?: string }) => route === 'data'
      ? Promise.resolve({ ok: true, json: async () => structuredClone(initial) })
      : new Promise(resolve => requests.push({ route, body: init.body ? JSON.parse(init.body) : undefined, resolve: data => resolve({ ok: true, json: async () => data }) })),
    structuredClone, crypto: { randomUUID: () => 'note-1' }, setInterval, clearInterval, location: { reload() {} },
    setTimeout: (fn: () => void) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (id: number) => { timers.delete(id); },
  });
  await flush();
  const decoded = () => { video.seeking = false; video.emit('seeked'); };
  decoded();
  const runTimers = () => { const pending = [...timers.values()]; timers.clear(); for (const fn of pending) fn(); };
  const draw = (from: [number, number], to: [number, number], id = 1) => {
    const svg = get('drawing');
    svg.emit('pointerdown', { button: 0, pointerId: id, clientX: from[0], clientY: from[1] });
    svg.emit('pointermove', { pointerId: id, clientX: (from[0] + to[0]) / 2, clientY: (from[1] + to[1]) / 2 });
    svg.emit('pointerup', { pointerId: id, clientX: to[0], clientY: to[1] });
  };
  const chooseIntent = (value: string) => { for (const r of radios) r.checked = r.value === value; radios.find(r => r.value === value)!.emit('change'); };
  const submitNote = () => get('note-form').onsubmit!({ preventDefault() {} });
  const unload = () => { let prevented = false; windowEvents.get('beforeunload')?.({ preventDefault() { prevented = true; }, returnValue: undefined }); return prevented; };
  const key = (k: string) => documentEvents.get('keydown')?.({ key: k, target: { tagName: 'BODY' }, preventDefault() {} });
  return { get, video, videoB, requests, decoded, runTimers, draw, chooseIntent, submitNote, unload, radios, key };
}

it('blocks annotation and saving until the requested video frame has decoded', async () => {
  const p = await page();
  p.get('pen').click();
  p.get('next').click();
  expect(p.video.seeking).toBe(true);
  expect(p.get('pen').disabled).toBe(true);
  expect(p.get('tool-circle').disabled).toBe(true);
  expect(p.get('add-note').disabled).toBe(true);
  p.get('drawing').emit('pointerdown', { button: 0, pointerId: 1, clientX: 20, clientY: 30 });
  expect(p.get('strokes').children).toHaveLength(0);
  p.get('note-text').value = 'แก้เฟรมนี้';
  p.submitNote();
  await flush(); expect(p.requests).toHaveLength(0);
  p.decoded();
  p.get('drawing').emit('pointerdown', { button: 0, pointerId: 1, clientX: 20, clientY: 30 });
  p.get('drawing').emit('pointermove', { pointerId: 2, clientX: 90, clientY: 90 });
  p.get('drawing').emit('pointerup', { pointerId: 1, clientX: 40, clientY: 50 });
  p.submitNote();
  await flush();
  expect(p.requests[0]?.body).toMatchObject({ notes: [{ frame: 1, strokes: [{ kind: 'free', points: [[0.2, 0.3], [0.4, 0.5]] }] }] });
  p.requests[0]!.resolve({ revision: 1 }); await flush();
});

it('serializes submission after autosave and keeps note edits disabled until submission completes', async () => {
  const p = await page();
  p.get('note-text').value = 'โน้ตแรก';
  p.submitNote();
  await flush();
  expect(p.get('submit').disabled).toBe(true);
  const submitting = p.get('submit').onclick!();
  expect(p.get('add-note').disabled).toBe(true);
  expect(p.get('new-note').disabled).toBe(true);
  p.get('note-text').value = 'ไม่ควรเพิ่มระหว่างส่ง';
  p.submitNote();
  expect(p.requests).toHaveLength(1);
  p.requests[0]!.resolve({ revision: 1 }); await flush();
  expect(p.get('submit').disabled).toBe(true);
  expect(p.requests[1]).toMatchObject({ route: 'submit', body: { revision: 1 } });
  p.requests[1]!.resolve({ session: { revision: 2, status: 'submitted' } });
  await submitting;
  expect(p.get('save-state').textContent).toContain('ส่งรีวิวแล้ว');
  expect(p.get('submit').disabled).toBe(true);
  expect(p.get('add-note').disabled).toBe(false);
});

it('does not submit a new editor draft that has not been added to the notes', async () => {
  const p = await page();
  p.get('note-text').value = 'ยังไม่เพิ่มโน้ต';
  await p.get('submit').onclick!();
  expect(p.requests).toHaveLength(0);
  expect(p.get('error-text').textContent).toContain('ยังมีโน้ต');
});

describe('draft safety', () => {
  it('keeps marks bound to their frame while navigating and saves them on that frame', async () => {
    const p = await page();
    p.get('tool-circle').click();
    p.draw([10, 10], [50, 40]);
    expect(p.get('strokes').children.length).toBeGreaterThan(0);
    p.get('next').click(); p.decoded();
    expect(p.get('strokes').children).toHaveLength(0);
    expect(p.get('mark-away').hidden).toBe(false);
    p.get('play').click();
    p.get('mark-away').click(); p.decoded();
    expect(p.get('strokes').children.length).toBeGreaterThan(0);
    p.get('next').click(); p.decoded();
    p.submitNote(); await flush();
    expect(p.requests[0]?.body).toMatchObject({ notes: [{ frame: 0, strokes: [{ kind: 'circle', points: [[0.1, 0.1], [0.5, 0.4]] }] }] });
  });

  it('asks before replacing marks drawn on another frame', async () => {
    const p = await page();
    p.get('pen').click(); p.draw([10, 10], [30, 30]);
    p.get('next').click(); p.decoded();
    p.get('drawing').emit('pointerdown', { button: 0, pointerId: 3, clientX: 50, clientY: 50 });
    expect(p.get('confirm').hidden).toBe(false);
    p.get('confirm-cancel').click(); await flush();
    p.get('prev').click(); p.decoded();
    expect(p.get('strokes').children.length).toBeGreaterThan(0);
  });

  it('does not wipe typed text or marks when a shot is clicked', async () => {
    const p = await page();
    p.get('note-text').value = 'ยังพิมพ์อยู่';
    p.get('pen').click(); p.draw([10, 10], [30, 30]);
    p.get('shots').children[0]!.click(); p.decoded();
    expect(p.get('note-text').value).toBe('ยังพิมพ์อยู่');
    expect(p.get('strokes').children.length).toBeGreaterThan(0);
  });

  it('asks in-page before discarding a non-empty draft', async () => {
    const p = await page();
    expect(source).not.toMatch(/\b(window\.)?confirm\(/);
    p.get('note-text').value = 'อย่าหาย';
    const cancelled = p.get('new-note').onclick!();
    expect(p.get('confirm').hidden).toBe(false);
    p.get('confirm-cancel').click(); await cancelled;
    expect(p.get('confirm').hidden).toBe(true);
    expect(p.get('note-text').value).toBe('อย่าหาย');
    const accepted = p.get('new-note').onclick!();
    p.get('confirm-ok').click(); await accepted;
    expect(p.get('note-text').value).toBe('');
  });

  it('autosaves the draft after a pause and clears it once the note is added', async () => {
    const p = await page();
    p.get('note-text').value = 'ร่างโน้ต';
    p.get('note-text').emit('input');
    expect(p.requests).toHaveLength(0);
    p.runTimers(); await flush();
    expect(p.requests[0]).toMatchObject({ route: 'draft', body: { draft: { text: 'ร่างโน้ต', frame: 0, in: 0, out: 25, intent: 'text' } } });
    expect(p.unload()).toBe(true);
    p.requests[0]!.resolve({ draft: {} }); await flush();
    p.submitNote(); await flush();
    expect(p.requests[1]?.route).toBe('session');
    p.requests[1]!.resolve({ revision: 1 }); await flush();
    p.runTimers(); await flush();
    expect(p.requests[2]).toMatchObject({ route: 'draft', body: { draft: null } });
    p.requests[2]!.resolve({ draft: null }); await flush();
    expect(p.unload()).toBe(false);
  });

  it('restores a saved draft on reload, including the note being edited', async () => {
    const saved = { id: 'n1', frame: 3, in: 0, out: 10, intent: 'cut', color: INTENT_COLORS.cut, text: 'เดิม', strokes: [], status: 'open' };
    const p = await page({ notes: [saved], draft: { frame: 3, in: 0, out: 10, intent: 'cut', text: 'แก้ต่อ', editingId: 'n1', strokes: [{ kind: 'arrow', points: [[0.1, 0.1], [0.4, 0.4]], intent: 'cut', color: INTENT_COLORS.cut }] } });
    expect(p.get('note-text').value).toBe('แก้ต่อ');
    expect(p.get('add-note').textContent).toBe('บันทึกการแก้');
    expect(p.radios.find(r => r.checked)?.value).toBe('cut');
    p.decoded();
    expect(p.get('strokes').children.length).toBeGreaterThan(0);
    p.submitNote(); await flush();
    expect(p.requests[0]?.body).toMatchObject({ notes: [{ id: 'n1', frame: 3, text: 'แก้ต่อ', strokes: [{ kind: 'arrow' }] }] });
  });
});

describe('pen colour = intent', () => {
  it('colours new marks by the selected intent and saves a mark-only note without text', async () => {
    const p = await page();
    p.chooseIntent('cut');
    expect(p.get('tools').style.props.get('--pen')).toBe(INTENT_COLORS.cut);
    expect(p.get('pen-label').textContent).toBe('ตัด/สั้นลง');
    p.get('tool-circle').click(); p.draw([10, 10], [40, 40]);
    p.chooseIntent('audio');
    p.get('tool-arrow').click(); p.draw([60, 60], [90, 80], 2);
    const marks = p.get('strokes').children.filter(e => e.attributes.get('class') === 'mark');
    expect(marks.map(m => m.attributes.get('stroke'))).toEqual([INTENT_COLORS.cut, INTENT_COLORS.audio]);
    p.submitNote(); await flush();
    expect(p.requests[0]?.body).toMatchObject({ notes: [{ text: '', intent: 'audio', color: INTENT_COLORS.audio, strokes: [
      { kind: 'circle', intent: 'cut', color: INTENT_COLORS.cut }, { kind: 'arrow', intent: 'audio', color: INTENT_COLORS.audio },
    ] }] });
  });

  it('refuses an empty note with neither text nor a mark', async () => {
    const p = await page();
    p.submitNote(); await flush();
    expect(p.requests).toHaveLength(0);
    expect(p.get('error-text').textContent).toContain('อย่างน้อยหนึ่งอย่าง');
  });

  it('keeps chips, legend and toolbar minimal and in sync with the server colours', () => {
    for (const [intent, color] of Object.entries(INTENT_COLORS)) {
      expect(css).toContain(`--c-${intent}: ${color}`);
      expect(html).toContain(`class="intent ${intent}"`);
    }
    for (const label of ['ตัด/สั้นลง', 'ไทม์มิ่ง/ขยับ', 'ข้อความ/กราฟิก', 'สี/แสง', 'เสียง']) expect(html).toContain(label);
    expect(html).toContain('สีปากกา = ประเภทการแก้');
    expect(html.match(/class="tool"/g)).toHaveLength(3);
    expect(html).not.toMatch(/<textarea[^>]*required/);
    expect(css).toContain('button, input, select, textarea { font: inherit; color: inherit; }');
  });
});

it('selects a range by dragging on the timeline bar and snaps to a shot on click', async () => {
  const p = await page({ frames: 100 });
  const bar = p.get('range-bar');
  bar.emit('pointerdown', { button: 0, pointerId: 7, clientX: 40 });
  bar.emit('pointermove', { pointerId: 7, clientX: 60 });
  bar.emit('pointerup', { pointerId: 7, clientX: 60 });
  expect(p.get('range-label').textContent).toContain('21 เฟรม');
  expect(bar.style.props.get('--a')).toBe('0.4');
  expect(bar.style.props.get('--b')).toBe('0.61');
  bar.emit('pointerdown', { button: 0, pointerId: 8, clientX: 10 });
  bar.emit('pointerup', { pointerId: 8, clientX: 10 });
  expect(p.get('range-label').textContent).toContain('25 เฟรม');
});

describe('parked notes (พักไว้ / ยังไม่ต้องแก้)', () => {
  const saved = { id: 'n1', frame: 3, in: 0, out: 10, intent: 'cut', color: INTENT_COLORS.cut, text: 'ยังไม่ต้องแก้', strokes: [], status: 'open' };
  const actions = (p: Awaited<ReturnType<typeof page>>, i = 0) => p.get('note-list').children[i]!.children[1]!.children;
  it('parks a note with one click, keeps it parked while editing, and reports it apart on submit', async () => {
    const p = await page({ notes: [saved] });
    actions(p).find(b => b.textContent.includes('พักไว้'))!.click(); await flush();
    expect(p.requests[0]).toMatchObject({ route: 'session', body: { notes: [{ id: 'n1', status: 'parked' }] } });
    p.requests[0]!.resolve({ revision: 1 }); await flush();
    expect(p.get('note-list').children[0]!.dataset.status).toBe('parked');
    expect(actions(p).some(b => b.textContent.includes('กลับมาแก้'))).toBe(true);
    await p.get('note-list').children[0]!.children[0]!.onclick!(); p.decoded();
    p.get('note-text').value = 'ยังไม่ต้องแก้ · รอลูกค้า';
    p.submitNote(); await flush();
    expect(p.requests[1]?.body).toMatchObject({ notes: [{ id: 'n1', status: 'parked', text: 'ยังไม่ต้องแก้ · รอลูกค้า' }] });
    p.requests[1]!.resolve({ revision: 2 }); await flush();
    const submitting = p.get('submit').onclick!();
    await flush();
    p.requests.at(-1)!.resolve({ session: { revision: 3, status: 'submitted' } });
    await submitting;
    expect(p.get('save-state').textContent).toBe('ส่งรีวิวแล้ว · 0 จุดให้แก้ · 1 พักไว้');
  });
  it('un-parks back to open', async () => {
    const p = await page({ notes: [{ ...saved, status: 'parked' }] });
    actions(p).find(b => b.textContent.includes('กลับมาแก้'))!.click(); await flush();
    expect(p.requests[0]?.body).toMatchObject({ notes: [{ status: 'open' }] });
  });
});

describe('A/B compare', () => {
  const compare = { versions: [{ id: 'v000', createdAt: '', frames: 30 }], previous: 'v000' };
  const info = { version: 'v000', fps: 25, width: 320, height: 180, frames: 30, shots: [{ id: 's1', src: 'cam', start: 5, in: 0, dur: 25 }], method: 'shot', warning: 'ความยาวไม่เท่ากัน', segments: [{ start: 0, dur: 25, toStart: 5, toMin: 5, toMax: 29 }] };
  async function opened(opts: PageOpts = {}) {
    const p = await page({ compare, ...opts });
    p.get('compare-select').onchange!({ target: { value: 'v000' } } as never); await flush();
    expect(p.requests[0]).toMatchObject({ route: 'compare/v000/data' });
    p.requests[0]!.resolve(info); await flush(); p.decoded();
    return p;
  }
  it('offers only versions the server lists and toggles A/B at the mapped frame', async () => {
    expect((await page()).get('compare-picker').hidden).toBe(true);
    const p = await opened();
    expect(p.get('compare-picker').hidden).toBe(false);
    expect(p.get('compare-select').children.map(o => o.value)).toEqual(['v000']);
    expect(p.videoB.src).toBe('compare/v000/media');
    expect(p.get('stage').dataset).toMatchObject({ mode: 'toggle', show: 'b' });
    expect(p.get('compare-warning').hidden).toBe(false);
    expect(p.get('pen').disabled).toBe(true);
    p.get('next').click(); p.decoded();
    expect(p.videoB.currentTime).toBeCloseTo(6 / 25, 3);
    expect(p.get('b-timecode').textContent).toBe('B 00:00:00:06');
    p.key('b');
    expect(p.get('stage').dataset.show).toBe('a');
    expect(p.get('pen').disabled).toBe(false);
    expect(p.get('timecode').textContent).toBe('00:00:00:01');
    p.key('w');
    expect(p.get('stage').dataset.mode).toBe('wipe');
    expect(p.get('wipe').hidden).toBe(false);
    expect(p.get('pen').disabled).toBe(true);
    p.get('wipe').oninput!({ target: { value: '30' } } as never);
    expect(p.get('stage').style.props.get('--wipe')).toBe('0.3');
    p.get('compare-close').click();
    expect(p.get('stage').dataset.mode).toBe('');
    expect(p.get('compare-bar').hidden).toBe(true);
  });
  it('records "prefer this version for this shot" as an other-intent note with revertTo', async () => {
    const p = await opened();
    expect(p.get('prefer').disabled).toBe(false);
    p.get('prefer').click(); await flush();
    expect(p.requests[1]).toMatchObject({ route: 'session', body: { notes: [{ intent: 'other', frame: 0, in: 0, out: 25, status: 'open', revertTo: { version: 'v000', clipId: 's1' } }] } });
    p.requests[1]!.resolve({ revision: 1 }); await flush();
    p.get('prefer').click(); await flush();
    expect((p.requests[2]?.body as { notes: unknown[] }).notes).toHaveLength(1); // same request is replaced, not duplicated
  });
  it('jumps from a resolved note or a previous-version note to the before/after wipe at its frame', async () => {
    const resolved = { id: 'n1', frame: 7, in: 0, out: 10, intent: 'text', color: INTENT_COLORS.text, text: 'แก้แล้ว', strokes: [], status: 'resolved' };
    const history = { version: 'v000', notes: [{ id: 'h1', frame: 12, sourceFrame: 17, intent: 'cut', color: INTENT_COLORS.cut, text: 'เวอร์ชันก่อน', status: 'open' }] };
    const p = await page({ notes: [resolved, { ...resolved, id: 'n2', status: 'open' }], compare, history });
    const buttons = (i: number) => p.get('note-list').children[i]!.children[1]!.children.map(b => b.textContent);
    expect(buttons(0)).toContain('ก่อน/หลัง');
    expect(buttons(1)).not.toContain('ก่อน/หลัง');
    expect(p.get('history').hidden).toBe(false);
    expect(p.get('history-title').textContent).toContain('v000');
    p.get('note-list').children[0]!.children[1]!.children.find(b => b.textContent === 'ก่อน/หลัง')!.click(); await flush();
    p.requests[0]!.resolve(info); await flush(); p.decoded();
    expect(p.get('stage').dataset.mode).toBe('wipe');
    expect(p.get('timecode').textContent).toBe('00:00:00:07');
    p.get('history-list').children[0]!.children[1]!.children[0]!.click(); await flush(); p.decoded();
    expect(p.get('timecode').textContent).toBe('00:00:00:12');
    expect(p.requests).toHaveLength(1); // compare data is cached
  });
  it('shows no before/after jump when there is no earlier version', async () => {
    const p = await page({ notes: [{ id: 'n1', frame: 7, in: 0, out: 10, intent: 'text', text: 'x', strokes: [], status: 'resolved' }] });
    expect(p.get('note-list').children[0]!.children[1]!.children.map(b => b.textContent)).not.toContain('ก่อน/หลัง');
    expect(p.get('history').hidden).toBe(true);
  });
});

describe('CatCut shell', () => {
  it('loads the logo only when the server ships one and collapses the notes panel', async () => {
    const without = await page();
    expect((without.get('logo') as { src?: string }).src).toBeUndefined();
    const p = await page({ brand: { logo: true } });
    expect((p.get('logo') as { src?: string }).src).toBe('logo.svg');
    p.get('logo').emit('load');
    expect(p.get('logo').hidden).toBe(false);
    expect(p.get('brand-mark').hidden).toBe(true);
    p.get('notes-toggle').click();
    expect(p.get('notes-panel').dataset.collapsed).toBe('true');
    expect(p.get('notes-toggle').attributes.get('aria-expanded')).toBe('false');
  });
  it('keeps the minimal, CSP-safe, responsive design contract', () => {
    expect(html).toContain('<span class="wordmark">CatCut</span>');
    expect(html).not.toMatch(/\son[a-z]+=|style=|<script>|src="logo\.svg"/);
    expect(css).toContain('textarea, select, input[type="range"] { font-size: 16px; }');
    expect(css).toContain('font: 14px/1.55 var(--font)');
    expect(css).toMatch(/--font: "Noto Sans Thai", -apple-system/);
    expect(css).toContain('unicode-range: U+0E00-0E7F');
    expect(css).toContain('@media (prefers-color-scheme: light)');
    expect(css).toContain('--accent: #ff8a3d');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('overflow-x: hidden');
    expect(css).toContain('.notes-panel[data-collapsed="true"] .notes-body { display: none; }');
    expect(css).not.toMatch(/@import|url\((?!"fonts\/)/);
  });
});
