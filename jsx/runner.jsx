// ES3 ExtendScript. A fresh -m -noui instance reads a UTF-8 job; it never touches the user's GUI.
(function () {
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
    function parse(s) {
        s = s.replace(/^\uFEFF/, "");
        if (typeof JSON !== "undefined" && JSON.parse) return JSON.parse(s);
        // JSON2's validation prevents job data from becoming executable ExtendScript.
        if (!/^[\],:{}\s]*$/.test(s.replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, "@")
            .replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, "]")
            .replace(/(?:^|:|,)(?:\s*\[)+/g, ""))) throw new Error("invalid JSON job");
        return eval("(" + s + ")");
    }
    function read(path) {
        var f = new File(path); f.encoding = "UTF-8";
        if (!f.open("r")) throw new Error("cannot read " + path);
        var s = f.read(); f.close(); return parse(s);
    }
    function write(path, data) {
        var f = new File(path); f.encoding = "UTF-8";
        if (!f.open("w")) throw new Error("cannot write " + path);
        f.write(stringify(data)); f.close();
    }
    function info(c) {
        return { id: c.id, name: c.name, width: c.width, height: c.height, fps: c.frameRate,
            durationFrames: Math.round(c.duration * c.frameRate), numLayers: c.numLayers };
    }
    function findComp(name) {
        var found = null;
        for (var i = 1; i <= app.project.numItems; i++) {
            var c = app.project.item(i);
            if (c instanceof CompItem && c.name === name) {
                if (found) throw new Error("ambiguous comp name: " + name);
                found = c;
            }
        }
        if (!found) throw new Error("comp not found: " + name);
        return found;
    }
    function attrs(obj, names) {
        var out = {};
        for (var i = 0; i < names.length; i++) try { out[names[i]] = plain(obj[names[i]]); } catch (e) {}
        return out;
    }
    function plain(v) {
        if (v === undefined || v === null) return null;
        if (typeof v !== "object") return v;
        if (v instanceof Array) { var a = []; for (var i = 0; i < v.length; i++) a.push(plain(v[i])); return a; }
        if (v instanceof TextDocument) {
            var text = attrs(v, ["text", "font", "fontSize", "fillColor", "strokeColor", "strokeWidth", "applyFill", "applyStroke", "justification", "tracking", "leading", "autoLeading", "baselineShift", "horizontalScale", "verticalScale", "fauxBold", "fauxItalic", "allCaps", "smallCaps", "boxText", "boxTextSize"]);
            if (typeof v.characterRange === "function") {
                text.styles = [];
                for (var j = 0; j < v.text.length; j++) text.styles.push(attrs(v.characterRange(j, j + 1), ["font", "fontSize", "fillColor", "strokeColor", "strokeWidth", "applyFill", "applyStroke", "tracking", "baselineShift", "horizontalScale", "verticalScale", "fauxBold", "fauxItalic"]));
            } else text.projectDependency = true;
            return text;
        }
        if (v instanceof Shape) return attrs(v, ["vertices", "inTangents", "outTangents", "closed", "featherSegLocs", "featherRelSegLocs", "featherRadii"]);
        if (v instanceof MarkerValue) return attrs(v, ["comment", "chapter", "url", "frameTarget", "cuePointName", "duration", "label", "protectedRegion"]);
        if (v instanceof KeyframeEase) return { speed: v.speed, influence: v.influence };
        // AE enum objects must be serialized as their numeric value.
        return String(v);
    }
    function property(p) {
        var r = { name: p.name, matchName: p.matchName };
        if (p.propertyType !== PropertyType.PROPERTY) {
            r.enabled = p.enabled;
            r.children = [];
            for (var i = 1; i <= p.numProperties; i++) r.children.push(property(p.property(i)));
        } else {
            r.expression = p.canSetExpression ? p.expression : "";
            r.expressionEnabled = p.canSetExpression ? p.expressionEnabled : false;
            if (r.expressionEnabled) r.projectDependency = true;
            r.keys = [];
            if (p.numKeys) {
                for (var k = 1; k <= p.numKeys; k++) {
                    var key = { time: p.keyTime(k), value: plain(p.keyValue(k)) };
                    if (p.isInterpolationTypeValid(KeyframeInterpolationType.BEZIER)) {
                        key.inType = String(p.keyInInterpolationType(k)); key.outType = String(p.keyOutInterpolationType(k));
                        key.inEase = plain(p.keyInTemporalEase(k)); key.outEase = plain(p.keyOutTemporalEase(k));
                        key.temporalAutoBezier = p.keyTemporalAutoBezier(k); key.temporalContinuous = p.keyTemporalContinuous(k);
                    }
                    if (p.isSpatial) {
                        key.inTangent = plain(p.keyInSpatialTangent(k)); key.outTangent = plain(p.keyOutSpatialTangent(k));
                        key.roving = p.keyRoving(k); key.spatialAutoBezier = p.keySpatialAutoBezier(k); key.spatialContinuous = p.keySpatialContinuous(k);
                    }
                    r.keys.push(key);
                }
            } else if (p.propertyValueType !== PropertyValueType.NO_VALUE && p.propertyValueType !== PropertyValueType.CUSTOM_VALUE) {
                r.value = plain(p.valueAtTime(0, true));
            } else if (p.propertyValueType === PropertyValueType.CUSTOM_VALUE) {
                // Opaque plugin values cannot be inspected safely: changing the project invalidates these comps.
                r.projectDependency = true;
            }
        }
        return r;
    }
    function footage(source, item) {
        var data = attrs(source, ["alphaMode", "premulColor", "invertAlpha", "conformFrameRate", "fieldSeparationType", "highQualityFieldSeparation", "removePulldown", "loop", "color"]);
        var file = source.file || item.file;
        if (file) {
            data.file = file.fsName;
            data.sequence = !source.isStill && /\.(png|jpe?g|tiff?|exr|dpx|tga|bmp)$/i.test(file.fsName);
        }
        return data;
    }
    function projectDependent(v) {
        if (!v || typeof v !== "object") return false;
        if (v.projectDependency) return true;
        for (var k in v) if (v.hasOwnProperty(k) && projectDependent(v[k])) return true;
        return false;
    }
    function fullSnapshot(c) {
        var data = snapshot(c, {});
        if (projectDependent(data)) {
            data.projectMedia = [];
            for (var i = 1; i <= app.project.numItems; i++) {
                var item = app.project.item(i);
                if (item.mainSource) data.projectMedia.push(footage(item.mainSource, item));
                if (item.proxySource) data.projectMedia.push(footage(item.proxySource, item));
            }
        }
        return data;
    }
    function snapshot(c, seen) {
        var meta = info(c);
        if (seen[c.id]) return { ref: c.id };
        seen[c.id] = true;
        meta.settings = attrs(c, ["bgColor", "pixelAspect", "displayStartTime", "shutterAngle", "shutterPhase", "motionBlur", "motionBlurSamplesPerFrame", "motionBlurAdaptiveSampleLimit", "frameBlending", "preserveNestedFrameRate", "preserveNestedResolution", "renderer"]);
        meta.project = attrs(app.project, ["bitsPerChannel", "workingSpace", "linearizeWorkingSpace", "linearBlending"]);
        meta.layers = [];
        for (var i = 1; i <= c.numLayers; i++) {
            var l = c.layer(i);
            var layer = attrs(l, ["name", "enabled", "audioEnabled", "solo", "shy", "startTime", "inPoint", "outPoint", "stretch", "blendingMode", "threeDLayer", "adjustmentLayer", "guideLayer", "collapseTransformation", "motionBlur", "frameBlendingType", "quality", "samplingQuality", "trackMatteType", "preserveTransparency"]);
            layer.parent = l.parent ? l.parent.index : null;
            layer.matte = l.trackMatteLayer ? l.trackMatteLayer.index : null;
            layer.properties = [];
            for (var j = 1; j <= l.numProperties; j++) layer.properties.push(property(l.property(j)));
            if (l.source instanceof CompItem) layer.source = snapshot(l.source, seen);
            else if (l.source) {
                layer.source = attrs(l.source, ["name", "width", "height", "pixelAspect", "duration", "frameRate"]);
                layer.source.interpretation = footage(l.source.mainSource, l.source);
                layer.source.useProxy = l.source.useProxy;
                if (l.source.proxySource) layer.source.proxy = footage(l.source.proxySource, l.source);
            }
            if (l.source instanceof CompItem && l.source.proxySource) { layer.source.proxy = footage(l.source.proxySource, l.source); layer.source.useProxy = l.source.useProxy; }
            meta.layers.push(layer);
        }
        delete seen[c.id];
        return meta;
    }
    function detail(c, frame) {
        var r = info(c); r.layers = [];
        for (var i = 1; i <= c.numLayers; i++) {
            var l = c.layer(i), kind = "other", text = null, source = null, effects = [];
            if (l instanceof TextLayer) { kind = "text"; text = l.property("ADBE Text Properties").property("ADBE Text Document").valueAtTime(frame / c.frameRate, false).text; }
            else if (l instanceof ShapeLayer) kind = "shape";
            else if (l instanceof CameraLayer) kind = "camera";
            else if (l instanceof LightLayer) kind = "light";
            else if (l.nullLayer) kind = "null";
            else if (l.adjustmentLayer) kind = "adjustment";
            else if (l.source instanceof CompItem) kind = "precomp";
            else if (l.source && l.source.mainSource instanceof SolidSource) kind = "solid";
            else if (l.source) kind = "footage";
            if (l.source) source = l.source.file ? l.source.file.fsName : l.source.name;
            var fx = l.property("ADBE Effect Parade");
            if (fx) for (var j = 1; j <= fx.numProperties; j++) effects.push(fx.property(j).matchName);
            var layer = { index: i, name: l.name, kind: kind, inFrame: Math.round(l.inPoint * c.frameRate), outFrame: Math.round(l.outPoint * c.frameRate), enabled: l.enabled, effects: effects };
            if (text !== null) layer.text = text;
            if (source !== null) layer.source = source;
            r.layers.push(layer);
        }
        r.snapshot = fullSnapshot(c); return r;
    }
    function getProperty(layer, path) {
        var names = path.split("."), p = layer;
        for (var i = 0; i < names.length; i++) { p = p.property(names[i]); if (!p) throw new Error("property not found: " + path); }
        return p;
    }
    function edit(comp, ops, log) {
        for (var i = 0; i < ops.length; i++) {
            var op = ops[i], l = null, p, doc, effect, name;
            if (op.layer !== undefined) {
                l = comp.layer(op.layer);
                if (!l) throw new Error("layer not found: " + op.layer);
            }
            switch (op.op) {
            case "setText":
                p = getProperty(l, "ADBE Text Properties.ADBE Text Document"); doc = p.value;
                doc.text = op.text;
                if (op.fontSize !== undefined) doc.fontSize = op.fontSize;
                if (op.font !== undefined) doc.font = op.font;
                if (op.color !== undefined) { doc.fillColor = op.color; doc.applyFill = true; }
                p.setValue(doc); break;
            case "replaceFootage":
                var file = new File(op.path);
                if (!file.exists) throw new Error("footage not found: " + op.path);
                // Import a new source so other layers sharing the old footage stay unchanged.
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
            case "applyPreset":
                file = new File(op.ffxPath); if (!file.exists) throw new Error("preset not found: " + op.ffxPath);
                for (var j = 1; j <= comp.numLayers; j++) comp.layer(j).selected = false;
                l.selected = true; l.applyPreset(file); l.selected = false; break;
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

    var job, result = { ok: false, data: null, log: [] };
    app.beginSuppressDialogs(); app.saveProjectOnCrash = false;
    try {
        job = read(EDITMCP_JOB);
        if (job.action === "version") result.data = app.version;
        else {
            var aep = new File(job.aep);
            if (!aep.exists) throw new Error("project not found: " + job.aep);
            if (app.project) app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
            app.open(aep);
            var i, c;
            if (job.action === "list") {
                result.data = [];
                for (i = 1; i <= app.project.numItems; i++) { c = app.project.item(i); if (c instanceof CompItem) result.data.push(info(c)); }
            } else if (job.action === "fingerprint") {
                result.data = {};
                if (job.comps) for (i = 0; i < job.comps.length; i++) result.data[job.comps[i]] = fullSnapshot(findComp(job.comps[i]));
                else for (i = 1; i <= app.project.numItems; i++) { c = app.project.item(i); if (c instanceof CompItem) { if (result.data[c.name]) throw new Error("ambiguous comp name: " + c.name); result.data[c.name] = fullSnapshot(c); } }
            } else {
                c = findComp(job.comp);
                if (job.action === "edit") { edit(c, job.ops, result.log); app.project.save(aep); }
                else if (job.action !== "inspect") throw new Error("unknown action: " + job.action);
                result.data = detail(c, job.atFrame || 0);
            }
        }
        result.ok = true; app.exitCode = 0;
    } catch (e) { result.error = String(e) + " (line " + e.line + ")"; app.exitCode = 1; }
    finally {
        try { if (job) write(job.result, result); } catch (e) { app.exitCode = 1; }
        if (app.project) app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
        app.endSuppressDialogs(false); app.quit();
    }
})();
