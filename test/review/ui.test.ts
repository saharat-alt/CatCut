import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

const source = await readFile(new URL('../../web/review/app.js', import.meta.url), 'utf8');
const flush = () => new Promise<void>(r => setImmediate(r));
type Element = ReturnType<typeof element>;
function element() {
  const events = new Map<string, (event?: unknown) => void>();
  const classes = new Set<string>();
  return {
    children: [] as Element[], textContent: '', value: '', className: '', disabled: false, checked: false,
    hidden: false, tagName: 'BUTTON', dataset: {} as Record<string, string>,
    style: { setProperty() {} },
    classList: { contains: (s: string) => classes.has(s), toggle(s: string, on: boolean) { if (on) classes.add(s); else classes.delete(s); } },
    onclick: undefined as undefined | (() => unknown), onsubmit: undefined as undefined | ((event: { preventDefault(): void }) => unknown),
    append(...nodes: Element[]) { this.children.push(...nodes); }, replaceChildren() { this.children = []; },
    setAttribute() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }), setPointerCapture() {},
    addEventListener(name: string, fn: (event?: unknown) => void) { events.set(name, fn); },
    emit(name: string, event?: unknown) { events.get(name)?.(event); },
    click() { if (!this.disabled) return this.onclick?.(); },
  };
}
async function page() {
  const elements = new Map<string, Element>();
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id)!; };
  const radios = ['cut', 'timing', 'text', 'color', 'audio'].map(value => ({ ...element(), value, checked: value === 'text', tagName: 'INPUT' }));
  const video = Object.assign(get('video'), { paused: true, readyState: 4, seeking: false, currentTime: 0, pause() {}, play: async () => {} });
  Object.defineProperty(video, 'currentTime', { get: () => currentTime, set(value: number) { currentTime = value; video.seeking = true; video.emit('seeking'); } });
  let currentTime = 0;
  const requests: Array<{ route: string; body: Record<string, unknown>; resolve: (data: unknown) => void }> = [];
  const initial = { name: 'test', version: 'v001', plan: { fps: 25, width: 320, height: 180, frames: 25, shots: [{ id: 's1', src: 'cam', start: 0, in: 0, dur: 25 }] }, session: { revision: 0, status: 'draft', notes: [] } };
  runInNewContext(source, {
    document: {
      getElementById: get, title: '', createElement: element, createElementNS: element, addEventListener() {},
      querySelector: (selector: string) => selector.includes(':checked') ? radios.find(r => r.checked) : radios.find(r => selector.includes(`value="${r.value}"`)),
      querySelectorAll: (selector: string) => selector === 'input[name="intent"]' ? radios : [...radios, get('note-text'), get('new-note')],
    },
    fetch: (route: string, opts: { body?: string }) => route === 'data'
      ? Promise.resolve({ ok: true, json: async () => structuredClone(initial) })
      : new Promise(resolve => requests.push({ route, body: JSON.parse(opts.body!), resolve: data => resolve({ ok: true, json: async () => data }) })),
    structuredClone, crypto: { randomUUID: () => 'note-1' }, setInterval, clearInterval, location: { reload() {} },
  });
  await flush();
  const decoded = () => { video.seeking = false; video.emit('seeked'); };
  decoded();
  return { get, video, requests, decoded };
}

it('blocks annotation and saving until the requested video frame has decoded', async () => {
  const p = await page();
  p.get('pen').click();
  p.get('next').click();
  expect(p.video.seeking).toBe(true);
  expect(p.get('pen').disabled).toBe(true);
  expect(p.get('add-note').disabled).toBe(true);
  p.get('drawing').emit('pointerdown', { button: 0, pointerId: 1, clientX: 20, clientY: 30 });
  expect(p.get('strokes').children).toHaveLength(0);
  p.get('note-text').value = 'แก้เฟรมนี้';
  p.get('note-form').onsubmit!({ preventDefault() {} });
  await flush(); expect(p.requests).toHaveLength(0);
  p.decoded();
  p.get('drawing').emit('pointerdown', { button: 0, pointerId: 1, clientX: 20, clientY: 30 });
  p.get('drawing').emit('pointermove', { pointerId: 2, clientX: 90, clientY: 90 });
  p.get('drawing').emit('pointerup', { pointerId: 1, clientX: 40, clientY: 50 });
  p.get('note-form').onsubmit!({ preventDefault() {} });
  await flush();
  expect(p.requests[0]?.body).toMatchObject({ notes: [{ frame: 1, strokes: [{ points: [[0.2, 0.3], [0.4, 0.5]] }] }] });
  p.requests[0]!.resolve({ revision: 1 }); await flush();
});

it('serializes submission after autosave and keeps note edits disabled until submission completes', async () => {
  const p = await page();
  p.get('note-text').value = 'โน้ตแรก';
  p.get('note-form').onsubmit!({ preventDefault() {} });
  await flush();
  expect(p.get('submit').disabled).toBe(true);
  const submitting = p.get('submit').onclick!();
  expect(p.get('add-note').disabled).toBe(true);
  expect(p.get('new-note').disabled).toBe(true);
  p.get('note-text').value = 'ไม่ควรเพิ่มระหว่างส่ง';
  p.get('note-form').onsubmit!({ preventDefault() {} });
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
