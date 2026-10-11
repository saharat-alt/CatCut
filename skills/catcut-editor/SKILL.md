---
name: catcut-editor
description: Edit video with the CatCut MCP (headless After Effects + ffmpeg, FCP7 XML for Premiere). Use when cutting, revising or delivering a CatCut project: brief/board first, project rules re-read before every edit, edit → build → review → fix loop, evidence frames before claiming a fix, incremental builds, ask before paid services.
---

# CatCut editor

CatCut builds video headlessly: AE comps render with aerender, ffmpeg stitches cached ProRes segments into a master, and Premiere gets FCP7 XML. All times are **frames** at the project fps. Nothing is ever overwritten: each build is a new version (`v001`, `v002`, ...).

## The highest rule: the brief decides
- Priority: **brief / board → the user's instructions in this project → general defaults**.
- No style rule applies to every project. Template use, Thai typography, join lengths and similar choices depend on each brief. Advisory tools (template scan, Thai lint, join policy) are information, not law.
- Rules only come from the brief or from the user's explicit words. Record each one with its source and a short quote (`rules_add_constraint`, `rules_set_style`).
- If a rule or request conflicts with the brief, **stop and ask the user**. Pass `overrideBrief` / `userConfirmed` only after they answer.

## Stay inside CatCut
- Every render, encode and version goes through CatCut tools. Do not launch `AfterFX.com` / `aerender` / `ffmpeg` yourself and do not write into the project's `out/` (it belongs to `build`/`deliver`; a stray `out/v001` shifts version numbers). Your own scripts and helper files go in `ae/` or `review/`.
- **New effect / motion graphic from scratch:** write a JSX build script, then `ae_create {jsxPath, saveAs, asset: {comp, id}}`. The script runs in AE's empty startup project: create comps and layers only; never call `app.newProject()` (it kills headless AE), save or quit. `L("msg")` logs, errors come back with the line. For a revision, save the script change, run `ae_create` again with a **new** `saveAs` and the **same** asset id: the asset is repointed and the next `build` re-renders it.
  - **EffectCraft (ArtCraft) instead of AE:** same call with `saveAs: "….ecproj"` (doctor shows `effectcraft: found`). Write property paths with match names (`property("ADBE Transform Group").property("ADBE Position")`) and style text with `new TextDocument(...)`: EffectCraft ignores display names like `property("Position")`, and the same script then also runs in AE. `ae_edit`, `ae_preview_frame`, `ae_inspect_comp` and `build` work on `.ecproj` too; `template_scan`, `comp_lint`, `font_audit` and `applyPreset` stay AE-only.
- Check looks with `ae_preview_frame` (one frame), not full renders.
- Long jobs (`build`, `deliver`, AE jobs that return `pending`): call `job_wait {id}`. Never poll with sleep, `tasklist` or file watching.
- A quick H.264 file to show the user: `preview_range {from, to}` or `deliver`. Do not encode MP4s by hand.
- If a tool fails, report the exact error to the user and fix the cause; do not route around CatCut.

## Setup and export cards
Let the user click instead of typing settings. Use an inline widget when the host has one (for example `show_widget`, where a button calls `sendPrompt` with the choices); otherwise use `AskUserQuestion`. Keep each card to one screen. Prefill what the user already said and the defaults so a single click is enough. Never ask again for what is already decided.
- **New project** (before `project_new`): name, folder, fps (25 · 30 · 24 · 50 · 29.97), frame size (1920×1080 · 1080×1920 · 1080×1080 · 3840×2160), and delivery targets as checkboxes from `delivery_presets`. The button sends one line, e.g. `ตั้งค่า: name=heart-fx fps=30 size=1920x1080 targets=yt,vert`. Then call `project_new {..., targets}`.
- **Export** (before `deliver`): version (latest by default), targets pre-checked from `delivery_presets.projectTargets`, a "Premiere XML" checkbox, and the QC issues of that version (with timecodes) so the user decides with them in view.
- **Done** (after `deliver` / `export_premiere_xml`): one card listing each file (name, size, codec, loudness) as clickable links, plus anything QC flagged.
Cards only collect choices; the actual work still goes through CatCut tools.

## Workflow
1. **Brief/board first.** No brief (a one-off effect or test)? Skip the board; say so in one line. `board_import` the storyboard/brief, then `board_check`. Tie every clip to a board `slot`. If the board contradicts itself, ask before cutting.
2. **Capture rules** the brief or user states: `rules_add_constraint` (checks: `board-only`, `logo-static`, `no-repeat-gimmick` are automatic; `no-cover-photo`, `manual` are checked by eye) and `rules_set_style` (radius, safe margin, palette, joins, thai, maxStaticSec).
3. **Before every edit and every build, call `rules_get`** and re-read the checklist.
4. **Edit**: use `timeline_edit` for small changes, `ae_edit` for existing comps and `ae_create` for new ones. To hand the cut to a human editor in Premiere, use `premiere_push` / `premiere_pull` (CatCut bridge), never screenshots or clicks.
5. **Build** incrementally (`build`). Only changed segments re-render. Never export full deliverables when an incremental build answers the question. Check `disk_report` if space is tight. Build refuses below 5 GB free and warns below 20 GB.
6. **Review**: run `qc_report`, then `rules_check` (machine checks → `style` issues plus a visual checklist). `review_open` returns the URL directly; give it to the user. QC on a clip without audio always reports silence/loudness: say so once, do not repeat it every round.
7. **Fix loop**: address each note, rebuild, and review again until clean.

## Report "fixed" only with evidence
Before saying a fix is done (for example "corners are round everywhere"), call `rules_evidence {assetId | clipIds, version}`. It grabs **one frame per timeline instance** from that version's master into `review/evidence/<version>/` and makes a contact sheet. For review notes pass `offsets` (each note's frame minus the clip start) so the sheet shows exactly the noted spots. Attach every frame. If an instance is missing or still wrong, the fix is not done.

## Review note colours
- red: cut / edit
- yellow: timing
- blue: text / graphic
- green: colour
- purple: audio

## Housekeeping
- `disk_report` shows free space per drive, AE disk cache size, and project `cache/` + `out/` per version.
- `version_keep {version}` protects a version from cleanup.
- `cache_gc_plan` only lists files and deletes nothing. Show the plan to the user. **Only after the user approves**, call `cache_gc_apply {planId, confirm: "ลบ"}` within 10 minutes. It deletes only planned files inside `cache/` and `out/` and logs each one to `history/`.

## Money and the screen
- Before calling any paid external service or connector (generation, stock, upscaling, TTS ...), tell the user it may cost money and ask: "<service> อาจมีค่าใช้จ่าย — ใช้ไหม? / may cost money — OK?".
- Stay headless. Never take over the user's screen or launch Adobe apps with a UI unless they ask.
