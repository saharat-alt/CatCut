// Smoke test for headless AE: AfterFX.exe -noui -r noui_smoke.jsx
// Writes results to D:/EDITMCP/tests/out/noui_smoke.json. Touches nothing outside D:/EDITMCP.
(function () {
    var OUT = "D:/EDITMCP/tests/out/";
    new Folder(OUT).create();
    var results = [];
    function step(name, fn) {
        var t0 = new Date().getTime();
        try {
            var v = fn();
            results.push({ step: name, ok: true, ms: new Date().getTime() - t0, value: v === undefined ? null : String(v) });
        } catch (e) {
            results.push({ step: name, ok: false, ms: new Date().getTime() - t0, error: e.toString() + " (line " + e.line + ")" });
        }
    }
    function write(name, text) {
        var f = new File(OUT + name);
        f.encoding = "UTF-8";
        f.open("w"); f.write(text); f.close();
    }

    app.beginSuppressDialogs();
    var comp, txt;
    step("version", function () { return app.version + " build " + app.buildName; });
    step("newProject", function () { app.newProject(); return app.project.numItems; });
    step("addComp", function () { comp = app.project.items.addComp("Smoke", 1920, 1080, 1, 5, 25); return comp.id; });
    step("addSolid", function () { return comp.layers.addSolid([0.1, 0.2, 0.6], "BG", 1920, 1080, 1).name; });
    step("addText", function () {
        txt = comp.layers.addText("ทดสอบ Headless AE");
        var doc = txt.property("Source Text").value;
        doc.fontSize = 96; doc.fillColor = [1, 1, 1];
        txt.property("Source Text").setValue(doc);
        return txt.property("Source Text").value.text;
    });
    step("keyframes", function () {
        var op = txt.property("Transform").property("Opacity");
        op.setValueAtTime(0, 0); op.setValueAtTime(1, 100);
        return op.numKeys;
    });
    step("expression", function () {
        var p = txt.property("Transform").property("Position");
        p.expression = "wiggle(2, 20)";
        return p.expressionEnabled + " err=" + p.expressionError;
    });
    step("effect", function () { return txt.property("Effects").addProperty("ADBE Gaussian Blur 2").name; });
    step("saveAep", function () { app.project.save(new File(OUT + "smoke.aep")); return app.project.file.fsName; });
    step("saveFrameToPng", function () {
        var f = new File(OUT + "smoke_frame.png");
        if (f.exists) f.remove();
        comp.saveFrameToPng(2, f);
        for (var i = 0; i < 100 && !f.exists; i++) $.sleep(100); // async
        return f.exists ? f.length + " bytes" : "not written after 10s";
    });
    step("renderQueue", function () {
        var rq = app.project.renderQueue.items.add(comp);
        rq.outputModule(1).file = new File(OUT + "smoke_rq.mp4");
        return "templates=" + rq.outputModule(1).templates.join("|");
    });
    step("saveAepWithRQ", function () { app.project.save(); return "ok"; });
    app.endSuppressDialogs(false);

    var json = "[\n" + (function () {
        var lines = [];
        for (var i = 0; i < results.length; i++) lines.push("  " + results[i].toSource());
        return lines.join(",\n");
    })() + "\n]";
    write("noui_smoke.json", json);
    app.quit();
})();
