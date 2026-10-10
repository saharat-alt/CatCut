'use strict';
const $ = id => document.getElementById(id);
const video = $('video');
const svg = $('drawing');
const colors = { cut: '#ff8f89', timing: '#f1cc70', text: '#8cbff4', color: '#91d3aa', audio: '#d5aff1' };
const labels = { cut: 'ตัดออก', timing: 'ไทม์มิ่ง', text: 'ข้อความ', color: 'สี / แสง', audio: 'เสียง' };
let data, session, frame = 0, selection = { in: 0, out: 1 }, strokes = [], editingId;
let reverseTimer, drawingStroke, drawingPointer, conflicted = false, failed = false, saves = Promise.resolve();
let savingCount = 0, submitting = false;

function updateControls() {
  const waitingForFrame = video.seeking || video.readyState < 2 || !data;
  $('add-note').disabled = conflicted || submitting || waitingForFrame;
  $('pen').disabled = waitingForFrame || submitting;
  $('submit').disabled = failed || conflicted || submitting || savingCount > 0 || !session?.notes.length || session.status === 'submitted';
  $('retry').disabled = submitting || savingCount > 0;
  for (const element of document.querySelectorAll('#note-form input, #note-form textarea, #new-note, .note-actions button')) element.disabled = conflicted || submitting;
}

async function api(route, method = 'GET', body) {
  const response = await fetch(route, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok) { const error = new Error(value.error || 'เปิดรีวิวไม่สำเร็จ'); error.status = response.status; throw error; }
  return value;
}
function showError(error, blocking = true) {
  conflicted = error.status === 409;
  if (blocking) failed = true;
  $('error').hidden = false;
  $('error-text').textContent = conflicted ? 'โน้ตเปลี่ยนในอีกหน้าต่าง กรุณาคัดลอกข้อความที่ยังไม่บันทึก แล้วโหลดโน้ตล่าสุด' : error.message;
  $('retry').hidden = conflicted || !session;
  $('reload').hidden = !conflicted;
  if (blocking) $('save-state').textContent = 'ยังบันทึกไม่สำเร็จ';
  updateControls();
}
function tc(f) {
  const fps = Math.round(data.plan.fps);
  const sec = Math.floor(f / fps);
  return [Math.floor(sec / 3600), Math.floor(sec / 60) % 60, sec % 60, f % fps].map(n => String(n).padStart(2, '0')).join(':');
}
function shotAt(f) { return data.plan.shots.find(s => f >= s.start && f < s.start + s.dur); }
function intent() { return document.querySelector('input[name="intent"]:checked').value; }
function updateRange() { $('range-label').textContent = `${tc(selection.in)} → ${tc(selection.out - 1)} · ${selection.out - selection.in} เฟรม`; }
function updateFrame(next) {
  frame = Math.max(0, Math.min(data.plan.frames - 1, next));
  $('timecode').textContent = tc(frame);
  $('frame-label').textContent = `${frame + 1} / ${data.plan.frames} f`;
  $('scrub').value = frame;
  const shot = shotAt(frame);
  $('shot-label').textContent = shot ? `${shot.id} · ${shot.marker || shot.comp || shot.src}` : '—';
  for (const button of $('shots').children) button.setAttribute('aria-pressed', String(button.dataset.shot === shot?.id));
}
function pause() { clearInterval(reverseTimer); reverseTimer = undefined; video.pause(); }
function seek(next, keepDrawing = false) {
  pause();
  if (drawingStroke) { strokes.pop(); drawingStroke = undefined; }
  if (!keepDrawing && next !== frame) { strokes = []; renderStrokes(); }
  updateFrame(next);
  video.currentTime = frame / data.plan.fps + 0.00001;
  updateControls();
}
function play() {
  clearInterval(reverseTimer); reverseTimer = undefined;
  if (frame >= data.plan.frames - 1) seek(0);
  strokes = []; renderStrokes(); setPen(false);
  video.playbackRate = 1;
  void video.play().catch(showError);
}
function backward() {
  pause(); strokes = []; renderStrokes(); setPen(false);
  reverseTimer = setInterval(() => {
    updateFrame(frame - 1); video.currentTime = frame / data.plan.fps + 0.00001;
    if (frame === 0) pause();
  }, 1000 / data.plan.fps);
}
function setPen(active) {
  if (active && (video.seeking || video.readyState < 2 || submitting)) return;
  if (active) pause();
  svg.classList.toggle('active', active);
  $('pen').setAttribute('aria-pressed', String(active));
}
function renderStrokes() {
  $('strokes').replaceChildren();
  svg.style.setProperty('--pen-color', colors[intent()]);
  for (const stroke of strokes) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute('points', stroke.points.map(([x, y]) => `${x * 1000},${y * 1000}`).join(' '));
    $('strokes').append(line);
  }
  $('undo').disabled = $('clear').disabled = !strokes.length;
}
function point(event) {
  const box = svg.getBoundingClientRect();
  return [Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), Math.max(0, Math.min(1, (event.clientY - box.top) / box.height))];
}
svg.addEventListener('pointerdown', event => {
  if (!svg.classList.contains('active') || drawingStroke || strokes.length >= 16 || event.button !== 0 || video.seeking || video.readyState < 2 || submitting) return;
  pause();
  svg.setPointerCapture(event.pointerId);
  drawingStroke = { points: [point(event)] };
  drawingPointer = event.pointerId;
  strokes.push(drawingStroke);
  renderStrokes();
});
svg.addEventListener('pointermove', event => {
  if (!drawingStroke || event.pointerId !== drawingPointer) return;
  const p = point(event);
  if (drawingStroke.points.length < 511) drawingStroke.points.push(p);
  else drawingStroke.points[511] = p;
  renderStrokes();
});
function finishStroke(event) {
  if (!drawingStroke || event.pointerId !== drawingPointer) return;
  if (drawingStroke.points.length < 512) drawingStroke.points.push(point(event));
  else drawingStroke.points[511] = point(event);
  drawingStroke = undefined;
  renderStrokes();
}
svg.addEventListener('pointerup', finishStroke);
svg.addEventListener('pointercancel', event => {
  if (event.pointerId !== drawingPointer) return;
  if (drawingStroke) strokes.pop(); drawingStroke = undefined; renderStrokes();
});
document.querySelectorAll('input[name="intent"]').forEach(input => input.addEventListener('change', renderStrokes));
$('pen').onclick = () => setPen(!svg.classList.contains('active'));
$('undo').onclick = () => { strokes.pop(); renderStrokes(); };
$('clear').onclick = () => { strokes = []; renderStrokes(); };
$('prev').onclick = () => seek(frame - 1);
$('next').onclick = () => seek(frame + 1);
$('play').onclick = () => video.paused && !reverseTimer ? play() : pause();
$('scrub').oninput = event => seek(Number(event.target.value));
video.addEventListener('play', () => { $('play').textContent = 'Ⅱ'; $('play').setAttribute('aria-label', 'หยุดวิดีโอ'); });
video.addEventListener('pause', () => { $('play').textContent = '▶'; $('play').setAttribute('aria-label', 'เล่นวิดีโอ'); });
video.addEventListener('error', () => showError(new Error('เล่นวิดีโอไม่ได้ กรุณาให้ agent สร้าง preview ใหม่')));
video.addEventListener('loadeddata', () => { $('media-loading').hidden = true; updateControls(); });
video.addEventListener('seeking', updateControls);
video.addEventListener('seeked', () => { if (data) updateFrame(Math.floor(video.currentTime * data.plan.fps + 0.001)); updateControls(); });
if ('requestVideoFrameCallback' in video) {
  const onFrame = (_, metadata) => { if (data && !video.paused) updateFrame(Math.floor(metadata.mediaTime * data.plan.fps + 0.001)); video.requestVideoFrameCallback(onFrame); };
  video.requestVideoFrameCallback(onFrame);
} else video.addEventListener('timeupdate', () => { if (data && !video.paused) updateFrame(Math.floor(video.currentTime * data.plan.fps + 0.001)); });
$('mark-in').onclick = () => { selection.in = frame; selection.out = Math.max(selection.out, frame + 1); updateRange(); };
$('mark-out').onclick = () => { selection.out = frame + 1; selection.in = Math.min(selection.in, frame); updateRange(); };
function selectShot(shot) { selection = { in: shot.start, out: shot.start + shot.dur }; seek(shot.start); updateRange(); }
$('whole-shot').onclick = () => selectShot(shotAt(frame));
document.addEventListener('keydown', event => {
  if (!data || event.altKey || event.ctrlKey || event.metaKey || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
  if (event.target.tagName === 'BUTTON' && event.key === ' ') return;
  const handlers = { ArrowLeft: () => seek(frame - 1), ArrowRight: () => seek(frame + 1), ' ': () => $('play').click(), j: backward, k: pause, l: play, i: () => $('mark-in').click(), o: () => $('mark-out').click() };
  const action = handlers[event.key.length === 1 ? event.key.toLowerCase() : event.key];
  if (action) { event.preventDefault(); action(); }
});

function inputNotes(notes) {
  return notes.map(({ id, frame, in: start, out, intent, text, strokes, status }) => ({ id, frame, in: start, out, intent, text, strokes, status }));
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
function newNote() {
  if (submitting) return;
  editingId = undefined; $('note-text').value = ''; strokes = []; renderStrokes();
  $('add-note').textContent = 'เพิ่มโน้ต';
  if (!failed && !conflicted) $('error').hidden = true;
}
$('new-note').onclick = newNote;
$('retry').onclick = queueSave;
$('reload').onclick = () => location.reload();
$('note-form').onsubmit = event => {
  event.preventDefault();
  if (!data || conflicted || submitting || drawingStroke || video.seeking || video.readyState < 2) return;
  if (frame < selection.in || frame >= selection.out) {
    showError(new Error('เฟรมที่วงอยู่นอกช่วงที่เลือก กด “ทั้งช็อต” หรือเลือกช่วงใหม่ก่อนเพิ่มโน้ต'), false); return;
  }
  const text = $('note-text').value.trim();
  if (!text) return;
  if (!editingId && session.notes.length >= 100) { showError(new Error('รีวิวนี้มีครบ 100 โน้ตแล้ว'), false); return; }
  const note = { id: editingId || crypto.randomUUID(), frame, ...selection, intent: intent(), text, strokes: structuredClone(strokes), status: 'open' };
  if (editingId) session.notes = session.notes.map(n => n.id === editingId ? note : n);
  else session.notes.push(note);
  newNote(); renderNotes(); queueSave();
};
function renderNotes() {
  $('note-list').replaceChildren();
  $('note-count').textContent = `${session.notes.length} จุด`;
  if (!session.notes.length) {
    const empty = document.createElement('div'); empty.className = 'empty';
    const strong = document.createElement('strong'); strong.textContent = 'ยังไม่มีจุดแก้';
    const p = document.createElement('p'); p.textContent = 'เลือกช็อต วงบนภาพ แล้วเพิ่มโน้ตแรก';
    empty.append(strong, p); $('note-list').append(empty);
  }
  for (const note of session.notes) {
    const item = document.createElement('article'); item.className = `note ${note.intent} ${note.status}`;
    const location = document.createElement('button'); location.className = 'note-location';
    location.textContent = `${tc(note.frame)} · ${labels[note.intent]} · ${shotAt(note.frame)?.id || ''}`;
    location.onclick = () => {
      editingId = note.id; selection = { in: note.in, out: note.out };
      seek(note.frame, true); strokes = structuredClone(note.strokes);
      document.querySelector(`input[name="intent"][value="${note.intent}"]`).checked = true;
      $('note-text').value = note.text; $('add-note').textContent = 'บันทึกการแก้';
      updateRange(); renderStrokes();
    };
    const text = document.createElement('p'); text.textContent = note.text;
    const actions = document.createElement('div'); actions.className = 'note-actions';
    const resolve = document.createElement('button'); resolve.textContent = note.status === 'resolved' ? '↶ เปิดจุดนี้อีกครั้ง' : '✓ แก้แล้ว';
    resolve.onclick = () => { note.status = note.status === 'resolved' ? 'open' : 'resolved'; renderNotes(); queueSave(); };
    const remove = document.createElement('button'); remove.textContent = 'ลบ'; remove.setAttribute('aria-label', `ลบโน้ตที่ ${tc(note.frame)}`);
    remove.onclick = () => { session.notes = session.notes.filter(n => n.id !== note.id); if (editingId === note.id) newNote(); renderNotes(); queueSave(); };
    actions.append(resolve, remove); item.append(location, text, actions); $('note-list').append(item);
  }
  updateControls();
}
$('submit').onclick = async () => {
  if (submitting || conflicted) return;
  const existing = session.notes.find(n => n.id === editingId);
  const editable = n => JSON.stringify({ frame: n.frame, in: n.in, out: n.out, intent: n.intent, text: n.text.trim(), strokes: n.strokes });
  const draft = { frame, ...selection, intent: intent(), text: $('note-text').value, strokes };
  if (existing ? editable(existing) !== editable(draft) : draft.text.trim() || strokes.length) {
    showError(new Error('ยังมีโน้ตที่ไม่ได้เพิ่มหรือบันทึก กรุณาบันทึกโน้ตก่อนส่งรีวิว'), false); return;
  }
  submitting = true; updateControls();
  try {
    await saves;
    if (failed || conflicted) return;
    const submitted = await api('submit', 'POST', { revision: session.revision });
    session.revision = submitted.session.revision; session.status = 'submitted';
    $('save-state').textContent = 'ส่งรีวิวแล้ว · agent อ่านโน้ตได้';
  } catch (error) { showError(error); }
  finally { submitting = false; updateControls(); }
};

async function load() {
  data = await api('data'); session = data.session;
  document.title = `${data.name} · ${data.version} · EDITMCP`;
  $('project-name').textContent = data.name; $('version').textContent = data.version;
  $('duration').textContent = `${data.plan.shots.length} ช็อต · ${tc(data.plan.frames)}`;
  $('stage').style.setProperty('--aspect', `${data.plan.width} / ${data.plan.height}`);
  $('scrub').max = data.plan.frames - 1;
  for (const shot of data.plan.shots) {
    const button = document.createElement('button'); button.className = 'shot'; button.dataset.shot = shot.id;
    button.style.setProperty('--weight', shot.dur); button.setAttribute('aria-pressed', 'false');
    const label = document.createElement('span'); label.textContent = shot.marker || shot.comp || shot.src;
    const time = document.createElement('small'); time.textContent = `${shot.id} · ${shot.dur} f`;
    button.append(label, time); button.onclick = () => { newNote(); selectShot(shot); }; $('shots').append(button);
  }
  $('qc-summary').textContent = data.qc ? `ผลตรวจ · ${data.qc.issues.length} จุดที่ควรดู` : 'เวอร์ชันนี้ไม่มีผลตรวจอัตโนมัติ';
  for (const issue of data.qc?.issues || []) {
    const li = document.createElement('li');
    const button = document.createElement('button'); button.textContent = `${issue.kind} · ${issue.message}`;
    button.onclick = () => seek(issue.startFrame ?? 0); li.append(button); $('qc-issues').append(li);
  }
  if (data.qc?.contactSheet) { $('contact').src = 'contact'; $('contact').hidden = false; }
  renderNotes(); selectShot(data.plan.shots[0]); renderStrokes();
  video.src = 'media';
  $('workspace').setAttribute('aria-busy', 'false');
  $('save-state').textContent = session.status === 'submitted' ? 'ส่งรีวิวแล้ว · agent อ่านโน้ตได้' : 'บันทึกแล้ว';
  updateControls();
}
void load().catch(showError);
