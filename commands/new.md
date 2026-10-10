---
description: เริ่มงานใหม่จากบรีฟ/บอร์ด · Start a new CatCut project from a brief or board
argument-hint: "[ชื่องาน] [โฟลเดอร์] [บอร์ด/บรีฟ] [ฟุตเทจ] ..."
---
Use the catcut-editor skill and the CatCut MCP tools.

Start a new CatCut project from what the user gave: $ARGUMENTS

1. Run `doctor`. Show the **New project** card (skill: Setup and export cards) prefilled from $ARGUMENTS, then `project_new {dir, name, fps, width, height, targets}` with the user's choices.
2. If a board/brief file is given: `board_import` it, show the user its version info (title, modified date, newer files in the folder) and ask them to confirm it is the right board before anything else. Read the PDF yourself visually, then `board_set` the corrected board and run `board_check`; ask about contradictions.
3. If a footage folder is given: `scan_footage` it and report problems (mojibake names, pillarbox, odd fps).
4. Record every rule the brief states with `rules_add_constraint` / `rules_set_style` (source: brief, short quote).
5. Propose the cut plan (slot → asset, durations, joins) in a short table and wait for the user's go-ahead before `timeline_set` and `build`.
