'use strict';
const $ = id => document.getElementById(id);
const video = $('video');
const videoB = $('video-b');
const stage = $('stage');
const svg = $('drawing');
const rangeBar = $('range-bar');
const labels = { cut: 'ตัด/สั้นลง', timing: 'ไทม์มิ่ง/ขยับ', text: 'ข้อความ/กราฟิก', color: 'สี/แสง', audio: 'เสียง', other: 'อื่น ๆ' };
const statusLabels = { open: 'ต้องแก้', resolved: 'แก้แล้ว', parked: 'พักไว้' };
const tools = [['pen', 'free'], ['tool-circle', 'circle'], ['tool-arrow', 'arrow']];
const DRAFT_DELAY = 800;
let data, session, frame = 0, selection = { in: 0, out: 1 }, strokes = [], editingId, markFrame, tool;
let reverseTimer, drawingStroke, drawingPointer, rangeDrag, conflicted = false, failed = false, saves = Promise.resolve();
let savingCount = 0, submitting = false, confirmResolve;
let draftTimer, draftSaves = Promise.resolve(), draftBusy = 0, draftFailed = false, lastDraft = 'null';
// A/B compare: A = this version (the clock), B = another version shown at the mapped frame.
let compare, compareLoading;
const compareCache = new Map();

function waitingForFrame() { return video.seeking || video.readyState < 2 || !data; }
function drawingBlocked() { return !!compare && (compare.mode === 'wipe' || compare.show === 'b'); }
function updateControls() {
  const waiting = waitingForFrame();
  $('add-note').disabled = conflicted || submitting || waiting;
  for (const [id] of tools) $(id).disabled = waiting || submitting || drawingBlocked();
  $('submit').disabled = failed || conflicted || submitting || savingCount > 0 || !session?.notes.length || session.status === 'submitted';
  $('retry').disabled = submitting || savingCount > 0;
  for (const element of document.querySelectorAll('#note-form input, #note-form textarea, #new-note, .note-actions button')) element.disabled = conflicted || submitting;
  $('prefer').disabled = conflicted || submitting || !preferTarget();
}

async function api(route, method = 'GET', body, keepalive = false) {
  const response = await fetch(route, { method, keepalive, ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok) { const error = new Error(value.error || 'เปิดรีวิวไม่สำเร็จ'); error.status = response.status; throw error; }
  return value;
}
function showError(error, blocking = true) {
  conflicted = error.status === 409;
  if (blocking) failed = true;
  $('error').hidden = false;
  $('error-text').textContent = conflicted ? 'โน้ตเปลี่ยนในอีกหน้าต่าง กด “โหลดโน้ตล่าสุด” โน้ตใหม่จากหน้านี้จะถูกเพิ่มต่อให้' : error.message;
  $('retry').hidden = conflicted || !session || !blocking;
  $('reload').hidden = !conflicted;
  if (blocking) $('save-state').textContent = 'ยังบันทึกไม่สำเร็จ';
  updateControls();
}

// In-page confirm (never window.confirm): resolves true only on the explicit action button.
function askConfirm(message, okLabel) {
  closeConfirm(false);
  $('confirm-text').textContent = message; $('confirm-ok').textContent = okLabel;
  $('confirm').hidden = false; $('confirm-cancel').focus();
  return new Promise(resolve => { confirmResolve = resolve; });
}
function closeConfirm(result) {
  if (!confirmResolve) return;
  const resolve = confirmResolve; confirmResolve = undefined;
  $('confirm').hidden = true; resolve(result);
}
$('confirm-ok').onclick = () => closeConfirm(true);
$('confirm-cancel').onclick = () => closeConfirm(false);

function tc(f) {
  const fps = Math.round(data.plan.fps);
  const sec = Math.floor(f / fps);
  return [Math.floor(sec / 3600), Math.floor(sec / 60) % 60, sec % 60, f % fps].map(n => String(n).padStart(2, '0')).join(':');
}
function shotAt(f) { return data.plan.shots.find(s => f >= s.start && f < s.start + s.dur); }
function intent() { return document.querySelector('input[name="intent"]:checked').value; }
function colorOf(i) { return data?.intents?.[i] || '#c4c4cc'; }
function setIntent(value) {
  const input = document.querySelector(`input[name="intent"][value="${value}"]`);
  if (input) input.checked = true;
  updatePen();
}
function updatePen() {
  $('tools').style.setProperty('--pen', colorOf(intent()));
  $('pen-label').textContent = labels[intent()];
}
function updateRange() {
  $('range-label').textContent = `${tc(selection.in)} → ${tc(selection.out - 1)} · ${selection.out - selection.in} เฟรม`;
  rangeBar.style.setProperty('--a', String(selection.in / data.plan.frames));
  rangeBar.style.setProperty('--b', String(selection.out / data.plan.frames));
  scheduleDraft();
}
function updateFrame(next) {
  frame = Math.max(0, Math.min(data.plan.frames - 1, next));
  $('timecode').textContent = tc(frame);
  $('frame-label').textContent = `${frame + 1} / ${data.plan.frames} f`;
  $('scrub').value = frame;
  const shot = shotAt(frame);
  $('shot-label').textContent = shot ? `${shot.id} · ${shot.marker || shot.comp || shot.src}` : '—';
  for (const button of $('shots').children) button.setAttribute('aria-pressed', String(button.dataset.shot === shot?.id));
  if (compare) { $('b-timecode').textContent = `B ${tc(mapToB(frame))}`; updateControls(); }
  if (strokes.length) renderStrokes();
}
function pause() {
  clearInterval(reverseTimer); reverseTimer = undefined; video.pause();
  if (compare) { videoB.pause(); syncB(); }
}
function cancelDrawing() { if (drawingStroke) { strokes.splice(strokes.indexOf(drawingStroke), 1); drawingStroke = undefined; } }
// Marks stay in the draft, bound to markFrame; navigating only hides them.
function seek(next) {
  pause(); cancelDrawing();
  updateFrame(next);
  video.currentTime = frame / data.plan.fps + 0.00001;
  syncB();
  renderStrokes(); updateControls();
}
function play() {
  clearInterval(reverseTimer); reverseTimer = undefined;
  if (frame >= data.plan.frames - 1) seek(0);
  setTool(undefined);
  video.playbackRate = 1;
  if (compare) { syncB(); void videoB.play().catch(() => {}); }
  void video.play().catch(showError);
}
function backward() {
  pause(); setTool(undefined);
  reverseTimer = setInterval(() => {
    updateFrame(frame - 1); video.currentTime = frame / data.plan.fps + 0.00001; syncB();
    if (frame === 0) pause();
  }, 1000 / data.plan.fps);
}
function setTool(next) {
  if (next && (waitingForFrame() || submitting || drawingBlocked())) return;
  if (next) pause();
  tool = next;
  svg.classList.toggle('active', !!next);
  for (const [id, kind] of tools) $(id).setAttribute('aria-pressed', String(kind === tool));
}

const NS = 'http://www.w3.org/2000/svg';
function shape(stroke, halo) {
  const [[x0, y0], [x1, y1]] = [stroke.points[0], stroke.points[stroke.points.length - 1]];
  let el;
  if (stroke.kind === 'circle') {
    el = document.createElementNS(NS, 'ellipse');
    el.setAttribute('cx', String((x0 + x1) * 500)); el.setAttribute('cy', String((y0 + y1) * 500));
    el.setAttribute('rx', String(Math.abs(x1 - x0) * 500)); el.setAttribute('ry', String(Math.abs(y1 - y0) * 500));
  } else if (stroke.kind === 'arrow') {
    // The viewBox stretches with the video, so build the head in screen pixels to keep it undistorted.
    const box = svg.getBoundingClientRect(), w = box.width || 1, h = box.height || 1;
    const angle = Math.atan2((y1 - y0) * h, (x1 - x0) * w), size = 16;
    const wing = a => `${(x1 + Math.cos(a) * size / w) * 1000},${(y1 + Math.sin(a) * size / h) * 1000}`;
    el = document.createElementNS(NS, 'path');
    el.setAttribute('d', `M${x0 * 1000},${y0 * 1000} L${x1 * 1000},${y1 * 1000} M${wing(angle + Math.PI - 0.5)} L${x1 * 1000},${y1 * 1000} L${wing(angle + Math.PI + 0.5)}`);
  } else {
    el = document.createElementNS(NS, 'polyline');
    el.setAttribute('points', stroke.points.map(([x, y]) => `${x * 1000},${y * 1000}`).join(' '));
  }
  el.setAttribute('class', halo ? 'halo' : 'mark');
  if (!halo) el.setAttribute('stroke', stroke.color || colorOf(stroke.intent));
  return el;
}
function marksVisible() { return markFrame === undefined || markFrame === frame; }
function renderStrokes() {
  const layer = $('strokes');
  layer.replaceChildren();
  const visible = marksVisible();
  if (visible) for (const stroke of strokes) if (stroke.points.length > 1) layer.append(shape(stroke, true), shape(stroke, false));
  $('undo').disabled = $('clear').disabled = !strokes.length || !visible;
  $('mark-away').hidden = visible || !strokes.length;
  if (!visible && strokes.length) $('mark-away').textContent = `↩ เส้นที่วงอยู่ที่ ${tc(markFrame)}`;
}
function point(event) {
  const box = svg.getBoundingClientRect();
  return [Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), Math.max(0, Math.min(1, (event.clientY - box.top) / box.height))];
}
function strokesChanged() {
  if (!strokes.length && !editingId) markFrame = undefined;
  renderStrokes(); scheduleDraft();
}
svg.addEventListener('pointerdown', async event => {
  if (!tool || drawingStroke || event.button !== 0 || waitingForFrame() || submitting || drawingBlocked()) return;
  if (strokes.length && markFrame !== undefined && markFrame !== frame) {
    if (!await askConfirm(`มีเส้นที่วงไว้ที่ ${tc(markFrame)} ล้างเส้นเดิมแล้ววงที่เฟรมนี้แทน?`, 'ล้างแล้ววงที่นี่')) return;
    strokes = []; strokesChanged();
    return;
  }
  if (strokes.length >= 16) { showError(new Error('วงได้สูงสุด 16 เส้นต่อโน้ต'), false); return; }
  pause();
  svg.setPointerCapture(event.pointerId);
  const p = point(event);
  drawingStroke = { kind: tool, points: tool === 'free' ? [p] : [p, p], intent: intent(), color: colorOf(intent()) };
  drawingPointer = event.pointerId;
  markFrame = frame;
  strokes.push(drawingStroke);
  renderStrokes();
});
svg.addEventListener('pointermove', event => {
  if (!drawingStroke || event.pointerId !== drawingPointer) return;
  const p = point(event);
  if (drawingStroke.kind !== 'free') drawingStroke.points[1] = p;
  else if (drawingStroke.points.length < 511) drawingStroke.points.push(p);
  else drawingStroke.points[511] = p;
  renderStrokes();
});
function finishStroke(event) {
  if (!drawingStroke || event.pointerId !== drawingPointer) return;
  const p = point(event), s = drawingStroke;
  if (s.kind !== 'free') s.points[1] = p;
  else if (s.points.length < 512) s.points.push(p);
  else s.points[511] = p;
  drawingStroke = undefined;
  const [[x0, y0], [x1, y1]] = [s.points[0], s.points[s.points.length - 1]];
  if (s.kind !== 'free' && Math.abs(x1 - x0) < 0.01 && Math.abs(y1 - y0) < 0.01) strokes.splice(strokes.indexOf(s), 1); // a click, not a mark
  strokesChanged();
}
svg.addEventListener('pointerup', finishStroke);
svg.addEventListener('pointercancel', event => {
  if (event.pointerId !== drawingPointer) return;
  cancelDrawing(); strokesChanged();
});
window.addEventListener('resize', renderStrokes);
document.querySelectorAll('input[name="intent"]').forEach(input => input.addEventListener('change', () => { updatePen(); scheduleDraft(); }));
for (const [id, kind] of tools) $(id).onclick = () => setTool(tool === kind ? undefined : kind);
$('undo').onclick = () => { strokes.pop(); strokesChanged(); };
$('clear').onclick = () => { strokes = []; strokesChanged(); };
$('mark-away').onclick = () => seek(markFrame);
$('prev').onclick = () => seek(frame - 1);
$('next').onclick = () => seek(frame + 1);
$('play').onclick = () => video.paused && !reverseTimer ? play() : pause();
$('scrub').oninput = event => seek(Number(event.target.value));
$('note-text').addEventListener('input', scheduleDraft);
video.addEventListener('play', () => { $('play').dataset.playing = 'true'; $('play').setAttribute('aria-label', 'หยุดวิดีโอ'); });
video.addEventListener('pause', () => { $('play').dataset.playing = 'false'; $('play').setAttribute('aria-label', 'เล่นวิดีโอ'); });
video.addEventListener('error', () => showError(new Error('เล่นวิดีโอไม่ได้ กรุณาให้ agent สร้าง preview ใหม่')));
video.addEventListener('loadeddata', () => { $('media-loading').hidden = true; updateControls(); });
video.addEventListener('seeking', updateControls);
video.addEventListener('seeked', () => { if (data) updateFrame(Math.floor(video.currentTime * data.plan.fps + 0.001)); renderStrokes(); updateControls(); });
videoB.addEventListener('error', () => { if (compare) showError(new Error('เปิดวิดีโอของเวอร์ชันที่เทียบไม่ได้'), false); });
function playingFrame(time) {
  if (!data || video.paused) return;
  updateFrame(Math.floor(time * data.plan.fps + 0.001));
  // Keep B within a few frames of A while both play; a seek every frame would stutter.
  if (compare && Math.abs(videoB.currentTime * data.plan.fps - mapToB(frame)) > 3) syncB();
}
if ('requestVideoFrameCallback' in video) {
  const onFrame = (_, metadata) => { playingFrame(metadata.mediaTime); video.requestVideoFrameCallback(onFrame); };
  video.requestVideoFrameCallback(onFrame);
} else video.addEventListener('timeupdate', () => playingFrame(video.currentTime));

$('mark-in').onclick = () => { selection.in = frame; selection.out = Math.max(selection.out, frame + 1); updateRange(); };
$('mark-out').onclick = () => { selection.out = frame + 1; selection.in = Math.min(selection.in, frame); updateRange(); };
function selectShot(shot) { if (!shot) return; selection = { in: shot.start, out: shot.start + shot.dur }; seek(shot.start); updateRange(); }
$('whole-shot').onclick = () => selectShot(shotAt(frame));
// Timeline bar: drag selects a range, a plain click snaps to the shot under the pointer.
function barFrame(event) {
  const box = rangeBar.getBoundingClientRect();
  return Math.max(0, Math.min(data.plan.frames - 1, Math.floor((event.clientX - box.left) / box.width * data.plan.frames)));
}
rangeBar.addEventListener('pointerdown', event => {
  if (!data || event.button !== 0 || submitting) return;
  rangeBar.setPointerCapture(event.pointerId);
  rangeDrag = { id: event.pointerId, start: barFrame(event), x: event.clientX, moved: false };
});
rangeBar.addEventListener('pointermove', event => {
  if (!rangeDrag || event.pointerId !== rangeDrag.id) return;
  if (!rangeDrag.moved && Math.abs(event.clientX - rangeDrag.x) < 4) return;
  rangeDrag.moved = true;
  const f = barFrame(event);
  selection = { in: Math.min(rangeDrag.start, f), out: Math.max(rangeDrag.start, f) + 1 };
  updateRange();
});
rangeBar.addEventListener('pointerup', event => {
  if (!rangeDrag || event.pointerId !== rangeDrag.id) return;
  const drag = rangeDrag; rangeDrag = undefined;
  if (!drag.moved) { selectShot(shotAt(barFrame(event))); return; }
  const inside = f => f !== undefined && f >= selection.in && f < selection.out;
  if (inside(markFrame)) { if (frame !== markFrame) seek(markFrame); }
  else if (!inside(frame)) seek(selection.in);
});
rangeBar.addEventListener('pointercancel', () => { rangeDrag = undefined; });

// ----- A/B compare -----
function mapToB(f) {
  if (!compare) return f;
  const segs = compare.data.segments;
  const seg = segs.find(s => f >= s.start && f < s.start + s.dur) || segs[segs.length - 1];
  return seg ? Math.max(seg.toMin, Math.min(seg.toMax, seg.toStart + f - seg.start)) : 0;
}
function syncB() {
  if (!compare) return;
  const b = mapToB(frame);
  videoB.currentTime = b / data.plan.fps + 0.00001;
  $('b-timecode').textContent = `B ${tc(b)}`;
}
/** The shot under the playhead, when the compared version has a shot with the same id. */
function preferTarget() {
  if (!compare || !data) return undefined;
  const shot = shotAt(frame);
  return shot && compare.data.shots.some(s => s.id === shot.id) ? shot : undefined;
}
function applyCompare() {
  stage.dataset.mode = compare ? compare.mode : '';
  stage.dataset.show = compare ? compare.show : 'a';
  $('compare-bar').hidden = !compare;
  $('tag-a').hidden = $('tag-b').hidden = !compare;
  $('wipe').hidden = !compare || compare.mode !== 'wipe';
  if (compare) {
    stage.style.setProperty('--wipe', String(compare.wipe));
    const showing = compare.mode === 'wipe' ? 'แบ่งจอ' : compare.show === 'b' ? `กำลังดู B · ${compare.id}` : `กำลังดู A · ${data.version}`;
    $('ab-toggle').textContent = compare.mode === 'wipe' ? 'A/B' : showing;
    $('ab-toggle').setAttribute('aria-pressed', String(compare.mode === 'toggle' && compare.show === 'b'));
    $('ab-wipe').setAttribute('aria-pressed', String(compare.mode === 'wipe'));
    $('tag-a').textContent = `A · ${data.version}`; $('tag-b').textContent = `B · ${compare.id}`;
    $('tag-a').hidden = compare.mode === 'toggle' && compare.show === 'b';
    $('tag-b').hidden = compare.mode === 'toggle' && compare.show === 'a';
    $('compare-warning').hidden = !compare.data.warning;
    $('compare-warning').textContent = compare.data.warning || '';
    $('prefer').textContent = `ใช้ช็อตนี้จาก ${compare.id}`;
    $('compare-select').value = compare.id;
  } else $('compare-select').value = '';
  if (drawingBlocked()) setTool(undefined);
  updateControls();
}
async function openCompare(id, { at, mode = 'toggle', show = 'b' } = {}) {
  if (!data || !id) return;
  const token = compareLoading = Symbol(id);
  try {
    let info = compareCache.get(id);
    if (!info) { info = await api(`compare/${id}/data`); compareCache.set(id, info); }
    if (compareLoading !== token) return;
    if (compare?.id !== id) videoB.src = `compare/${id}/media`;
    compare = { id, data: info, mode, show, wipe: compare?.wipe ?? 0.5 };
    setTool(undefined);
    applyCompare();
    seek(at ?? frame);
  } catch (error) { showError(error, false); }
}
function closeCompare() {
  compareLoading = undefined;
  if (!compare) return;
  videoB.pause();
  compare = undefined;
  applyCompare();
}
function toggleAB() {
  if (!compare) { const id = data?.compare?.previous || data?.compare?.versions.at(-1)?.id; if (id) void openCompare(id); return; }
  compare.show = compare.mode === 'wipe' ? 'b' : compare.show === 'b' ? 'a' : 'b';
  compare.mode = 'toggle';
  applyCompare();
}
function toggleWipe() {
  if (!compare) return;
  compare.mode = compare.mode === 'wipe' ? 'toggle' : 'wipe';
  applyCompare();
}
$('compare-select').onchange = event => { const id = event.target.value; if (id) void openCompare(id); else closeCompare(); };
$('ab-toggle').onclick = toggleAB;
$('ab-wipe').onclick = toggleWipe;
$('compare-close').onclick = closeCompare;
$('wipe').oninput = event => { if (!compare) return; compare.wipe = Math.max(0, Math.min(1, Number(event.target.value) / 100)); stage.style.setProperty('--wipe', String(compare.wipe)); };
// "อันก่อนสวยกว่า": record a request to bring this shot back from the compared version (the agent runs shot_revert).
$('prefer').onclick = () => {
  const shot = preferTarget();
  if (!shot || conflicted || submitting) return;
  const revertTo = { version: compare.id, clipId: shot.id };
  const existing = session.notes.find(n => n.revertTo && n.revertTo.version === revertTo.version && n.revertTo.clipId === revertTo.clipId);
  const note = { id: existing?.id || crypto.randomUUID(), frame, in: shot.start, out: shot.start + shot.dur, intent: 'other', color: colorOf('other'),
    text: `ใช้ช็อต ${shot.id} จาก ${compare.id} (ชอบเวอร์ชันนั้นมากกว่า)`, strokes: [], status: 'open', revertTo };
  if (!existing && session.notes.length >= 100) { showError(new Error('รีวิวนี้มีครบ 100 โน้ตแล้ว'), false); return; }
  session.notes = existing ? session.notes.map(n => n === existing ? note : n) : [...session.notes, note];
  renderNotes(); queueSave();
  setDraftState(`บันทึกคำขอ: ใช้ช็อต ${shot.id} จาก ${compare.id}`);
};

document.addEventListener('keydown', event => {
  if (confirmResolve) { if (event.key === 'Escape') { event.preventDefault(); closeConfirm(false); } return; }
  if (!data || event.altKey || event.ctrlKey || event.metaKey || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
  if (event.target.tagName === 'BUTTON' && event.key === ' ') return;
  const intents = Object.keys(labels);
  const handlers = {
    ArrowLeft: () => seek(frame - 1), ArrowRight: () => seek(frame + 1), ' ': () => $('play').click(), j: backward, k: pause, l: play,
    i: () => $('mark-in').click(), o: () => $('mark-out').click(),
    p: () => $('pen').click(), c: () => $('tool-circle').click(), a: () => $('tool-arrow').click(), Escape: () => setTool(undefined),
    b: toggleAB, w: toggleWipe,
  };
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const action = handlers[key] || (/^[1-6]$/.test(key) ? () => { setIntent(intents[Number(key) - 1]); scheduleDraft(); } : undefined);
  if (action) { event.preventDefault(); action(); }
});

function cleanStrokes(list) {
  return list.filter(s => s !== drawingStroke && s.points.length > 1)
    .map(s => ({ kind: s.kind || 'free', points: s.points.map(([x, y]) => [x, y]), intent: s.intent || intent(), color: s.color || colorOf(s.intent || intent()) }));
}
function inputNotes(notes) {
  return notes.map(({ id, frame, in: start, out, intent, color, text, strokes, status, revertTo }) =>
    ({ id, frame, in: start, out, intent, color, text, strokes: cleanStrokes(strokes), status, ...(revertTo ? { revertTo: { version: revertTo.version, clipId: revertTo.clipId } } : {}) }));
}
function queueSave() {
  if (submitting || conflicted) return;
  const notes = inputNotes(structuredClone(session.notes));
  savingCount++;
  session.status = 'draft';
  $('save-state').textContent = 'กำลังบันทึก…';
  updateControls();
  saves = saves.then(async () => {
    try {
      if (conflicted) return;
      const saved = await api('session', 'PUT', { revision: session.revision, notes });
      session.revision = saved.revision;
      failed = false; $('error').hidden = true;
      $('save-state').textContent = 'บันทึกแล้ว';
    } catch (error) { showError(error); }
    finally { savingCount--; updateControls(); }
  });
}

// ----- draft: what is in the editor but not yet a note -----
function noteFrame() { return markFrame ?? frame; }
function comparable(n) {
  return JSON.stringify({ frame: n.frame, in: n.in, out: n.out, intent: n.intent, text: n.text.trim(), strokes: n.strokes.map(s => [s.kind || 'free', s.intent || n.intent, s.points]) });
}
function currentDraft() {
  return { frame: noteFrame(), ...selection, intent: intent(), text: $('note-text').value, strokes: cleanStrokes(strokes) };
}
function draftDirty() {
  if (!data) return false;
  const draft = currentDraft();
  const existing = editingId && session.notes.find(n => n.id === editingId);
  if (existing) return comparable(existing) !== comparable(draft);
  return !!draft.text.trim() || draft.strokes.length > 0;
}
function draftPayload() {
  return draftDirty() ? { ...currentDraft(), ...(editingId ? { editingId } : {}) } : null;
}
function setDraftState(text) { $('draft-state').textContent = text; }
function scheduleDraft() {
  if (!data) return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDraft, DRAFT_DELAY);
}
function flushDraft(keepalive = false) {
  clearTimeout(draftTimer); draftTimer = undefined;
  const draft = draftPayload(), body = JSON.stringify(draft);
  if (body === lastDraft && !draftFailed) return draftSaves;
  draftBusy++;
  setDraftState('กำลังเก็บร่าง…');
  draftSaves = draftSaves.then(async () => {
    try {
      await api('draft', 'PUT', { draft }, keepalive);
      lastDraft = body; draftFailed = false;
      setDraftState(draft ? 'เก็บร่างไว้แล้ว · กดเพิ่มโน้ตเพื่อให้ agent เห็น' : 'โน้ตทุกจุดบันทึกแล้ว');
    } catch {
      draftFailed = true;
      setDraftState('เก็บร่างไม่สำเร็จ · อย่าเพิ่งปิดหน้านี้');
    } finally { draftBusy--; }
  });
  return draftSaves;
}
function hasUnsaved() {
  return savingCount > 0 || failed || draftTimer !== undefined || draftBusy > 0 || draftFailed || draftDirty();
}
window.addEventListener('beforeunload', event => {
  if (!hasUnsaved()) return;
  event.preventDefault(); event.returnValue = '';
});
window.addEventListener('pagehide', () => { if (draftTimer !== undefined) void flushDraft(true); });

function newNote() {
  if (submitting) return;
  editingId = undefined; markFrame = undefined; $('note-text').value = ''; strokes = []; renderStrokes();
  $('add-note').textContent = 'เพิ่มโน้ต';
  if (!failed && !conflicted) $('error').hidden = true;
  scheduleDraft();
}
async function confirmDiscard() {
  return !draftDirty() || askConfirm('ร่างโน้ตนี้ยังไม่ได้เพิ่ม ถ้าเปลี่ยนตอนนี้ข้อความและเส้นที่วงจะหายไป', 'ทิ้งร่างนี้');
}
function openNote(note) {
  editingId = note.id; selection = { in: note.in, out: note.out };
  strokes = structuredClone(note.strokes); markFrame = note.frame;
  setIntent(note.intent);
  $('note-text').value = note.text; $('add-note').textContent = 'บันทึกการแก้';
  seek(note.frame); updateRange();
}
$('new-note').onclick = async () => { if (await confirmDiscard()) newNote(); };
$('retry').onclick = queueSave;
// Conflict: take the other window's notes and re-add the notes only this window created (by id).
$('reload').onclick = async () => {
  try {
    await flushDraft();
    const fresh = await api('data');
    const known = new Set(fresh.session.notes.map(n => n.id));
    const mine = session.notes.filter(n => !known.has(n.id));
    session = fresh.session; conflicted = false; failed = false; $('error').hidden = true;
    session.notes.push(...mine.slice(0, Math.max(0, 100 - session.notes.length)));
    if (editingId && !session.notes.some(n => n.id === editingId)) editingId = undefined;
    renderNotes();
    if (mine.length) queueSave(); else $('save-state').textContent = 'บันทึกแล้ว';
  } catch (error) { showError(error); }
};
$('note-form').onsubmit = event => {
  event.preventDefault();
  if (!data || conflicted || submitting || drawingStroke || waitingForFrame()) return;
  const text = $('note-text').value.trim();
  if (!text && !strokes.length) { showError(new Error('วงบนภาพหรือพิมพ์โน้ตอย่างน้อยหนึ่งอย่าง'), false); return; }
  const at = noteFrame();
  if (at < selection.in || at >= selection.out) {
    showError(new Error(strokes.length ? `เส้นที่วงอยู่ที่ ${tc(at)} นอกช่วงที่เลือก กด “ทั้งช็อต” หรือเลือกช่วงใหม่` : 'เฟรมนี้อยู่นอกช่วงที่เลือก กด “ทั้งช็อต” หรือเลือกช่วงใหม่ก่อนเพิ่มโน้ต'), false); return;
  }
  if (!editingId && session.notes.length >= 100) { showError(new Error('รีวิวนี้มีครบ 100 โน้ตแล้ว'), false); return; }
  const i = intent();
  const previous = editingId && session.notes.find(n => n.id === editingId);
  // Editing keeps the note's status (a parked note stays parked) and drops a revert request only if the intent changed.
  const note = { id: editingId || crypto.randomUUID(), frame: at, ...selection, intent: i, color: colorOf(i), text, strokes: cleanStrokes(strokes), status: previous?.status || 'open',
    ...(previous?.revertTo && i === 'other' ? { revertTo: previous.revertTo } : {}) };
  if (previous) session.notes = session.notes.map(n => n.id === editingId ? note : n);
  else session.notes.push(note);
  newNote(); renderNotes(); queueSave();
};

function setStatus(note, status) {
  note.status = status;
  renderNotes(); queueSave();
}
function action(label, onclick, aria) {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.onclick = onclick;
  if (aria) button.setAttribute('aria-label', aria);
  return button;
}
function noteRow(note) {
  const item = document.createElement('article'); item.className = `note ${note.intent} ${note.status}`;
  item.dataset.status = note.status;
  item.style.setProperty('--intent', note.color || colorOf(note.intent));
  const row = document.createElement('button'); row.className = 'note-row'; row.type = 'button';
  const status = document.createElement('span'); status.className = 'status-dot'; status.setAttribute('title', statusLabels[note.status] || note.status);
  const time = document.createElement('span'); time.className = 'tc'; time.textContent = tc(note.frame);
  const dot = document.createElement('span'); dot.className = 'intent-dot'; dot.setAttribute('title', labels[note.intent] || note.intent);
  const text = document.createElement('span'); text.className = note.text ? 'note-text' : 'note-text muted';
  const marks = note.strokes?.length ? ` · วง ${note.strokes.length}` : '';
  text.textContent = (note.text || 'วงไว้บนภาพ') + marks;
  row.append(status, time, dot, text);
  if (note.revertTo) { const tag = document.createElement('span'); tag.className = 'note-tag'; tag.textContent = `↩ ${note.revertTo.version}`; row.append(tag); }
  if (note.status === 'parked') { const tag = document.createElement('span'); tag.className = 'note-tag'; tag.textContent = 'พักไว้'; row.append(tag); }
  const shot = shotAt(note.frame);
  if (shot && !note.revertTo) { const tag = document.createElement('span'); tag.className = 'note-tag'; tag.textContent = shot.id; row.append(tag); }
  row.setAttribute('aria-label', `${tc(note.frame)} · ${labels[note.intent] || note.intent} · ${statusLabels[note.status] || note.status} · ${note.text || 'วงไว้บนภาพ'}`);
  item.append(row);
  return { item, row };
}
function renderNotes() {
  $('note-list').replaceChildren();
  $('note-count').textContent = String(session.notes.length);
  if (!session.notes.length) {
    const empty = document.createElement('div'); empty.className = 'empty';
    const strong = document.createElement('strong'); strong.textContent = 'ยังไม่มีจุดแก้';
    const p = document.createElement('p'); p.textContent = 'เลือกสี วงบนภาพ แล้วกดเพิ่มโน้ต';
    empty.append(strong, p); $('note-list').append(empty);
  }
  const previous = data?.compare?.previous;
  for (const note of session.notes) {
    const { item, row } = noteRow(note);
    row.onclick = async () => { if (note.id === editingId || await confirmDiscard()) openNote(note); };
    const actions = document.createElement('div'); actions.className = 'note-actions';
    actions.append(action(note.status === 'resolved' ? '↶ เปิดอีกครั้ง' : '✓ แก้แล้ว', () => setStatus(note, note.status === 'resolved' ? 'open' : 'resolved')));
    actions.append(action(note.status === 'parked' ? '↶ กลับมาแก้' : '⏸ พักไว้', () => setStatus(note, note.status === 'parked' ? 'open' : 'parked'),
      note.status === 'parked' ? `เอาโน้ตที่ ${tc(note.frame)} กลับมาแก้` : `พักโน้ตที่ ${tc(note.frame)} ไว้ ยังไม่ต้องแก้`));
    if (note.status === 'resolved' && previous) actions.append(action('ก่อน/หลัง', () => openCompare(previous, { at: note.frame, mode: 'wipe' }), `เทียบก่อน/หลังที่ ${tc(note.frame)} กับ ${previous}`));
    actions.append(action('ลบ', async () => {
      if (!await askConfirm(`ลบโน้ตที่ ${tc(note.frame)}?`, 'ลบโน้ต')) return;
      session.notes = session.notes.filter(n => n.id !== note.id);
      if (editingId === note.id) newNote();
      renderNotes(); queueSave();
    }, `ลบโน้ตที่ ${tc(note.frame)}`));
    item.append(actions); $('note-list').append(item);
  }
  updateControls();
}
/** Notes from the previous version, placed on this version's frames, each with a ก่อน/หลัง jump. */
function renderHistory() {
  const h = data.history;
  $('history').hidden = !h?.notes?.length;
  if (!h?.notes?.length) return;
  $('history-title').textContent = `จากเวอร์ชันก่อน · ${h.version} (${h.notes.length})`;
  $('history-list').replaceChildren();
  for (const note of h.notes) {
    const { item, row } = noteRow(note);
    row.onclick = () => seek(note.frame);
    const actions = document.createElement('div'); actions.className = 'note-actions history-actions';
    actions.append(action('ก่อน/หลัง', () => openCompare(h.version, { at: note.frame, mode: 'wipe' }), `เทียบก่อน/หลังที่ ${tc(note.frame)} กับ ${h.version}`));
    item.append(actions); $('history-list').append(item);
  }
}
$('notes-toggle').onclick = () => {
  const collapsed = $('notes-panel').dataset.collapsed !== 'true';
  $('notes-panel').dataset.collapsed = String(collapsed);
  $('notes-toggle').setAttribute('aria-expanded', String(!collapsed));
  $('notes-toggle').textContent = collapsed ? 'แสดง' : 'ซ่อน';
};
function submittedState(s) {
  const open = s.notes.filter(n => n.status === 'open').length, parked = s.notes.filter(n => n.status === 'parked').length;
  return `ส่งรีวิวแล้ว · ${open} จุดให้แก้${parked ? ` · ${parked} พักไว้` : ''}`;
}
$('submit').onclick = async () => {
  if (submitting || conflicted) return;
  if (draftDirty()) { showError(new Error('ยังมีโน้ตที่ไม่ได้เพิ่มหรือบันทึก กรุณาบันทึกโน้ตก่อนส่งรีวิว'), false); return; }
  submitting = true; updateControls();
  try {
    await saves;
    if (failed || conflicted) return;
    const submitted = await api('submit', 'POST', { revision: session.revision });
    session.revision = submitted.session.revision; session.status = 'submitted';
    $('save-state').textContent = submittedState(session);
  } catch (error) { showError(error); }
  finally { submitting = false; updateControls(); }
};

function restoreDraft(draft) {
  if (draft.editingId && session.notes.some(n => n.id === draft.editingId)) {
    editingId = draft.editingId; $('add-note').textContent = 'บันทึกการแก้';
  }
  selection = { in: draft.in, out: draft.out };
  strokes = draft.strokes; markFrame = strokes.length || editingId ? draft.frame : undefined;
  setIntent(draft.intent);
  $('note-text').value = draft.text;
  seek(draft.frame); updateRange();
  lastDraft = JSON.stringify(draftPayload());
  setDraftState('กู้ร่างโน้ตที่ยังไม่ได้เพิ่มกลับมาแล้ว');
}
function setupCompare() {
  const versions = data.compare?.versions || [];
  $('compare-picker').hidden = !versions.length;
  for (const v of versions) {
    const option = document.createElement('option'); option.value = v.id;
    option.textContent = `${v.id}${v.id === data.compare.previous ? ' · ก่อนหน้า' : ''}${v.frames !== data.plan.frames ? ' · ความยาวต่าง' : ''}`;
    $('compare-select').append(option);
  }
}
async function load() {
  data = await api('data'); session = data.session;
  document.title = `${data.name} · ${data.version} · CatCut`;
  $('project-name').textContent = data.name; $('version').textContent = data.version;
  if (data.brand?.logo) {
    const logo = $('logo');
    logo.addEventListener('load', () => { logo.hidden = false; $('brand-mark').hidden = true; });
    logo.src = 'logo.svg';
  }
  $('duration').textContent = `${data.plan.shots.length} ช็อต · ${tc(data.plan.frames)}`;
  stage.style.setProperty('--aspect', `${data.plan.width} / ${data.plan.height}`);
  $('scrub').max = data.plan.frames - 1;
  for (const shot of data.plan.shots) {
    const button = document.createElement('button'); button.className = 'shot'; button.dataset.shot = shot.id;
    button.style.setProperty('--weight', shot.dur); button.setAttribute('aria-pressed', 'false');
    const label = document.createElement('span'); label.textContent = shot.marker || shot.comp || shot.src;
    const time = document.createElement('small'); time.textContent = `${shot.id} · ${shot.dur} f`;
    button.append(label, time); button.onclick = () => selectShot(shot); $('shots').append(button);
    if (shot.start > 0) {
      const tick = document.createElement('span'); tick.className = 'range-tick';
      tick.style.setProperty('--x', String(shot.start / data.plan.frames)); $('range-ticks').append(tick);
    }
  }
  $('qc-summary').textContent = data.qc ? `ผลตรวจ · ${data.qc.issues.length} จุดที่ควรดู` : 'เวอร์ชันนี้ไม่มีผลตรวจอัตโนมัติ';
  for (const issue of data.qc?.issues || []) {
    const li = document.createElement('li');
    const button = document.createElement('button'); button.className = 'ghost'; button.textContent = `${issue.kind} · ${issue.message}`;
    button.onclick = () => seek(issue.startFrame ?? 0); li.append(button); $('qc-issues').append(li);
  }
  if (data.qc?.contactSheet) { $('contact').src = 'contact'; $('contact').hidden = false; }
  setupCompare();
  updatePen(); renderNotes(); renderHistory();
  if (data.draft) restoreDraft(data.draft);
  else { selectShot(data.plan.shots[0]); clearTimeout(draftTimer); draftTimer = undefined; }
  renderStrokes();
  video.src = 'media';
  $('workspace').setAttribute('aria-busy', 'false');
  $('save-state').textContent = session.status === 'submitted' ? submittedState(session) : 'บันทึกแล้ว';
  updateControls();
}
void load().catch(showError);
