---
description: ส่งงาน (YouTube, Facebook, แนวตั้ง, ทีวี, Master) หรือ XML ไป Premiere · Deliverables or Premiere XML
argument-hint: "[yt fb vert th_tv th_prores led m422hq | premiere]"
---
Use the CatCut MCP tools.

Targets: $ARGUMENTS
- If the user asks for Premiere: `export_premiere_xml` and give the path; mention any export warnings (ramps, optical flow).
- Otherwise run `qc_report` first; if there are errors, ask before delivering. Then `deliver` with the targets (default: project delivery targets) and report each file path with codec / loudness.
