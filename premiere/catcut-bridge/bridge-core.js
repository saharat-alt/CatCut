// CatCut bridge core: runs inside Premiere's CEP (Node enabled), testable in plain Node.
// Queue in an ASCII temp folder (protocol 1):
//   <id>.req.json   written by CatCut (tmp + rename), claimed here by renaming to <id>.work.json
//   <id>.res.json   written here (tmp + rename): {id, ok, data?, error?}
//   bridge.json     heartbeat every 2 s: {protocol, bridge, pid, premiere, project, ts}
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
  var state = { serving: false, busy: false, premiere: null, project: null, handled: 0, lastError: null };
  var timers = [];

  function write(file, obj) {
    var tmp = file + '.' + pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, file);
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

  // ExtendScript gets the job as an object literal; U+2028/9 would end the line in ES3.
  function literal(job) {
    return JSON.stringify(job).split('\u2028').join('\\u2028').split('\u2029').join('\\u2029');
  }

  function host(job) {
    return o.evalScript('catcut_dispatch(' + literal(job) + ')').then(function (raw) {
      var res;
      try { res = JSON.parse(raw); } catch (e) { return { ok: false, error: 'bad reply from Premiere: ' + String(raw).slice(0, 300) }; }
      return res && typeof res === 'object' ? res : { ok: false, error: 'empty reply from Premiere' };
    });
  }

  function heartbeat() {
    if (!state.serving && otherServing()) return Promise.resolve(false);
    state.serving = true;
    return host({ action: 'ping' }).then(function (r) {
      if (r.ok && r.data) { state.premiere = r.data.premiere || null; state.project = r.data.project || null; }
      return r;
    }, function () { return null; }).then(function () {
      write(path.join(dir, 'bridge.json'), { protocol: PROTOCOL, bridge: o.version, pid: pid, premiere: state.premiere, project: state.project, ts: now() });
      if (o.onStatus) o.onStatus(state);
      return true;
    });
  }

  /** Handle at most one request; resolves true when one was handled. */
  function tick() {
    if (!state.serving || state.busy) return Promise.resolve(false);
    var names;
    try { names = fs.readdirSync(dir); } catch (e) { return Promise.resolve(false); }
    var reqs = names.filter(function (n) { return /^[A-Za-z0-9_-]+\.req\.json$/.test(n); }).sort();
    if (!reqs.length) return Promise.resolve(false);
    var id = reqs[0].replace(/\.req\.json$/, '');
    var work = path.join(dir, id + '.work.json');
    try { fs.renameSync(path.join(dir, reqs[0]), work); } catch (e) { return Promise.resolve(false); } // claimed elsewhere
    state.busy = true;
    var job = readJson(work);
    var done = function (res) {
      res.id = id;
      try { write(path.join(dir, id + '.res.json'), res); } catch (e) { log('cannot write result ' + id + ': ' + e); }
      try { fs.unlinkSync(work); } catch (e) { /* gone */ }
      state.busy = false; state.handled++;
      if (!res.ok) state.lastError = res.error;
      if (o.onStatus) o.onStatus(state);
      return true;
    };
    if (!job || typeof job.action !== 'string') return Promise.resolve(done({ ok: false, error: 'unreadable request' }));
    if (job.deadline && now() > job.deadline) return Promise.resolve(done({ ok: false, error: 'request expired before Premiere picked it up' }));
    return host({ action: job.action, args: job.args || {} }).then(done, function (e) { return done({ ok: false, error: String(e && e.message || e) }); });
  }

  function start() {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* exists */ }
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
