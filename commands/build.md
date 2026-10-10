---
description: build เฉพาะส่วนที่เปลี่ยน แล้วรายงาน QC · Incremental build + QC report
argument-hint: "[force | skip-deliver | ...]"
---
Use the catcut-editor skill and the CatCut MCP tools.

1. `rules_get` and re-read the checklist.
2. `timeline_lint` (run `shots_detect` first for assets that need it) and mention any flash / cut-cross / repeat warnings before building.
3. `build` (pass options from: $ARGUMENTS). Poll `job_status` until done.
4. Report briefly: version, what was re-rendered vs reused, time taken, QC issues (with timecodes), disk warnings. Offer `/catcut:review`.
