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
    function displayStartFrame(c) {
        if (typeof c.displayStartFrame === "number") return c.displayStartFrame;
        return Math.round((c.displayStartTime || 0) * c.frameRate);
    }
    function info(c) {
        return { id: c.id, name: c.name, width: c.width, height: c.height, fps: c.frameRate,
            durationFrames: Math.round(c.duration * c.frameRate), displayStartFrame: displayStartFrame(c), numLayers: c.numLayers };
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
    // Every document-level field any AE version exposes; unreadable ones are skipped by attrs().
    var TEXT_FIELDS = ["text", "font", "fontFamily", "fontStyle", "fontLocation", "fontSize", "fillColor", "strokeColor", "strokeWidth", "strokeOverFill",
        "applyFill", "applyStroke", "justification", "tracking", "leading", "autoLeading", "baselineShift", "horizontalScale", "verticalScale",
        "fauxBold", "fauxItalic", "allCaps", "smallCaps", "superscript", "subscript", "tsume", "baselineLocs", "boxText", "boxTextSize", "boxTextPos",
        "pointText", "lineOrientation", "direction", "composerEngine", "digitSet", "lineJustification", "firstLineIndent", "startIndent", "endIndent",
        "spaceBefore", "spaceAfter", "kerningType", "ligature", "noBreak", "autoHyphenate", "everyLineComposer", "hangingRoman", "paragraphCount"];
    function plain(v) {
        if (v === undefined || v === null) return null;
        if (typeof v !== "object") return v;
        if (v instanceof Array) { var a = []; for (var i = 0; i < v.length; i++) a.push(plain(v[i])); return a; }
        if (v instanceof TextDocument) {
            var text = attrs(v, TEXT_FIELDS);
            if (typeof v.characterRange === "function") {
                text.styles = [];
                for (var j = 0; j < v.text.length; j++) text.styles.push(attrs(v.characterRange(j, j + 1), ["font", "fontSize", "fillColor", "strokeColor", "strokeWidth", "applyFill", "applyStroke", "tracking", "baselineShift", "horizontalScale", "verticalScale", "fauxBold", "fauxItalic"]));
            } else text.opaque = true; // per-character styles are unreadable before characterRange (AE 24.3)
            return text;
        }
        if (v instanceof Shape) return attrs(v, ["vertices", "inTangents", "outTangents", "closed", "featherSegLocs", "featherRelSegLocs", "featherRadii"]);
        if (v instanceof MarkerValue) return attrs(v, ["comment", "chapter", "url", "frameTarget", "cuePointName", "duration", "label", "protectedRegion"]);
        if (v instanceof KeyframeEase) return { speed: v.speed, influence: v.influence };
        // AE enum objects must be serialized as their numeric value.
        return String(v);
    }
    // Frames at which an expression's result is sampled: comp start/end, 8 evenly spaced, every keyframe (capped).
    function sampleFrames(p, comp) {
        var last = Math.max(0, Math.round(comp.duration * comp.frameRate) - 1), seen = {}, frames = [], i;
        function add(n) { n = Math.max(0, Math.min(last, Math.round(n))); if (!seen[n]) { seen[n] = true; frames.push(n); } }
        add(0); add(last);
        for (i = 1; i <= 8; i++) add(last * i / 9);
        for (i = 1; i <= (p.numKeys || 0) && frames.length < 64; i++) add(p.keyTime(i) * comp.frameRate);
        frames.sort(function (a, b) { return a - b; });
        return frames;
    }
    function property(p, comp) {
        var r = { name: p.name, matchName: p.matchName };
        if (p.propertyType !== PropertyType.PROPERTY) {
            r.enabled = p.enabled;
            r.children = [];
            for (var i = 1; i <= p.numProperties; i++) r.children.push(property(p.property(i), comp));
        } else {
            r.expression = p.canSetExpression ? p.expression : "";
            r.expressionEnabled = p.canSetExpression ? p.expressionEnabled : false;
            if (r.expressionEnabled) {
                // Text + evaluated results instead of the whole .aep: catches what the expression reads
                // (other comps, controls) at the sampled frames without re-rendering on every save.
                r.usesExpression = true;
                try { r.expressionError = p.expressionError; } catch (e0) {}
                if (p.propertyValueType === PropertyValueType.CUSTOM_VALUE) r.opaque = true;
                else if (p.propertyValueType !== PropertyValueType.NO_VALUE) {
                    r.samples = [];
                    var frames = sampleFrames(p, comp);
                    for (var s = 0; s < frames.length; s++) {
                        try { r.samples.push({ f: frames[s], v: plain(p.valueAtTime(frames[s] / comp.frameRate, false)) }); }
                        catch (e1) { r.samples.push({ f: frames[s], error: String(e1) }); }
                    }
                }
            }
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
                // Curves/Levels data has no scripting API. The effect matchName, its readable siblings and the
                // layer state are still hashed; the comp is flagged opaque so callers can offer a forced re-render.
                r.opaque = true;
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
    function hasFlag(v, flag) {
        if (!v || typeof v !== "object") return false;
        if (v[flag] === true) return true;
        for (var k in v) if (v.hasOwnProperty(k) && hasFlag(v[k], flag)) return true;
        return false;
    }
    function fullSnapshot(c) {
        var data = snapshot(c, {});
        data.opaque = hasFlag(data, "opaque");
        // Expressions may read any footage (e.g. JSON data files): hash every project source file.
        if (hasFlag(data, "usesExpression")) {
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
        meta.settings = attrs(c, ["bgColor", "pixelAspect", "displayStartTime", "displayStartFrame", "workAreaStart", "workAreaDuration", "shutterAngle", "shutterPhase", "motionBlur", "motionBlurSamplesPerFrame", "motionBlurAdaptiveSampleLimit", "frameBlending", "preserveNestedFrameRate", "preserveNestedResolution", "renderer"]);
        meta.project = attrs(app.project, ["bitsPerChannel", "workingSpace", "linearizeWorkingSpace", "linearBlending", "framesCountType", "timeDisplayType"]);
        meta.layers = [];
        for (var i = 1; i <= c.numLayers; i++) {
            var l = c.layer(i);
            var layer = attrs(l, ["name", "enabled", "audioEnabled", "solo", "shy", "startTime", "inPoint", "outPoint", "stretch", "blendingMode", "threeDLayer", "adjustmentLayer", "guideLayer", "collapseTransformation", "motionBlur", "frameBlendingType", "quality", "samplingQuality", "trackMatteType", "preserveTransparency"]);
            layer.parent = l.parent ? l.parent.index : null;
            layer.matte = l.trackMatteLayer ? l.trackMatteLayer.index : null;
            layer.properties = [];
            for (var j = 1; j <= l.numProperties; j++) layer.properties.push(property(l.property(j), c));
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
    function layerKind(l) {
        if (l instanceof TextLayer) return "text";
        if (l instanceof ShapeLayer) return "shape";
        if (l instanceof CameraLayer) return "camera";
        if (l instanceof LightLayer) return "light";
        if (l.nullLayer) return "null";
        if (l.adjustmentLayer) return "adjustment";
        if (l.source instanceof CompItem) return "precomp";
        if (l.source && l.source.mainSource instanceof SolidSource) return "solid";
        if (l.source) return "footage";
        return "other";
    }
    function detail(c, frame) {
        var r = info(c); r.layers = [];
        for (var i = 1; i <= c.numLayers; i++) {
            var l = c.layer(i), kind = layerKind(l), text = null, source = null, effects = [];
            if (kind === "text") text = l.property("ADBE Text Properties").property("ADBE Text Document").valueAtTime(frame / c.frameRate, false).text;
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

    // ---------- analysis: scanTemplate / lintComp / listFonts (read-only, advisory) ----------
    var THAI = /[\u0E00-\u0E7F]/;
    // Expressions that keep a property changing over time (the layer never "stops moving").
    var MOVING_EXPR = /\btime\b|loopOut|loopIn|wiggle|random|noise|valueAtTime/;
    // Names that suggest a slot meant to be replaced (English plus common Thai words for insert/replace/image/video/logo).
    var REPLACEABLE = /placeholder|replace|drop|insert|your|media|image|photo|picture|video|footage|logo|screen|\u0E43\u0E2A\u0E48|\u0E41\u0E17\u0E19|\u0E23\u0E39\u0E1B|\u0E20\u0E32\u0E1E|\u0E27\u0E34\u0E14\u0E35\u0E42\u0E2D|\u0E42\u0E25\u0E42\u0E01\u0E49/i;
    // Text Range Selector > Advanced > Based On (popup values are 1-based).
    var BASED_ON = { 1: "characters", 2: "characters", 3: "words", 4: "lines" };
    function prop(l, a, b) {
        try { var g = l.property(a); return b ? (g ? g.property(b) : null) : g; } catch (e) { return null; }
    }
    function valueAt(p, t) { try { return p ? p.valueAtTime(t, false) : null; } catch (e) { return null; } }
    // visit(p, path, isLeaf); returning false from a group visit skips its children.
    function walk(group, path, visit, depth) {
        var n = 0, i, p, here;
        if (!group || depth > 12) return;
        try { n = group.numProperties || 0; } catch (e) { return; }
        for (i = 1; i <= n; i++) {
            p = null;
            try { p = group.property(i); } catch (e1) {}
            if (!p) continue;
            here = path.concat([p.name]);
            if (p.propertyType === PropertyType.PROPERTY) visit(p, here, true);
            else if (visit(p, here, false) !== false) walk(p, here, visit, depth + 1);
        }
    }
    function hasExpression(p) { try { return !!(p.canSetExpression && p.expressionEnabled); } catch (e) { return false; } }
    function matted(l) {
        try { if (l.hasTrackMatte === true) return true; } catch (e) {}
        try { if (typeof TrackMatteType !== "undefined" && l.trackMatteType !== undefined && l.trackMatteType !== TrackMatteType.NO_TRACK_MATTE) return true; } catch (e1) {}
        return false;
    }
    function isMatteLayer(l) { try { return l.isTrackMatte === true; } catch (e) { return false; } }
    function matteName(l, c, i) {
        try { if (l.trackMatteLayer) return l.trackMatteLayer.name; } catch (e) {}
        return i > 1 ? c.layer(i - 1).name : null; // legacy mattes are the layer above
    }
    // Layers whose pixels can reach the frame (track mattes count even though they are switched off).
    function visual(l) {
        var k = layerKind(l);
        if (k === "null" || k === "camera" || k === "light" || k === "adjustment") return false;
        try { if (l.guideLayer || l.hasVideo === false) return false; } catch (e) {}
        return l.enabled || isMatteLayer(l);
    }
    function animated(group) {
        var hit = false;
        walk(group, [], function (p, path, leaf) { if (leaf && !hit && p.matchName !== "ADBE Opacity" && (p.numKeys > 0 || hasExpression(p))) hit = true; }, 0);
        return hit;
    }
    function isVideo(l) {
        try {
            var s = l.source;
            return !!(s && !(s instanceof CompItem) && s.mainSource && !(s.mainSource instanceof SolidSource) && !s.mainSource.isStill && s.hasVideo);
        } catch (e) { return false; }
    }
    // Last change of a layer's own properties (seconds, comp time); Infinity when an expression keeps it moving.
    function ownMotion(group, last) {
        var moving = false;
        walk(group, [], function (p, path, leaf) {
            if (!leaf) return p.matchName !== "ADBE Audio Group";
            if (moving || p.matchName === "ADBE Marker") return;
            if (hasExpression(p) && MOVING_EXPR.test(p.expression)) { moving = true; return; }
            if (p.numKeys > 0) { var t = p.keyTime(p.numKeys); if (t > last) last = t; }
        }, 0);
        return moving ? Infinity : last;
    }
    function lastMotion(l, depth) {
        if (isVideo(l)) return Infinity;
        var last = ownMotion(l, -1), up;
        if (last === Infinity) return last;
        if (depth < 4 && l.source instanceof CompItem && !l.timeRemapEnabled) {
            var inner = compMotion(l.source, depth + 1);
            if (inner === Infinity) return Infinity;
            if (inner >= 0) last = Math.max(last, l.startTime + inner * (l.stretch || 100) / 100);
        }
        // A parent's transform moves this layer too.
        for (up = l.parent; up && depth < 8; up = up.parent, depth++) last = Math.max(last, ownMotion(prop(up, "ADBE Transform Group"), -1));
        return last;
    }
    function compMotion(c, depth) {
        var last = -1, i, l, m;
        for (i = 1; i <= c.numLayers; i++) {
            l = c.layer(i);
            if (!visual(l)) continue;
            m = lastMotion(l, depth);
            if (m === Infinity) return Infinity;
            m = Math.min(m, l.outPoint);
            if (m > last) last = m;
        }
        return last;
    }
    // Comp-space box (normalized 0..1) and frame coverage. Ignores rotation, parenting and 3D.
    function bounds(l, c, t) {
        var r = null;
        try { r = l.sourceRectAtTime(t, false); } catch (e) {}
        try { if ((!r || !(r.width > 0)) && l.source && l.source.width) r = { left: 0, top: 0, width: l.source.width, height: l.source.height }; } catch (e1) {}
        if (!r || !(r.width > 0) || !(r.height > 0)) return null;
        var pos = valueAt(prop(l, "ADBE Transform Group", "ADBE Position"), t) || [c.width / 2, c.height / 2];
        var sc = valueAt(prop(l, "ADBE Transform Group", "ADBE Scale"), t) || [100, 100];
        var ap = valueAt(prop(l, "ADBE Transform Group", "ADBE Anchor Point"), t) || [0, 0];
        var xa = pos[0] + (r.left - ap[0]) * sc[0] / 100, xb = xa + r.width * sc[0] / 100;
        var ya = pos[1] + (r.top - ap[1]) * sc[1] / 100, yb = ya + r.height * sc[1] / 100;
        var x0 = Math.min(xa, xb), x1 = Math.max(xa, xb), y0 = Math.min(ya, yb), y1 = Math.max(ya, yb);
        var ix = Math.max(0, Math.min(x1, c.width) - Math.max(x0, 0)), iy = Math.max(0, Math.min(y1, c.height) - Math.max(y0, 0));
        return { x: x0 / c.width, y: y0 / c.height, w: (x1 - x0) / c.width, h: (y1 - y0) / c.height, cover: ix * iy / (c.width * c.height) };
    }
    function animators(l) {
        var out = [], group = prop(l, "ADBE Text Properties", "ADBE Text Animators"), i, a, raw;
        if (!group) return out;
        function find(p, path, leaf) { if (leaf && raw === null && p.matchName === "ADBE Text Range Type2") { try { raw = p.value; } catch (e) {} } }
        for (i = 1; i <= group.numProperties; i++) {
            a = group.property(i);
            if (!a || a.enabled === false) continue;
            raw = null;
            walk(a, [], find, 0);
            out.push({ layer: l.name, animator: a.name, basedOn: BASED_ON[raw] || "other", basedOnRaw: raw });
        }
        return out;
    }
    function fontSet() {
        var seen = {}, fams = {}, set = { list: [], families: [] };
        set.add = function (font, family) {
            if (font && !seen["$" + font]) { seen["$" + font] = true; set.list.push(String(font)); }
            if (family && !fams["$" + family]) { fams["$" + family] = true; set.families.push(String(family)); }
        };
        return set;
    }
    // Document fonts, Source Text keyframe fonts and per-character fonts (characterRange, AE 24.3+).
    function textFonts(l, set) {
        var p = prop(l, "ADBE Text Properties", "ADBE Text Document"), docs = [], k, j, d, n;
        if (!p) return;
        try { docs.push(p.valueAtTime(0, true)); } catch (e) {}
        try { for (k = 1; k <= p.numKeys; k++) docs.push(p.keyValue(k)); } catch (e1) {}
        for (k = 0; k < docs.length; k++) {
            d = docs[k];
            if (!d) continue;
            set.add(d.font, d.fontFamily);
            if (typeof d.characterRange === "function") {
                n = Math.min(String(d.text).length, 2000);
                for (j = 0; j < n; j++) { try { set.add(d.characterRange(j, j + 1).font, null); } catch (e2) {} }
            }
        }
    }
    function holdsMedia(c) {
        if (c.numLayers > 3) return false;
        for (var i = 1; i <= c.numLayers; i++) if (layerKind(c.layer(i)) === "footage") return true;
        return false;
    }
    function scanComp(c, warnings) {
        var r = { name: c.name, durationFrames: Math.round(c.duration * c.frameRate), width: c.width, height: c.height,
            placeholders: [], expressionLocked: [], fonts: [], textAnimators: [] };
        var fonts = fontSet(), i, j, l, kind, ph, fx, controls, an;
        function locked(p, path, leaf) { if (leaf && hasExpression(p)) r.expressionLocked.push(l.name + " > " + path.join(" > ")); }
        for (i = 1; i <= c.numLayers; i++) {
            l = c.layer(i); kind = layerKind(l); ph = null;
            if (!isMatteLayer(l)) {
                if (kind === "text") {
                    ph = { layer: l.name, kind: "text" };
                    textFonts(l, fonts);
                    an = animators(l);
                    for (j = 0; j < an.length; j++) r.textAnimators.push({ layer: l.name, animator: an[j].animator, basedOn: an[j].basedOn });
                } else if (kind === "footage" && l.hasVideo !== false) {
                    ph = { layer: l.name, kind: l.source.mainSource && l.source.mainSource.isStill ? "image" : "footage",
                        source: l.source.file ? l.source.file.fsName : l.source.name };
                } else if (kind === "precomp" && (REPLACEABLE.test(l.name) || REPLACEABLE.test(l.source.name) || holdsMedia(l.source))) {
                    ph = { layer: l.name, kind: "precomp", source: l.source.name };
                }
                if (ph) {
                    // Behind a track/luma matte the window does the moving; the clip itself stays still.
                    ph.moving = matted(l) ? animated(prop(l, "ADBE Transform Group")) : true;
                    if (matted(l)) ph.matte = matteName(l, c, i);
                    r.placeholders.push(ph);
                }
            }
            walk(l, [], locked, 0);
            fx = prop(l, "ADBE Effect Parade"); controls = [];
            if (fx) for (j = 1; j <= fx.numProperties; j++) if (/^ADBE .*Control$/.test(fx.property(j).matchName)) controls.push(fx.property(j).name);
            if (controls.length) warnings.push(c.name + ": layer \"" + l.name + "\" holds expression controls (" + controls.join(", ") + "); expression-driven values are set there");
        }
        r.fonts = fonts.list;
        return r;
    }
    function scanProject() {
        var data = { comps: [], warnings: [] }, i, c;
        for (i = 1; i <= app.project.numItems; i++) { c = app.project.item(i); if (c instanceof CompItem) data.comps.push(scanComp(c, data.warnings)); }
        return data;
    }
    function projectFonts() {
        var set = fontSet(), i, j, c, m, data;
        for (i = 1; i <= app.project.numItems; i++) {
            c = app.project.item(i);
            if (c instanceof CompItem) for (j = 1; j <= c.numLayers; j++) if (c.layer(j) instanceof TextLayer) textFonts(c.layer(j), set);
        }
        data = { fonts: set.list, families: set.families, aeMissing: null };
        try {
            m = app.fonts.missingOrSubstitutedFonts; // AE 24+
            if (m) { data.aeMissing = []; for (j = 0; j < m.length; j++) data.aeMissing.push(String(m[j].postScriptName || m[j].familyName || m[j])); }
        } catch (e) {}
        return data;
    }
    function lintText(l, c, t, rules, issues) {
        var doc = valueAt(prop(l, "ADBE Text Properties", "ADBE Text Document"), t), an, j, sc, pct, b, m, min;
        if (!doc) return;
        if (THAI.test(String(doc.text))) {
            an = animators(l);
            for (j = 0; j < an.length; j++) {
                if (an[j].basedOn !== "characters" && an[j].basedOn !== "words") continue;
                issues.push({ kind: "thai-animator", layer: l.name, basedOn: an[j].basedOn,
                    message: "\"" + l.name + "\": animator \"" + an[j].animator + "\" is based on " + an[j].basedOn + "; Thai clusters may split (lines animate safely) / animator \u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E44\u0E17\u0E22\u0E41\u0E1A\u0E1A" + (an[j].basedOn === "words" ? "\u0E23\u0E32\u0E22\u0E04\u0E33" : "\u0E23\u0E32\u0E22\u0E15\u0E31\u0E27\u0E2D\u0E31\u0E01\u0E29\u0E23") + " \u0E2D\u0E32\u0E08\u0E17\u0E33\u0E2A\u0E23\u0E30/\u0E27\u0E23\u0E23\u0E13\u0E22\u0E38\u0E01\u0E15\u0E4C\u0E41\u0E15\u0E01" });
            }
            min = rules && rules.thai ? rules.thai.minCapHeightPct : undefined;
            if (min > 0 && doc.fontSize > 0) {
                sc = valueAt(prop(l, "ADBE Transform Group", "ADBE Scale"), t) || [100, 100];
                pct = doc.fontSize * Math.abs(sc[1]) / 100 / c.height * 100;
                if (pct < min) issues.push({ kind: "thai-size", layer: l.name, value: Math.round(pct * 100) / 100,
                    message: "\"" + l.name + "\": Thai text size " + (Math.round(pct * 100) / 100) + "% of frame height < project rule " + min + "% / \u0E15\u0E31\u0E27\u0E2D\u0E31\u0E01\u0E29\u0E23\u0E44\u0E17\u0E22\u0E40\u0E25\u0E47\u0E01\u0E01\u0E27\u0E48\u0E32\u0E01\u0E0E\u0E02\u0E2D\u0E07\u0E42\u0E1B\u0E23\u0E40\u0E08\u0E01\u0E15\u0E4C" });
            }
        }
        m = rules ? rules.safeMarginPct : undefined;
        if (m > 0) {
            b = bounds(l, c, t); m = m / 100;
            if (b && (b.x < m || b.y < m || b.x + b.w > 1 - m || b.y + b.h > 1 - m))
                issues.push({ kind: "style", rule: "safeMarginPct", layer: l.name, message: "\"" + l.name + "\": text crosses the " + rules.safeMarginPct + "% safe margin / \u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E25\u0E49\u0E33\u0E02\u0E2D\u0E1A safe margin" });
        }
    }
    function lintCorners(l, want, issues) {
        walk(prop(l, "ADBE Root Vectors Group"), [], function (p, path, leaf) {
            if (leaf || p.matchName !== "ADBE Vector Shape - Rect") return;
            var size, round, side, pct;
            try { size = p.property("ADBE Vector Rect Size").value; round = p.property("ADBE Vector Rect Roundness").value; } catch (e) { return; }
            side = Math.min(Math.abs(size[0]), Math.abs(size[1]));
            if (!(side > 0)) return;
            pct = Math.round(Math.min(round, side / 2) / side * 1000) / 10;
            if (Math.abs(pct - want) > 1) issues.push({ kind: "style", rule: "cornerRadiusPct", layer: l.name, value: pct,
                message: "\"" + l.name + " > " + path.join(" > ") + "\": corner radius " + pct + "% of the short side, project rule " + want + "% / \u0E04\u0E27\u0E32\u0E21\u0E21\u0E19\u0E02\u0E2D\u0E07\u0E21\u0E38\u0E21\u0E44\u0E21\u0E48\u0E15\u0E23\u0E07\u0E01\u0E0E" });
        }, 0);
    }
    function lint(c, rules) {
        var issues = [], fps = c.frameRate, end = Math.round(c.duration * fps), bottom = 0, i, l, inF, outF, m, mf, b, t;
        for (i = c.numLayers; i >= 1 && !bottom; i--) { l = c.layer(i); if (visual(l) && l.enabled && !isMatteLayer(l)) bottom = i; }
        for (i = 1; i <= c.numLayers; i++) {
            l = c.layer(i);
            if (!visual(l)) continue;
            inF = Math.round(l.inPoint * fps); outF = Math.round(l.outPoint * fps);
            if (inF >= end || outF <= 0) continue;
            t = Math.max(l.inPoint, 0);
            if (outF >= end) {
                m = lastMotion(l, 0);
                if (m !== Infinity && m >= 0) {
                    mf = Math.round(m * fps);
                    if (mf > inF && mf < end - Math.round(fps))
                        issues.push({ kind: "animation-ends-early", layer: l.name, frame: mf, endFrame: end,
                            message: "\"" + l.name + "\": last keyframe at frame " + mf + " but the layer stays visible to frame " + end + " (stops moving) / \u0E41\u0E2D\u0E19\u0E34\u0E40\u0E21\u0E0A\u0E31\u0E19\u0E2B\u0E22\u0E38\u0E14\u0E01\u0E48\u0E2D\u0E19 comp \u0E08\u0E1A" });
                }
            } else if (l.enabled && !isMatteLayer(l)) {
                b = bounds(l, c, t);
                if (b && b.cover > 0.9)
                    issues.push({ kind: "background-ends-early", layer: l.name, frame: outF, endFrame: end,
                        message: "\"" + l.name + "\" covers " + Math.round(b.cover * 100) + "% of the frame and ends at frame " + outF + " before comp end " + end + " / \u0E1E\u0E37\u0E49\u0E19\u0E2B\u0E25\u0E31\u0E07\u0E2B\u0E21\u0E14\u0E01\u0E48\u0E2D\u0E19 comp \u0E08\u0E1A" });
                else if (i === bottom)
                    issues.push({ kind: "layer-ends-early", layer: l.name, frame: outF, endFrame: end,
                        message: "bottom layer \"" + l.name + "\" ends at frame " + outF + " before comp end " + end + " / layer \u0E25\u0E48\u0E32\u0E07\u0E2A\u0E38\u0E14\u0E2B\u0E21\u0E14\u0E01\u0E48\u0E2D\u0E19 comp \u0E08\u0E1A" });
            }
            if (l instanceof TextLayer) lintText(l, c, t, rules, issues);
            if (rules && rules.cornerRadiusPct > 0 && l instanceof ShapeLayer) lintCorners(l, rules.cornerRadiusPct, issues);
        }
        return { comp: c.name, issues: issues };
    }

    var job, result = { ok: false, data: null, log: [] };
    // When the job itself is unreadable, report next to it (<job>.result.json) so the caller still gets an error.
    var resultPath = String(EDITMCP_JOB).replace(/\.json$/i, "") + ".result.json";
    try { app.beginSuppressDialogs(); app.saveProjectOnCrash = false; } catch (e0) {}
    try {
        job = read(EDITMCP_JOB);
        if (job.result) resultPath = job.result;
        if (job.action === "version") result.data = app.version;
        else if (job.action === "create") {
            // Build a new project from a script. -noui already starts with an empty project and
            // app.newProject() kills the headless session, so the script runs in that one.
            if (app.project && app.project.numItems > 0) throw new Error("expected an empty project");
            var SCRIPT_DIR = job.scriptDir || "", createLog = result.log;
            var L = function (s) { createLog.push(String(s)); };
            eval(job.jsx);
            app.project.save(new File(job.saveAs));
            result.data = [];
            for (var ci = 1; ci <= app.project.numItems; ci++) if (app.project.item(ci) instanceof CompItem) result.data.push(info(app.project.item(ci)));
        } else if (job.action === "purge") {
            // Needs no project. Verify on each AE version that ALL_CACHES also empties the disk cache folder.
            app.purge(PurgeTarget.ALL_CACHES);
            result.data = { purged: "ALL_CACHES" };
        } else {
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
            } else if (job.action === "scanTemplate") result.data = scanProject();
            else if (job.action === "listFonts") result.data = projectFonts();
            else {
                c = findComp(job.comp);
                if (job.action === "lintComp") result.data = lint(c, job.rules || null);
                else {
                    if (job.action === "edit") { edit(c, job.ops, result.log); app.project.save(aep); }
                    else if (job.action !== "inspect") throw new Error("unknown action: " + job.action);
                    result.data = detail(c, job.atFrame || 0);
                }
            }
        }
        result.ok = true; app.exitCode = 0;
    } catch (e) { result.error = String(e) + " (line " + e.line + ")"; app.exitCode = 1; }
    finally {
        try { write(resultPath, result); } catch (e2) { app.exitCode = 1; }
        try { if (app.project) app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); } catch (e3) {}
        try { app.endSuppressDialogs(false); } catch (e4) {}
        app.quit();
    }
})();
