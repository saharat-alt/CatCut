// CatCut bridge, ExtendScript side (ES3, Premiere Pro). bridge-core.js calls catcut_dispatch(job)
// and gets a JSON string back. Only these actions exist; nothing here saves, closes or opens a
// project. Paths arrive from CatCut already copied into the bridge's ASCII temp folder.
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
    var actions = {
        ping: function () { return { premiere: app.version, project: project() }; },
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
