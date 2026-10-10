---
description: สร้างเอฟเฟค/โมชันกราฟิกใหม่ใน AE แบบ headless · Create a new effect or motion graphic
argument-hint: "[สิ่งที่อยากได้ เช่น หัวใจนีออนเต้นตุบๆ 6 วิ]"
---
Use the catcut-editor skill and the CatCut MCP tools.

Make: $ARGUMENTS

1. `project_status`; if no project is open, `project_new` (ask for fps/size only if the request implies something other than 1920×1080 @ 25).
2. Say in 3–5 lines what you will build (look, timing in frames, length). For a quick test, go ahead; otherwise wait for an OK.
3. Write a JSX build script in the project's `ae/` folder and run `ae_create {jsxPath, saveAs: "ae/<name>_v001.aep", asset: {comp, id}}`. Fix script errors from the returned line number.
4. Check 2–3 key frames with `ae_preview_frame` and look at them yourself before going on.
5. `timeline_set` with the asset → `build` → `job_wait` → `review_open`, and give the user the URL plus a contact sheet.
6. Revisions: edit the script, `ae_create` with a new `saveAs` (`_v002`, ...) and the same asset id, then build again.
