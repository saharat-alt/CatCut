// EffectCraft runner: `effectcraft-cli script launch.jsx [project.ecproj]`, where launch.jsx is
// `var CATCUT_JOB = {...};` followed by this file (EffectCraft has no #include / $.evalFile).
// Same After Effects object model as runner.jsx; EffectCraft resolves match names, not display
// names, so every property path here is a match-name path. Prints one "@@CATCUT@@{json}" line.
(function () {
    var job = CATCUT_JOB, result = { ok: false, data: null, log: [] };
    function findComp(name) {
        var found = null;
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof CompItem && it.name === name) {
                if (found) throw new Error("ambiguous comp name: " + name);
                found = it;
            }
        }
        if (!found) throw new Error("comp not found: " + name);
        return found;
    }
    function info(c) {
        return { id: c.id, name: c.name, width: c.width, height: c.height, fps: c.frameRate, durationFrames: Math.round(c.duration * c.frameRate), numLayers: c.numLayers };
    }
    function layerKind(l) {
        if (typeof TextLayer !== "undefined" && l instanceof TextLayer) return "text";
        if (typeof ShapeLayer !== "undefined" && l instanceof ShapeLayer) return "shape";
        if (typeof CameraLayer !== "undefined" && l instanceof CameraLayer) return "camera";
        if (typeof LightLayer !== "undefined" && l instanceof LightLayer) return "light";
        if (l.nullLayer) return "null";
        if (l.adjustmentLayer) return "adjustment";
        if (l.source instanceof CompItem) return "precomp";
        if (l.source && l.source.typeName === "Solid") return "solid";
        if (l.source) return "footage";
        return "other";
    }
    function textOf(l, t) {
        var v = l.property("ADBE Text Properties").property("ADBE Text Document").valueAtTime(t, false);
        return typeof v === "string" ? v : v.text;
    }
    function detail(c, frame) {
        var r = info(c); r.layers = [];
        for (var i = 1; i <= c.numLayers; i++) {
            var l = c.layer(i), kind = layerKind(l), effects = [];
            var fx = l.property("ADBE Effect Parade");
            if (fx) for (var j = 1; j <= fx.numProperties; j++) effects.push(fx.property(j).matchName);
            var layer = { index: i, name: l.name, kind: kind, inFrame: Math.round(l.inPoint * c.frameRate), outFrame: Math.round(l.outPoint * c.frameRate), enabled: l.enabled, effects: effects };
            if (kind === "text") layer.text = textOf(l, frame / c.frameRate);
            if (l.source) layer.source = l.source.file ? l.source.file.fsName : l.source.name;
            r.layers.push(layer);
        }
        return r;
    }
    function getProperty(layer, path) {
        var names = path.split("."), p = layer;
        for (var i = 0; i < names.length; i++) { p = p.property(names[i]); if (!p) throw new Error("property not found: " + path + " (EffectCraft needs match names, e.g. ADBE Transform Group.ADBE Position)"); }
        return p;
    }
    function edit(comp, ops, log) {
        for (var i = 0; i < ops.length; i++) {
            var op = ops[i], l = null, p, doc, effect, name, j;
            if (op.layer !== undefined) {
                l = comp.layer(op.layer);
                if (!l) throw new Error("layer not found: " + op.layer);
            }
            switch (op.op) {
            case "setText":
                p = getProperty(l, "ADBE Text Properties.ADBE Text Document"); doc = p.value;
                // a text layer that was never styled reports its value as a plain string
                if (typeof doc === "string") doc = new TextDocument(op.text);
                doc.text = op.text;
                if (op.fontSize !== undefined) doc.fontSize = op.fontSize;
                if (op.font !== undefined) doc.font = op.font;
                if (op.color !== undefined) { doc.fillColor = op.color; doc.applyFill = true; }
                p.setValue(doc); break;
            case "replaceFootage":
                var file = new File(op.path);
                if (!file.exists) throw new Error("footage not found: " + op.path);
                l.replaceSource(app.project.importFile(new ImportOptions(file)), false); break;
            case "shiftLayer": l.startTime += op.frames / comp.frameRate; break;
            case "setProperty":
                p = getProperty(l, op.property);
                if (op.atFrame !== undefined) p.setValueAtTime(op.atFrame / comp.frameRate, op.value);
                else p.setValue(op.value);
                break;
            case "addEffect":
                effect = l.property("ADBE Effect Parade").addProperty(op.matchName);
                if (!effect) throw new Error("effect unavailable: " + op.matchName);
                if (op.properties) for (name in op.properties) if (op.properties.hasOwnProperty(name)) getProperty(effect, name).setValue(op.properties[name]);
                break;
            case "applyPreset": throw new Error("applyPreset (.ffx) is After Effects only; EffectCraft uses .ecpreset");
            case "setLayerEnabled": l.enabled = op.enabled; break;
            case "duplicateComp":
                for (j = 1; j <= app.project.numItems; j++) if (app.project.item(j).name === op.newName) throw new Error("item already exists: " + op.newName);
                var duplicate = comp.duplicate(); duplicate.name = op.newName; break;
            case "script": eval(op.jsx); break;
            default: throw new Error("unknown operation: " + op.op);
            }
            log.push(op.op);
        }
    }
    try {
        if (job.action === "create") {
            if (app.project.numItems > 0) throw new Error("expected an empty project");
            var SCRIPT_DIR = job.scriptDir || "", createLog = result.log;
            var L = function (s) { createLog.push(String(s)); };
            eval(job.jsx);
            result.data = [];
            for (var ci = 1; ci <= app.project.numItems; ci++) if (app.project.item(ci) instanceof CompItem) result.data.push(info(app.project.item(ci)));
        } else {
            var c = findComp(job.comp);
            if (job.action === "edit") edit(c, job.ops, result.log);
            else if (job.action !== "inspect") throw new Error("unknown action: " + job.action);
            result.data = detail(c, job.atFrame || 0);
        }
        result.ok = true;
    } catch (e) {
        result.error = String(e) + (e && e.lineNumber ? " (line " + e.lineNumber + ")" : "");
    }
    writeLn("@@CATCUT@@" + JSON.stringify(result));
})();
