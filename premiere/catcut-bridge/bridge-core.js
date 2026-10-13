// CatCut bridge core: runs inside Premiere's CEP (Node enabled), testable in plain Node.
// Queue in an ASCII temp folder (protocol 1):
//   <id>.req.json   written by CatCut (tmp + rename), claimed here by renaming to <id>.work.json
//   <id>.res.json   written here (tmp + rename): {id, ok, data?, error?}
//   bridge.json     heartbeat every 2 s: {protocol, bridge, pid, premiere, project, busy, ts}
// The heartbeat keeps beating while Premiere works on a request (or sits behind a dialog) and then
// names that request in `busy`, so CatCut can tell "busy" from "gone".
// host.jsx is re-evaluated whenever its file changes, so an updated bridge needs no Premiere restart
// (only this file and index.html do).
// One instance serves the queue: a second one (auto + panel, or two Premiere windows) stands by
// until the heartbeat of the first goes stale. Plain ES2017 for older CEP Node runtimes.
'use strict';

var PROTOCOL = 1;
var HEARTBEAT_MS = 2000;
var STALE_MS = 6000;

function createBridge(o) {
  var fs = o.fs, path = o.path, dir = o.dir;
  var now = o.now || function () { return Date.now(); };
  var log = o.log || function () {};
  var pid = o.pid;
  var state = { serving: false, busy: null, pinging: false, premiere: null, project: null, handled: 0, lastError: null, hostMtime: null };
  var timers = [];

  function write(file, obj) {
    var tmp = file + '.' + pid + '.tmp';
    // cleanup tools empty temp folders: recreate the queue instead of going silent
    try { fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8'); } catch (e0) {
      if (!e0 || e0.code !== 'ENOENT') throw e0;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    }
    // Windows refuses the rename while CatCut is reading the target: retry briefly
    for (var i = 0; ; i++) {
      try { fs.renameSync(tmp, file); return; } catch (e) {
        if (i >= 20 || !e || (e.code !== 'EPERM' && e.code !== 'EACCES' && e.code !== 'EBUSY')) throw e;
        var until = Date.now() + 5;
        while (Date.now() < until) { /* spin: renameSync has no async twin here */ }
      }
    }
  }

  function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return null; }
  }

  function alive(otherPid) {
    if (!otherPid || otherPid === pid) return false;
    try { process.kill(otherPid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
  }

  /** Someone else holds a fresh heartbeat: stand by. */
  function otherServing() {
    var hb = readJson(path.join(dir, 'bridge.json'));
    return !!(hb && hb.pid !== pid && now() - hb.ts < STALE_MS && alive(hb.pid));
  }

  /** Changes when host.jsx or host.user.jsx (next to it) changes; null without a host file. */
  function hostMtime() {
    if (!o.hostFile) return null;
    var stamp;
    try { stamp = String(fs.statSync(o.hostFile).mtimeMs); } catch (e) { return null; }
    try { stamp += '/' + fs.statSync(path.join(path.dirname(o.hostFile), 'host.user.jsx')).mtimeMs; } catch (e2) { /* no user file */ }
    return stamp;
  }

  // ExtendScript gets the job as an object literal; U+2028/9 would end the line in ES3.
  function literal(job) {
    return JSON.stringify(job).split('\u2028').join('\\u2028').split('\u2029').join('\\u2029');
  }

  function host(job) {
    var reload = '';
    var m = hostMtime();
    if (m !== null && m !== state.hostMtime) {
      reload = '$.evalFile(new File(' + JSON.stringify(String(o.hostFile).replace(/\\/g, '/')) + '));';
      state.hostMtime = m;
    }
    return o.evalScript(reload + 'catcut_dispatch(' + literal(job) + ')').then(function (raw) {
      var res;
      try { res = JSON.parse(raw); } catch (e) { return { ok: false, error: 'bad reply from Premiere: ' + String(raw).slice(0, 300) }; }
      return res && typeof res === 'object' ? res : { ok: false, error: 'empty reply from Premiere' };
    });
  }

  /** Never throws: a missed beat is retried 2 s later. */
  function beat() {
    try {
      write(path.join(dir, 'bridge.json'), {
        protocol: PROTOCOL, bridge: o.version, pid: pid, premiere: state.premiere, project: state.project,
        busy: state.busy ? { action: state.busy.action, id: state.busy.id, since: state.busy.since } : null, ts: now(),
      });
    } catch (e) { log('heartbeat: ' + e); }
    if (o.onStatus) o.onStatus(state);
  }

  function heartbeat() {
    if (!state.serving && otherServing()) {
      if (o.onStatus) o.onStatus(state);
      return Promise.resolve(false);
    }
    state.serving = true;
    // Never enter Premiere again while it works on a request or a previous ping: keep beating instead.
    if (state.busy || state.pinging) { beat(); return Promise.resolve(true); }
    state.pinging = true;
    return host({ action: 'ping' }).then(function (r) {
      if (r.ok && r.data) { state.premiere = r.data.premiere || null; state.project = r.data.project || null; }
    }, function () { /* keep the last known values */ }).then(function () {
      state.pinging = false;
      beat();
      return true;
    });
  }

  /** Handle at most one request; resolves true when one was handled. */
  function tick() {
    if (!state.serving || state.busy || state.pinging) return Promise.resolve(false);
    var names;
    try { names = fs.readdirSync(dir); } catch (e) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e2) { /* next tick */ }
      return Promise.resolve(false);
    }
    var reqs = names.filter(function (n) { return /^[A-Za-z0-9_-]+\.req\.json$/.test(n); }).sort();
    if (!reqs.length) return Promise.resolve(false);
    var id = reqs[0].replace(/\.req\.json$/, '');
    var work = path.join(dir, id + '.work.json');
    try { fs.renameSync(path.join(dir, reqs[0]), work); } catch (e) { return Promise.resolve(false); } // claimed elsewhere
    var job = readJson(work);
    state.busy = { id: id, action: job && typeof job.action === 'string' ? job.action : '?', since: now() };
    var done = function (res) {
      res.id = id;
      try { write(path.join(dir, id + '.res.json'), res); } catch (e) { log('cannot write result ' + id + ': ' + e); }
      try { fs.unlinkSync(work); } catch (e) { /* gone */ }
      state.busy = null; state.handled++;
      if (!res.ok) state.lastError = res.error;
      try { beat(); } catch (e) { /* next heartbeat */ }
      // Quitting only after the answer is on disk: Premiere may not return from app.quit().
      if (res.ok && res.data && res.data.quitting === true) o.evalScript('app.quit()');
      return true;
    };
    if (!job || typeof job.action !== 'string') return Promise.resolve(done({ ok: false, error: 'unreadable request' }));
    if (job.deadline && now() > job.deadline) return Promise.resolve(done({ ok: false, error: 'request expired before Premiere picked it up' }));
    try { beat(); } catch (e) { /* next heartbeat */ }
    return host({ action: job.action, args: job.args || {} }).then(done, function (e) { return done({ ok: false, error: String(e && e.message || e) }); });
  }

  function start() {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* exists */ }
    // the manifest's ScriptPath already evaluated host.jsx once
    state.hostMtime = hostMtime();
    heartbeat();
    timers.push(setInterval(function () { heartbeat(); }, HEARTBEAT_MS));
    timers.push(setInterval(function () { tick(); }, 150));
  }

  function stop() {
    timers.forEach(clearInterval); timers = [];
    if (state.serving) {
      var hb = readJson(path.join(dir, 'bridge.json'));
      if (hb && hb.pid === pid) { try { fs.unlinkSync(path.join(dir, 'bridge.json')); } catch (e) { /* gone */ } }
    }
    state.serving = false;
  }

  return { start: start, stop: stop, tick: tick, heartbeat: heartbeat, state: state };
}

module.exports = { createBridge: createBridge, PROTOCOL: PROTOCOL, STALE_MS: STALE_MS };
