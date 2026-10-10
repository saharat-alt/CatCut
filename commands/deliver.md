---
description: ส่งงาน (YouTube, Facebook, แนวตั้ง, ทีวี, Master) หรือ XML ไป Premiere · Deliverables or Premiere XML
argument-hint: "[yt fb vert th_tv th_prores led m422hq | premiere]"
---
Use the CatCut MCP tools.

Targets: $ARGUMENTS
- If the user asks for Premiere: `export_premiere_xml` and give the path; mention any export warnings (ramps, optical flow).
- Otherwise run `qc_report`, then show the **Export** card (skill: Setup and export cards) with targets from $ARGUMENTS or the project's targets pre-checked and the QC issues listed. Then `deliver` with the chosen targets → `job_wait`, and show the **Done** card with each file path, codec and loudness.
