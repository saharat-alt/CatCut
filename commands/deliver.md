---
description: ส่งงาน (YouTube, Facebook, แนวตั้ง, ทีวี, Master) หรือ XML ไป Premiere · Deliverables or Premiere XML
argument-hint: "[yt fb vert th_tv th_prores led m422hq | premiere | filmcraft]"
---
Use the CatCut MCP tools.

Targets: $ARGUMENTS
- If the user asks for Premiere: `export_premiere_xml` and give the path; mention any export warnings (ramps, optical flow).
- If the user wants the cut opened in Premiere and `premiere_status` is connected: `premiere_push {project: <the open .prproj from premiere_status>}` (confirm the project name with the user first); pulling back later is `premiere_pull`.
- If the user asks for FilmCraft (ArtCraft): `export_premiere_xml {target: "filmcraft"}` and give the path (open with File > Import in FilmCraft).
- Otherwise run `qc_report`, then show the **Export** card (skill: Setup and export cards) with targets from $ARGUMENTS or the project's targets pre-checked and the QC issues listed. Then `deliver` with the chosen targets → `job_wait`, and show the **Done** card with each file path, codec and loudness.
