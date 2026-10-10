---
description: ตรวจงานเทียบบอร์ด + หาเฟรมหลุด/กระตุก · Board vs cut, flash frames, stutter, rules
argument-hint: "[version]"
---
Use the CatCut MCP tools. Everything here is advisory; the brief decides.

For version $ARGUMENTS (default: latest):
1. `board_vs_cut` (if a board exists) → missing/extra slots, drift per chapter, link to the HTML report.
2. `timeline_lint` → flash frames, clips crossing source cuts, repeated source ranges, near-static shots.
3. `comp_lint` → animations that stop early, backgrounds ending early.
4. `rules_check` → project rules, plus the visual checklist.
5. `qc_report` → black/freeze/silence/loudness.
Summarise as one short table sorted by severity with timecodes, then suggest fixes.
