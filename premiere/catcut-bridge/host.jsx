// CatCut bridge, ExtendScript side (ES3, Premiere Pro). bridge-core.js calls catcut_dispatch(job)
// and gets a JSON string back. Only these actions exist. Every action that changes a project names
// it (expectProject) and refuses when another one is active; only save/quit save, and quit only
// after CatCut asked for it. XML paths arrive staged in the bridge's ASCII temp folder; media and
// proxy paths are the original files (never copies).
var catcut_dispatch = (function () {
    function stringify(v) {
        if (v === null || v === undefined) return "null";
        if (typeof v === "string") return '"' + v.replace(/[\\"\x00-\x1f\u2028\u2029]/g, function (c) {
            if (c === '"' || c === "\\") return "\\" + c;
            return "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4);
        }) + '"';
        if (typeof v === "number") return isFinite(v) ? String(v) : "null";
        if (typeof v === "boolean") return String(v);
        var parts = [], i, k;
        if (v instanceof Array) {
            for (i = 0; i < v.length; i++) parts.push(stringify(v[i]));
            return "[" + parts.join(",") + "]";
        }
        for (k in v) if (v.hasOwnProperty(k) && typeof v[k] !== "function") parts.push(stringify(k) + ":" + stringify(v[k]));
        return "{" + parts.join(",") + "}";
    }
    function norm(p) { return String(p).replace(/\//g, "\\").toLowerCase(); }
    function project() {
        var p = app.project;
        return p ? { name: p.name, path: p.path } : null;
    }
    function sequences() {
        var out = [], seqs = app.project.sequences, active = app.project.activeSequence;
        for (var i = 0; i < seqs.numSequences; i++) {
            var s = seqs[i];
            out.push({ name: s.name, id: s.sequenceID, active: !!(active && active.sequenceID === s.sequenceID) });
        }
        return out;
    }
    function findSequence(ref) {
        var seqs = app.project.sequences, hits = [];
        if (ref === undefined || ref === null || ref === "") {
            if (!app.project.activeSequence) throw new Error("no active sequence: open one or pass sequence");
            return app.project.activeSequence;
        }
        for (var i = 0; i < seqs.numSequences; i++) if (seqs[i].sequenceID === ref || seqs[i].name === ref) hits.push(seqs[i]);
        if (hits.length === 0) throw new Error("sequence not found: " + ref);
        if (hits.length > 1) throw new Error("ambiguous sequence name: " + ref + " (pass its id)");
        return hits[0];
    }
    function binNamed(name) {
        var root = app.project.rootItem;
        for (var i = 0; i < root.children.numItems; i++) {
            var c = root.children[i];
            if (c.type === 2 && c.name === name) return c; // ProjectItemType.BIN
        }
        root.createBin(name);
        for (i = 0; i < root.children.numItems; i++) if (root.children[i].type === 2 && root.children[i].name === name) return root.children[i];
        throw new Error("cannot create bin: " + name);
    }
    function requireProject(a) {
        if (!app.project) throw new Error("no project open in Premiere");
        if (a.expectProject && norm(app.project.path) !== norm(a.expectProject)) throw new Error("the active Premiere project is " + app.project.path + ", not " + a.expectProject + "; nothing changed");
    }
    function saveProject() {
        var r = app.project.save();
        if (r === false) throw new Error("Premiere could not save " + app.project.path);
    }
    /** Nested bin by "A/B" path under the project root, created when missing. */
    function binAt(pathText) {
        var parts = String(pathText || "").split("/"), cur = app.project.rootItem, i, j, hit;
        for (i = 0; i < parts.length; i++) {
            if (!parts[i]) continue;
            hit = null;
            for (j = 0; j < cur.children.numItems; j++) if (cur.children[j].type === 2 && cur.children[j].name === parts[i]) hit = cur.children[j];
            if (!hit) {
                cur.createBin(parts[i]);
                for (j = 0; j < cur.children.numItems; j++) if (cur.children[j].type === 2 && cur.children[j].name === parts[i]) hit = cur.children[j];
            }
            if (!hit) throw new Error("cannot create bin: " + parts[i]);
            cur = hit;
        }
        return cur;
    }
    /** The project item whose media is path, searching root and its bins. */
    function findMedia(root, path) {
        for (var i = 0; i < root.children.numItems; i++) {
            var c = root.children[i];
            if (c.type === 2) { var hit = findMedia(c, path); if (hit) return hit; } else if (c.getMediaPath && norm(c.getMediaPath()) === norm(path)) return c;
        }
        return null;
    }
    var INTERP = { "frame-sampling": 0, "frame-blend": 1, "optical-flow": 2 };
    var actions = {
        ping: function () { return { premiere: app.version, project: project() }; },
        openProject: function (a) {
            if (app.project && norm(app.project.path) === norm(a.path)) return { project: project(), opened: false };
            if (!new File(a.path).exists) throw new Error("project not found: " + a.path);
            // suppress conversion dialog, bypass locate-file and warning dialogs, keep the MRU list
            if (!app.openDocument(a.path, true, true, true, true)) throw new Error("Premiere refused to open " + a.path);
            if (!app.project || norm(app.project.path) !== norm(a.path)) throw new Error("opened " + a.path + " but the active project is " + (app.project ? app.project.path : "none"));
            return { project: project(), opened: true };
        },
        save: function (a) {
            requireProject(a);
            saveProject();
            return { project: project(), saved: true };
        },
        quit: function (a) {
            requireProject(a);
            if (a.save !== false) saveProject();
            return { project: project(), saved: a.save !== false, quitting: true };
        },
        importMedia: function (a) {
            requireProject(a);
            var items = a.items || [], byBin = {}, order = [], out = [], i, it, bin, item;
            for (i = 0; i < items.length; i++) {
                it = items[i];
                if (!new File(it.source).exists) { out.push({ source: it.source, error: "source not found" }); continue; }
                if (it.proxy && !new File(it.proxy).exists) { out.push({ source: it.source, error: "proxy not found: " + it.proxy }); continue; }
                if (!byBin.hasOwnProperty(it.bin)) { byBin[it.bin] = []; order.push(it.bin); }
                byBin[it.bin].push(it);
            }
            // import only what the project does not have yet, so a retry after a cancelled import resumes
            for (i = 0; i < order.length; i++) {
                bin = binAt(order[i]);
                var missing = [];
                for (var k = 0; k < byBin[order[i]].length; k++) if (!findMedia(app.project.rootItem, byBin[order[i]][k].source)) missing.push(byBin[order[i]][k].source);
                if (missing.length && !app.project.importFiles(missing, true, bin, false)) throw new Error("Premiere refused to import into " + order[i]);
                for (k = 0; k < byBin[order[i]].length; k++) {
                    it = byBin[order[i]][k];
                    item = findMedia(app.project.rootItem, it.source);
                    var row = { source: it.source, bin: order[i], name: item ? item.name : null, imported: !!item, proxy: "none" };
                    if (!item) row.error = "not in the project after import";
                    else if (it.proxy) {
                        if (item.hasProxy() && norm(item.getProxyPath()) === norm(it.proxy)) row.proxy = "already";
                        else if (item.hasProxy()) { row.proxy = "different"; row.error = "another proxy is attached: " + item.getProxyPath(); }
                        else if (!item.canProxy()) { row.proxy = "failed"; row.error = "Premiere cannot attach a proxy to this item"; }
                        else {
                            item.attachProxy(new File(it.proxy).fsName, 0);
                            if (item.hasProxy() && norm(item.getProxyPath()) === norm(it.proxy)) row.proxy = "attached";
                            else { row.proxy = "failed"; row.error = "attachProxy did not take"; }
                        }
                    }
                    out.push(row);
                }
            }
            if (a.enableProxies) app.setEnableProxies(1);
            return { project: project(), items: out };
        },
        setSpeed: function (a) {
            requireProject(a);
            var s = findSequence(a.sequence), settings = s.getSettings(), fps = 1 / settings.videoFrameRate.seconds;
            var ti = (a.track || 1) - 1, track = s.videoTracks[ti], report = [], i, j;
            if (!track) throw new Error("no video track V" + (ti + 1));
            function fr(t) { return Math.round(t.seconds * fps); }
            function at(frame) {
                for (var n = 0; n < track.clips.numItems; n++) { var c = track.clips[n]; if (fr(c.start) <= frame && frame < fr(c.end)) return n; }
                return -1;
            }
            app.project.openSequence(s.sequenceID);
            app.enableQE();
            for (i = 0; i < a.clips.length; i++) {
                var want = a.clips[i], frame = want.at;
                if (typeof frame === "string") { var tc = frame.split(/[:;]/), r = Math.round(fps); frame = ((Number(tc[0]) * 60 + Number(tc[1])) * 60 + Number(tc[2])) * r + Number(tc[3]); }
                var n = at(frame);
                if (n < 0) throw new Error("no clip on V" + (ti + 1) + " at " + want.at);
                if (!(want.speed > 0)) throw new Error("speed must be > 0 at frame " + want.at);
                var c = track.clips[n], before = { start: fr(c.start), end: fr(c.end), name: c.name };
                // QE lists gaps too: the n-th clip of the track is the n-th QE item of type Clip
                var qt = qe.project.getActiveSequence().getVideoTrackAt(ti), q = null, seen = 0;
                for (j = 0; j < qt.numItems; j++) { var x = qt.getItemAt(j); if (x && x.type === "Clip") { if (seen === n) q = x; seen++; } }
                if (!q || q.name !== c.name) throw new Error("cannot match " + c.name + " in Premiere's QE track; nothing changed for it");
                var dur = new Time();
                dur.seconds = (before.end - before.start) / fps;
                q.setSpeed(want.speed, dur.getFormatted(settings.videoFrameRate, settings.videoDisplayFormat), false, false, false);
                q.setTimeInterpolationType(INTERP[want.interpolation || "optical-flow"]);
                c = track.clips[n];
                // keep the clip where it was: QE may move its edges
                if (fr(c.start) !== before.start || fr(c.end) !== before.end) {
                    var t = new Time(); t.seconds = before.start / fps; c.start = t;
                    t = new Time(); t.seconds = before.end / fps; c.end = t;
                    c = track.clips[n];
                }
                var after = { start: fr(c.start), end: fr(c.end), speed: c.getSpeed() };
                if (after.start !== before.start || after.end !== before.end || Math.abs(after.speed - want.speed) > 0.001) {
                    throw new Error("speed on " + before.name + " did not apply cleanly (" + stringify({ before: before, after: after }) + "); not saved: press Ctrl+Z in Premiere to undo");
                }
                report.push({ name: before.name, at: frame, start: after.start, end: after.end, speed: after.speed, interpolation: want.interpolation || "optical-flow" });
            }
            return { project: project(), sequence: { name: s.name, id: s.sequenceID }, clips: report };
        },
        status: function () { return { premiere: app.version, project: project(), sequences: app.project ? sequences() : [] }; },
        importXml: function (a) {
            if (!app.project) throw new Error("no project open in Premiere");
            if (a.expectProject && norm(app.project.path) !== norm(a.expectProject)) throw new Error("the open Premiere project changed to " + app.project.path + "; nothing imported");
            if (!new File(a.path).exists) throw new Error("xml not found: " + a.path);
            var before = {}, seqs = app.project.sequences, i;
            for (i = 0; i < seqs.numSequences; i++) before[seqs[i].sequenceID] = true;
            var bin = binNamed(a.bin || "CatCut");
            if (!app.project.importFiles([a.path], true, bin, false)) throw new Error("Premiere refused to import " + a.path);
            var added = [];
            seqs = app.project.sequences;
            for (i = 0; i < seqs.numSequences; i++) if (!before[seqs[i].sequenceID]) added.push({ name: seqs[i].name, id: seqs[i].sequenceID });
            if (added.length === 0) throw new Error("import finished but no new sequence appeared");
            if (a.open !== false) app.project.openSequence(added[0].id);
            return { project: project(), bin: bin.name, sequences: added, opened: a.open !== false ? added[0] : null };
        },
        exportXml: function (a) {
            if (!app.project) throw new Error("no project open in Premiere");
            var s = findSequence(a.sequence);
            if (!s.exportAsFinalCutProXML(a.path, 1)) throw new Error("Premiere could not export " + s.name);
            if (!new File(a.path).exists) throw new Error("Premiere reported success but wrote no file");
            return { project: project(), sequence: { name: s.name, id: s.sequenceID }, path: a.path };
        }
    };
    return function (job) {
        try {
            var fn = actions[job.action];
            if (!fn) throw new Error("unknown action: " + job.action);
            return stringify({ ok: true, data: fn(job.args || {}) });
        } catch (e) {
            return stringify({ ok: false, error: String(e && e.message ? e.message : e) });
        }
    };
})();
